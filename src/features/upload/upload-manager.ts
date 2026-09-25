import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { getInfoAsync } from 'expo-file-system/legacy';

import { deleteDestination } from '@/db/destinations';
import {
  burnUploadPairing,
  getDraftName,
  getUploadedDraftIds,
  getUploadingDraftIds,
  markUploaded,
  setUploadDestination,
} from '@/db/drafts';
import { deleteViewLink, getViewLink, setViewLink } from '@/db/secure-token';
import { getDraftTranscriptRow } from '@/db/transcripts';
import { linesToVtt } from '@/features/transcription/vtt';
import { parseTranscriptLines } from '@/features/transcription/whisper';
import { absolutize, toFileUri } from '@/utils/file-store';
import { generateThumbnailFile } from '@/utils/video';

import { buildBeatManifest } from './beat-manifest';
import { expiresAtMs, isTokenExpired } from './capability-token';
import { checkCapabilities } from './capabilities';
import { keepAlive } from './keep-alive';
import {
  cancelOrphanedUploadTasks,
  cleanupStaleUploadTempFiles,
  uploadChunkNative,
} from './native-chunk-upload';
import { uploadNotify } from './notify';
import { type ArtifactKind, cancelTusUpload, TusUploadError, uploadViaTus } from './tus-client';
import type {
  Destination,
  LiveUploadState,
  UploadPhase,
  UploadProgress,
  UploadSession,
} from './types';
import { requestViewLink } from './view-link';

/** Every failure spends the link, so the way to try again is a new one. */
const NEW_LINK = 'scan a new link to try again.';

/** Failures that need more than a new link say so themselves, and are shown as-is. */
const STOPPED_MESSAGE = {
  expired: `Upload link expired — ${NEW_LINK}`,
  'version-too-old':
    'This server needs a newer version of Pulse — update the app, then scan a new link.',
  'version-too-new':
    'This server hasn’t been updated for this version of Pulse yet — scan a new link once it is.',
  'video-missing': 'The video is no longer available — reopen the draft, then scan a new link.',
} as const;

/** Names the step a failure happened in, after the reason. */
const PHASE_NAME: Record<UploadPhase, string> = {
  preparing: 'Preparing',
  captions: 'Captions',
  manifest: 'Beat manifest',
  thumbnail: 'Thumbnail',
  video: 'Video',
};

/** How long to wait for a view link after an upload; the upload has already finished by then. */
const VIEW_LINK_TIMEOUT_MS = 15_000;

/** Where a run writes its captions, beat manifest and generated thumbnail before uploading them. */
const TEMP_DIR_NAME = 'uploads';

/** A failure whose message is the whole toast (see `STOPPED_MESSAGE`). */
class UploadStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadStoppedError';
  }
}

/** Stable idle reference so `useSyncExternalStore`'s `getSnapshot` returns `===` for untouched drafts. */
const IDLE: LiveUploadState = { status: 'idle' };

/**
 * A finished upload's watch link. A read-only view link (protocol 2.2) is `shareable` and kept
 * across restarts until it expires. Without one, the link carries the pairing token, which can
 * also delete the video — so it's only for opening in the user's own browser, held for this
 * session and never offered for copying (a tokenless link carries no secret, and is shareable).
 */
export type WatchLink = {
  url: string;
  /** When it stops working, in ms since the epoch; `null` if unknown (tokenless or opaque). */
  expiresAt: number | null;
  shareable: boolean;
};

/** The uploaded video's link, tokened so it opens without signing in. */
function watchUrlOf(destination: Destination): string {
  const url = `${destination.server}/artifacts/${destination.artifactId}`;
  return destination.token ? `${url}?token=${encodeURIComponent(destination.token)}` : url;
}

/**
 * Integrity digest of a finished file as `md5:<hex>`, computed natively and off
 * the JS thread by the legacy `getInfoAsync`. Two deliberate choices here:
 *
 * - MD5, not SHA-256: pulsevault's checksum hook is at-rest corruption/tampering
 *   detection on the finished artifact (see `createChecksumValidator` server-side),
 *   not a security boundary, and the server verifies `md5` alongside sha256/sha1.
 *   The old SHA-256 path had to copy the ENTIRE file into JS memory (`file.bytes()`)
 *   because expo-crypto has no streaming digest — seconds of dead time and a memory
 *   spike proportional to the export before an upload could even start.
 * - Legacy `getInfoAsync`, not the modern `File.md5` / `file.info({ md5 })`: the
 *   modern accessors are synchronous native calls that would block the JS thread
 *   for the whole hash of a large export. Revisit if the new API gains async md5.
 */
async function md5Checksum(file: File): Promise<string> {
  const info = await getInfoAsync(file.uri, { md5: true });
  if (!info.exists || !info.md5) {
    throw new Error(`Could not read ${file.name} to compute its checksum`);
  }
  return `md5:${info.md5}`;
}

function tempFile(name: string): File {
  const dir = new Directory(Paths.cache, TEMP_DIR_NAME);
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();
  return file;
}

/** Writes text to a fresh temp file under the cache dir so it can be uploaded like any other File. */
function writeTempTextFile(name: string, contents: string): File {
  const file = tempFile(name);
  file.write(contents);
  return file;
}

/** Best-effort bearer DELETE of uploads a run created; a missed one ages out via server retention. */
async function discard(urls: readonly string[], token: string | null): Promise<void> {
  await Promise.all(urls.map((url) => cancelTusUpload(url, token).catch(() => {})));
}

/** The video or one of its related artifacts — the input to `uploadOne`. */
type ArtifactInput = {
  artifactId: string;
  filename: string;
  kind: ArtifactKind;
  relatedTo?: string;
  checksum?: string;
  /** Free-form display title (the draft name). Set only on the video. */
  name?: string;
  file: File;
};

/** What one run owns while it's live: the handles its cancel and cleanup need. */
type Run = {
  session: UploadSession;
  signal: AbortSignal;
  /** Every upload URL this run created, so cancel and failure can DELETE them. */
  created: string[];
  /** Temp files this run wrote, deleted when it settles. */
  temps: File[];
};

/**
 * The app-wide, screen-independent upload engine. A module-scope singleton
 * (created once at import, exported as `uploads`) that owns a queue of upload
 * sessions and drives them to completion regardless of which screen is mounted
 * or whether the app is foregrounded.
 *
 * One link, one upload: claiming a destination spends it. Within an upload only
 * TUS retries (`withRetry` in tus-client, resuming from the server's offset). When
 * TUS can't continue — retries exhausted, a terminal response, an expired token —
 * the upload fails and leaves nothing behind: the draft is unpaired, what the run
 * created on the server DELETEd, and the user told why. The
 * upload lives as long as the app does; sessions are held only in memory, and a
 * kill fails the draft on the next launch (`prepareLaunch`).
 *
 * Races between a cancel and a finish are decided by the database: `markUploaded`
 * and `burnUploadPairing` only act on a draft that is still `uploading`, and
 * whichever lands first wins.
 */
class BackgroundUploadManager {
  private readonly listeners = new Set<() => void>();
  private readonly live = new Map<string, LiveUploadState>();
  private readonly sessions = new Map<string, UploadSession>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly created = new Map<string, string[]>();
  private readonly watchLinks = new Map<string, WatchLink>();
  /** Drafts with a claim in flight, so a double tap uploads once — and a cancel mid-claim sticks. */
  private readonly claiming = new Map<string, { cancelled: boolean }>();
  private running = false;
  /** The launch check — nothing claims or uploads until it has settled. */
  private launch: Promise<void> | null = null;

  /**
   * Foreground failure surface, registered by the upload provider at startup
   * (inverted dependency — this module stays React-free). A failure is a toast
   * in the foreground and `uploadNotify.failed` in the background (which no-ops
   * in the foreground, so they never double up).
   */
  private showToast: ((message: string) => void) | null = null;
  registerToast(showToast: (message: string) => void): void {
    this.showToast = showToast;
  }

  // ---- subscription surface (useSyncExternalStore) ----

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  readonly getDraftState = (draftId: string): LiveUploadState => this.live.get(draftId) ?? IDLE;

  /** The draft's last finished upload's link this session, whether or not it still works. */
  readonly getWatchLink = (draftId: string): WatchLink | null =>
    this.watchLinks.get(draftId) ?? null;

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  private setLive(draftId: string, state: LiveUploadState): void {
    if (state.status === 'idle') this.live.delete(draftId);
    else this.live.set(draftId, state);
    this.emit();
  }

  /**
   * What to tell the user about a failure: the instruction first — the toast shows two lines —
   * then the reason and the step it happened in. Reads the live state for the step, so it must
   * run BEFORE the state resets.
   */
  private failureMessage(draftId: string, err: unknown): string {
    if (err instanceof UploadStoppedError) return err.message;
    // 426 Upgrade Required mid-upload: the server was upgraded past this app (PROTOCOL.md §7.2).
    if (err instanceof TusUploadError && err.statusCode === 426) {
      return STOPPED_MESSAGE['version-too-old'];
    }
    const reason = err instanceof Error && err.message ? err.message : 'Unknown error';
    const live = this.live.get(draftId);
    const detail = live?.status === 'uploading' ? `${PHASE_NAME[live.phase]}: ${reason}` : reason;
    return `Upload failed — ${NEW_LINK} (${detail})`;
  }

  // ---- public API ----

  /**
   * Once per launch, before anything uploads: cancel transfers an earlier process
   * left in the iOS background session, clear upload temp files, and fail every
   * draft still marked `uploading` — the app was killed mid-upload. What that upload
   * created on the server is left to retention (its URLs died with the process).
   * Idempotent: every call returns the same promise.
   */
  prepareLaunch(): Promise<void> {
    this.launch ??= this.settleLaunch();
    return this.launch;
  }

  private async settleLaunch(): Promise<void> {
    await cancelOrphanedUploadTasks();
    cleanupStaleUploadTempFiles();
    try {
      const temps = new Directory(Paths.cache, TEMP_DIR_NAME);
      if (temps.exists) temps.delete();
    } catch {
      // Locked — the next launch tries again.
    }
    try {
      // Claims wait for this check, so nothing in this process is running any of these.
      let interrupted = 0;
      for (const draftId of await getUploadingDraftIds()) {
        if (await burnUploadPairing(draftId)) interrupted++;
      }
      if (interrupted > 0) {
        const what = interrupted === 1 ? 'An upload' : `${interrupted} uploads`;
        this.showToast?.(`${what} didn’t finish — ${NEW_LINK}`);
        // The launch may be in the background (iOS relaunches the app for a finished transfer).
        void uploadNotify.failed();
      }
    } catch {
      // Best-effort: a draft left `uploading` stays locked until the next launch settles it.
    }
    // Not part of the check claims wait for: nothing uploads with these.
    void this.restoreViewLinks();
  }

  /** Bring back the view links of uploaded drafts that still work, and forget expired ones. */
  private async restoreViewLinks(): Promise<void> {
    try {
      for (const draftId of await getUploadedDraftIds()) {
        const link = await getViewLink(draftId);
        if (!link) continue;
        if (link.expiresAt <= Date.now()) {
          await deleteViewLink(draftId);
          continue;
        }
        // An upload this session already set a newer one.
        if (!this.watchLinks.has(draftId)) {
          this.watchLinks.set(draftId, { ...link, shareable: true });
        }
      }
    } catch {
      // Best-effort: a link that can't be read just isn't offered.
    }
    this.emit();
  }

  /**
   * Spend a pool destination on a draft and start uploading it. The draft is written
   * `uploading` FIRST, then the pool row is removed: a kill between the two leaves an
   * `uploading` draft the launch check fails cleanly. The pool delete is the arbiter
   * when two drafts claim one link — the loser unpairs itself. A double tap on the
   * same draft is ignored.
   */
  async claim(params: {
    draftId: string;
    destinationId: string;
    destination: Destination;
    segments: UploadSession['segments'];
    merged: UploadSession['merged'];
  }): Promise<void> {
    const { draftId, destinationId, destination, segments, merged } = params;
    if (this.claiming.has(draftId) || this.getDraftState(draftId).status !== 'idle') return;
    const pending = { cancelled: false };
    this.claiming.set(draftId, pending);
    try {
      await this.launch;
      await setUploadDestination(draftId, destination);
      if (!(await deleteDestination(destinationId))) {
        await burnUploadPairing(draftId, destination.artifactId);
        return;
      }
      // Cancelled (from Home's ⋯ menu) after the pairing landed: the cancel unpaired it already.
      if (pending.cancelled) return;
      this.enqueue({ draftId, destination, segments, merged });
    } catch {
      // The pairing or the pool write failed: undo the pairing (if it landed) rather than leave
      // the draft locked with nothing uploading it.
      await burnUploadPairing(draftId, destination.artifactId).catch(() => false);
      this.showToast?.('Couldn’t start the upload — try again.');
    } finally {
      this.claiming.delete(draftId);
    }
  }

  private enqueue(session: UploadSession): void {
    const { draftId, destination } = session;
    if (this.sessions.has(draftId)) return;
    // Dead on arrival — the link expired between picking it and tapping Upload.
    if (isTokenExpired(destination.token, Date.now())) {
      void this.fail(draftId, destination, new UploadStoppedError(STOPPED_MESSAGE.expired), []);
      return;
    }
    this.sessions.set(draftId, session);
    // A new upload replaces the draft's previous one.
    this.watchLinks.delete(draftId);
    void deleteViewLink(draftId).catch(() => {});
    // Ask for notification permission now — a foreground moment (the user just tapped Upload) — so
    // the background completion/failure banner can fire later without prompting mid-upload.
    void uploadNotify.ensurePermission();
    this.setLive(draftId, { status: 'uploading', phase: 'preparing', progress: 0 });
    void this.ensureRunning();
  }

  /** Abort a draft's upload, unpair it, and DELETE what the run created. */
  async cancel(draftId: string): Promise<void> {
    const token = this.sessions.get(draftId)?.destination.token ?? null;
    const created = this.created.get(draftId) ?? [];
    const pendingClaim = this.claiming.get(draftId);
    if (pendingClaim) pendingClaim.cancelled = true;
    this.controllers.get(draftId)?.abort();
    this.sessions.delete(draftId);
    this.controllers.delete(draftId);
    this.created.delete(draftId);
    // The burn only clears a draft that is still `uploading` — a finish that landed first keeps
    // its `uploaded` row, and the upload stands.
    const burned = await burnUploadPairing(draftId);
    if (this.getDraftState(draftId).status === 'uploading') this.setLive(draftId, IDLE);
    if (burned) void discard(created, token);
  }

  /**
   * Idempotent drain trigger — safe to call from every wake-up (AppState→active, a
   * new enqueue). If a drain is already running it returns immediately; otherwise
   * it drains the queue to empty, one session at a time.
   */
  async ensureRunning(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Whether the Android foreground service is up. Started once (lazily, only for real work) and
    // stopped once when the whole drain finishes — NOT per session, so back-to-back uploads don't
    // stop+restart the service (which Android 12+ can block when backgrounded, and which flashes
    // the notification off/on).
    let keepAliveStarted = false;
    try {
      await this.launch;
      for (;;) {
        if (!this.nextPending()) break;
        if (!keepAliveStarted) {
          // Hold the process alive while draining (Android foreground service; no-op elsewhere) so
          // a backgrounded run isn't frozen/killed.
          await keepAlive.begin();
          keepAliveStarted = true;
        }
        // Picked after the await: a cancel while the service was starting removed its session.
        const session = this.nextPending();
        if (!session) break;
        void keepAlive.note(this.notificationText());
        await this.runSession(session);
      }
    } finally {
      if (keepAliveStarted) await keepAlive.end();
      this.running = false;
    }
    // An upload enqueued while `keepAlive.end()` was in flight (a real native call on Android)
    // found `running` still set and returned — pick it up now, or it would sit at "Preparing…".
    if (this.nextPending()) void this.ensureRunning();
  }

  private notificationText(): string {
    const n = this.sessions.size;
    return n <= 1 ? 'Uploading your pulse…' : `Uploading ${n} pulses…`;
  }

  private nextPending(): UploadSession | null {
    for (const [draftId, session] of this.sessions) {
      if (!this.controllers.has(draftId)) return session;
    }
    return null;
  }

  /**
   * The upload failed and can't continue: unpair the draft, tell the user why — a toast in the
   * foreground, a notification in the background — and DELETE what the run created. The unpairing
   * is scoped to this upload's link, so it never touches a newer claim; and a cancel that already
   * unpaired the draft owns the outcome, so this does nothing then. The DELETEs aren't awaited:
   * a slow server must not hold up the next upload.
   */
  private async fail(
    draftId: string,
    destination: Destination,
    err: unknown,
    created: readonly string[],
  ): Promise<void> {
    const message = this.failureMessage(draftId, err);
    if (!(await burnUploadPairing(draftId, destination.artifactId))) return;
    this.setLive(draftId, IDLE);
    this.showToast?.(message);
    void uploadNotify.failed();
    void discard(created, destination.token);
  }

  // ---- per-session orchestration ----

  private async runSession(session: UploadSession): Promise<void> {
    const { draftId, destination } = session;
    const controller = new AbortController();
    const run: Run = { session, signal: controller.signal, created: [], temps: [] };
    this.controllers.set(draftId, controller);
    this.created.set(draftId, run.created);
    try {
      // The server may have been upgraded since this destination was paired (PROTOCOL.md §7.2):
      // check again before sending anything, and stop with the pairing message if the two no
      // longer speak a common protocol. An unreachable server is left to the upload's retries.
      const compat = await checkCapabilities(destination.server, controller.signal);
      if (!compat.ok && compat.reason !== 'unreachable') {
        throw new UploadStoppedError(STOPPED_MESSAGE[compat.reason]);
      }
      const draftName = await this.uploadPulse(run);
      // Recorded as uploaded the moment the bytes are in — nothing (a view link) comes first.
      if (!(await markUploaded(draftId, destination.artifactId))) {
        // A cancel unpaired the draft while the last bytes landed, and its outcome stands: reset
        // (unless the cancel already did) and DELETE what this run created, as the cancel does.
        if (!controller.signal.aborted) this.setLive(draftId, IDLE);
        void discard(run.created, destination.token);
        return;
      }
      // Watch / Copy link live in the draft's ⋯ menu on Home, for as long as the link works.
      const direct: WatchLink = {
        url: watchUrlOf(destination),
        expiresAt: expiresAtMs(destination.token),
        shareable: destination.token === null,
      };
      this.watchLinks.set(draftId, direct);
      this.setLive(draftId, IDLE);
      // Tell the user it landed: a toast wherever they are, a notification in the background.
      this.showToast?.(draftName ? `Uploaded “${draftName}”` : 'Your pulse is uploaded');
      void uploadNotify.complete();
      // A shareable link, asked for now while the pairing token is still valid (PROTOCOL.md
      // §6.4) — off the drain, so a slow server holds up nothing.
      if (compat.ok && compat.capabilities.viewLinks) {
        void this.shareableLink(draftId, destination, direct);
      }
    } catch (err) {
      // A cancel aborted this run and owns its cleanup.
      if (controller.signal.aborted) return;
      await this.fail(draftId, destination, err, run.created);
    } finally {
      for (const file of run.temps) {
        try {
          if (file.exists) file.delete();
        } catch {
          // The launch sweep clears the folder anyway.
        }
      }
      // Identity-guarded: a cancel may have cleared these, and a new claim for the same draft
      // may already have its own entries.
      if (this.controllers.get(draftId) === controller) this.controllers.delete(draftId);
      if (this.sessions.get(draftId) === session) this.sessions.delete(draftId);
      if (this.created.get(draftId) === run.created) this.created.delete(draftId);
    }
  }

  /**
   * Swap a finished upload's direct link for a read-only view link, and keep that across
   * restarts. Keeps the direct link when the server doesn't answer in time, or a newer upload of
   * the draft has replaced it meanwhile.
   */
  private async shareableLink(
    draftId: string,
    destination: Destination,
    direct: WatchLink,
  ): Promise<void> {
    const viewLink = await requestViewLink({
      server: destination.server,
      artifactId: destination.artifactId,
      token: destination.token,
      signal: AbortSignal.timeout(VIEW_LINK_TIMEOUT_MS),
    });
    if (!viewLink || this.watchLinks.get(draftId) !== direct) return;
    this.watchLinks.set(draftId, { ...viewLink, shareable: true });
    this.emit();
    await setViewLink(draftId, viewLink).catch(() => {});
  }

  /** Set a run's live state — unless it was cancelled, whose reset stands. */
  private setRunLive(run: Run, state: LiveUploadState): void {
    if (!run.signal.aborted) this.setLive(run.session.draftId, state);
  }

  private async uploadOne(
    run: Run,
    artifact: ArtifactInput,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<void> {
    const { destination } = run.session;
    // Re-checked before every artifact (not just at the start of a run) — a token fine at the
    // start can go stale partway through a session.
    if (isTokenExpired(destination.token, Date.now())) {
      throw new UploadStoppedError(STOPPED_MESSAGE.expired);
    }
    await uploadViaTus({
      server: destination.server,
      token: destination.token,
      ...artifact,
      signal: run.signal,
      uploadChunk: uploadChunkNative,
      onProgress,
      onResourceCreated: (url) => {
        // Created after a cancel already DELETEd this run's uploads — DELETE this one too.
        if (run.signal.aborted) void discard([url], destination.token);
        else run.created.push(url);
      },
    });
  }

  /** The draft's cover: the first clip's persisted jpeg, or a frame from the video. */
  private async resolveThumbnailFile(run: Run, videoPath: string): Promise<File | null> {
    const { session } = run;
    const firstThumb = session.segments[0]?.thumbnail;
    if (firstThumb) {
      const persisted = new File(absolutize(firstThumb));
      if (persisted.exists) return persisted;
    }
    const out = tempFile(`${session.draftId}.jpg`);
    run.temps.push(out);
    const ok = await generateThumbnailFile(toFileUri(videoPath), out.uri);
    return ok && out.exists ? out : null;
  }

  /**
   * Upload a pulse: its captions, beat manifest and thumbnail (each `relatedTo` the video), then
   * the video itself, named by the pairing link's `artifactId`. The related artifacts get a fresh
   * artifactId every upload. Resolves the draft's name, which the video carries as its title.
   */
  private async uploadPulse(run: Run): Promise<string | undefined> {
    const { draftId, destination, segments, merged } = run.session;
    // merged.path is a bare filesystem path on Android (RNVT) — normalize to a file:// URI or the
    // File API rejects it outright ("URI is not absolute").
    const file = new File(toFileUri(merged.path));
    // The draft's title rides the video.
    const draftName = await getDraftName(draftId);
    // Backstop: the persisted export lives in the draft dir (safe from cache sweeps) and the draft
    // is locked while uploading, so a missing file means something outside the app removed it.
    if (!file.exists) throw new UploadStoppedError(STOPPED_MESSAGE['video-missing']);
    const checksum = await md5Checksum(file);

    // The small related artifacts go FIRST. The big video PATCH is the only network step that
    // survives iOS backgrounding (native background URLSession) — JS-driven fetches freeze the
    // moment the app leaves the foreground. With the video last, a backgrounded upload has only
    // the verification HEAD + status write left when the OS wakes the app for the completed
    // background transfer, instead of stalling at "100%" with captions/manifest/thumbnail
    // (all a few KB each) still queued behind a suspended JS thread.
    const related = (filename: string, kind: ArtifactKind, relatedFile: File) =>
      this.uploadOne(run, {
        artifactId: Crypto.randomUUID(),
        filename,
        kind,
        relatedTo: destination.artifactId,
        file: relatedFile,
      });

    // Captions: the draft's transcript of the video (hand-edit if present, else auto).
    const row = await getDraftTranscriptRow(draftId);
    const lines = parseTranscriptLines(row?.editedLines ?? row?.lines);
    if (lines.length > 0) {
      this.setRunLive(run, { status: 'uploading', phase: 'captions', progress: 0 });
      const vttFile = writeTempTextFile(`${draftId}.vtt`, linesToVtt(lines));
      run.temps.push(vttFile);
      await related(`${draftId}.vtt`, 'captions', vttFile);
    }

    // Beat manifest: each recorded clip's start/end on the video's timeline (groundwork for HLS).
    this.setRunLive(run, { status: 'uploading', phase: 'manifest', progress: 0 });
    const manifestFile = writeTempTextFile(
      `${draftId}-beats.pulse`,
      JSON.stringify(buildBeatManifest(segments, merged.durationMs)),
    );
    run.temps.push(manifestFile);
    await related(`${draftId}-beats.pulse`, 'project', manifestFile);

    // Thumbnail (poster frame).
    this.setRunLive(run, { status: 'uploading', phase: 'thumbnail', progress: 0 });
    const thumbFile = await this.resolveThumbnailFile(run, merged.path);
    if (thumbFile) await related(`${draftId}.jpg`, 'thumbnail', thumbFile);

    // The video itself — LAST, so it's the only thing still moving when backgrounded.
    // Throttle progress to at most one store update / 200ms — the native task ticks fast; the
    // final (EOF) tick always goes through so the bar still reaches 100%.
    this.setRunLive(run, { status: 'uploading', phase: 'video', progress: 0 });
    let lastTick = 0;
    await this.uploadOne(
      run,
      {
        artifactId: destination.artifactId,
        filename: `${draftId}.mp4`,
        kind: 'video',
        checksum,
        name: draftName,
        file,
      },
      ({ bytesSent, totalBytes }) => {
        const done = totalBytes > 0 && bytesSent >= totalBytes;
        const now = Date.now();
        if (!done && now - lastTick < 200) return;
        lastTick = now;
        this.setRunLive(run, {
          status: 'uploading',
          phase: 'video',
          progress: totalBytes ? bytesSent / totalBytes : 0,
        });
      },
    );
    return draftName;
  }
}

/** The app-wide singleton. Imported by `upload-deep-link-provider` so it registers for the app's lifetime. */
export const uploads = new BackgroundUploadManager();

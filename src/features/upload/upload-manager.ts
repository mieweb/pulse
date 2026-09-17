import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { getInfoAsync } from 'expo-file-system/legacy';

import { burnUploadPairing, getDraftName, getInterruptedUploads, markUploaded } from '@/db/drafts';
import type { Draft } from '@/db/schema';
import { getDraftToken } from '@/db/secure-token';
import { getDraftTranscriptRow } from '@/db/transcripts';
import { linesToVtt } from '@/features/transcription/vtt';
import { parseTranscriptLines } from '@/features/transcription/whisper';
import { absolutize, toFileUri } from '@/utils/file-store';
import { generateThumbnailFile } from '@/utils/video';

import { buildBeatManifest } from './beat-manifest';
import { isTokenExpired } from './capability-token';
import { keepAlive } from './keep-alive';
import { uploadNotify } from './notify';
import { directServerTransport } from './transports/direct-server-transport';
import { tusServerTransport } from './transports/tus-server-transport';
import {
  artifactUrl,
  authHeaders,
  cancelTusUpload,
  isAbortError,
  isRedirect,
  type ArtifactKind,
} from './tus-client';
import type {
  Destination,
  LiveUploadState,
  UploadProgress,
  UploadSession,
  UploadTransport,
} from './types';

/** Failure reasons are sentences without the call to action — `settleFailure` appends it once. */
const EXPIRED_PAIRING_MESSAGE = 'Upload link expired';
const INTERRUPTED_MESSAGE = 'An upload didn’t finish';

/** How long a finished run's one-shot `done` live state survives without being acknowledged. */
const DONE_STATE_TTL_MS = 60_000;

class ExpiredPairingError extends Error {
  constructor() {
    super(EXPIRED_PAIRING_MESSAGE);
    this.name = 'ExpiredPairingError';
  }
}

/** Stable idle reference so `useSyncExternalStore`'s `getSnapshot` returns `===` for untouched drafts. */
const IDLE: LiveUploadState = { status: 'idle' };

function describeError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Upload failed';
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

/** Writes text to a fresh temp file under the cache dir so it can be uploaded like any other File. */
function writeTempTextFile(name: string, contents: string): File {
  const dir = new Directory(Paths.cache, 'uploads');
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();
  file.write(contents);
  return file;
}

/** A session anchor (video/manifest) or a related sub-artifact — the input to `uploadOne`. */
type ArtifactInput = {
  artifactId: string;
  filename: string;
  kind: ArtifactKind;
  relatedTo?: string;
  /** Free-form display title (the draft name). Set only on the session anchor. */
  name?: string;
  file: File;
};

/**
 * The app-wide, screen-independent upload engine. A module-scope singleton
 * (created once at import, exported as `uploads`) that drives upload sessions
 * to completion regardless of which screen is mounted or whether the app is
 * foregrounded.
 *
 * The model is deliberately single-shot: a pairing (deep link) anchors at most
 * ONE run. Transient trouble is absorbed inside the run by the transports'
 * retry/backoff; anything terminal burns the pairing (columns reset, token
 * dropped, toast/notification with the reason) and the draft simply returns to
 * being editable — there is no retry surface, no persisted resume state, and
 * no failed status. Sessions live only in memory; an app killed mid-run is
 * settled by `sweepInterruptedUploads` on the next launch.
 */
class BackgroundUploadManager {
  private readonly listeners = new Set<() => void>();
  private readonly live = new Map<string, LiveUploadState>();
  private readonly sessions = new Map<string, UploadSession>();
  private readonly controllers = new Map<string, AbortController>();
  /**
   * Every server resource this run has created so far (related artifacts land
   * before the video). A cancel or terminal failure DELETEs all of them — the
   * anchor will never complete, so a finished captions/manifest/thumbnail is
   * debris nothing could ever clean up (their ids are minted per run, never
   * persisted). In memory only: an app kill leaves them to server retention.
   */
  private readonly created = new Map<string, string[]>();
  private running = false;
  /** Set when a new upload is enqueued while a drain is already running, so it isn't stranded. */
  private wake = false;

  /**
   * Foreground failure surface, registered by the toast provider at startup
   * (inverted dependency — this module stays React-free). Failures are EVENTS:
   * a toast when foregrounded, `uploadNotify.failed` when backgrounded (the
   * notification helper already no-ops in the foreground, so they never
   * double-fire).
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

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  private setLive(draftId: string, state: LiveUploadState): void {
    if (state.status === 'idle') this.live.delete(draftId);
    else this.live.set(draftId, state);
    this.emit();
  }

  /**
   * Prefix a failure reason with the phase in flight when it happened, so an
   * error during captions vs the video no longer produces the same generic
   * context. Reads the live state, so it must run BEFORE the state resets.
   */
  private failureReason(draftId: string, reason: string): string {
    const live = this.live.get(draftId);
    if (live?.status !== 'uploading') return reason;
    switch (live.phase) {
      case 'preparing':
        return `Preparation failed: ${reason}`;
      case 'captions':
        return `Captions upload failed: ${reason}`;
      case 'manifest':
        return `Manifest upload failed: ${reason}`;
      case 'thumbnail':
        return `Thumbnail upload failed: ${reason}`;
      case 'video':
        return `Video upload failed: ${reason}`;
      default:
        return reason;
    }
  }

  /**
   * Terminal failure is an event, not a state: burn the spent pairing (the
   * deep link is single-shot), reset the draft to editable, and tell the user
   * why — toast in the foreground, notification off-screen. The draft card
   * carries no failure UI; scanning a fresh link is the retry.
   */
  private async settleFailure(
    draftId: string,
    reason: string,
    token: string | null,
  ): Promise<void> {
    const message = `${this.failureReason(draftId, reason)} — scan a new link to try again.`;
    this.setLive(draftId, { status: 'idle' });
    if (await burnUploadPairing(draftId)) await this.discardCreated(draftId, token);
    this.showToast?.(message);
    void uploadNotify.failed();
  }

  /**
   * Best-effort bearer DELETE of everything this run created server-side; a
   * missed one just ages out via retention. Only ever called after a burn
   * actually happened — a run that raced to 'uploaded' keeps its artifacts.
   */
  private async discardCreated(draftId: string, token: string | null): Promise<void> {
    const urls = this.created.get(draftId) ?? [];
    this.created.delete(draftId);
    await Promise.all(urls.map((url) => cancelTusUpload(url, token).catch(() => {})));
  }

  // ---- public API ----

  /** Start a draft's upload. Ignored if the draft already has a live run. */
  enqueue(session: UploadSession): void {
    if (this.controllers.has(session.draftId) || this.sessions.has(session.draftId)) return;
    // Dead on arrival — the pairing expired between claim and tap.
    if (isTokenExpired(session.destination.token, Date.now())) {
      void this.settleFailure(session.draftId, EXPIRED_PAIRING_MESSAGE, session.destination.token);
      return;
    }
    this.sessions.set(session.draftId, session);
    // Ask for notification permission now — a foreground moment (the user just tapped Upload) — so
    // the background completion/failure banner can fire later without prompting mid-upload.
    void uploadNotify.ensurePermission();
    // The durable 'uploading' marker was already written by the claim (setUploadDestination),
    // BEFORE this enqueue — so no network step can outrun it into a kill window.
    this.setLive(session.draftId, { status: 'uploading', phase: 'preparing', progress: 0 });
    void this.ensureRunning();
  }

  /** Abort whatever's in flight for a draft, burn its pairing, and DELETE what the run created. */
  async cancel(draftId: string): Promise<void> {
    const token = this.sessions.get(draftId)?.destination.token ?? null;
    this.controllers.get(draftId)?.abort();
    // Reset local state FIRST — before any round-trip. You often cancel *because* the
    // network died; a slow burn or server-cancel must not leave the card stuck.
    this.sessions.delete(draftId);
    this.controllers.delete(draftId);
    this.setLive(draftId, { status: 'idle' });
    // The burn's own WHERE is the guard: a COMPLETED upload's row is untouched (its
    // columns are the watch link) and reports false, so its artifacts are kept too.
    if (await burnUploadPairing(draftId)) await this.discardCreated(draftId, token);
  }

  /** Dismiss a finished run's `done` state back to idle (after the one-time watch prompt). */
  acknowledge(draftId: string): void {
    if (this.getDraftState(draftId).status === 'done') this.setLive(draftId, { status: 'idle' });
  }

  /**
   * Idempotent drain trigger — safe to call from every wake-up (app launch,
   * AppState→active, a new enqueue). If a drain is already running it returns
   * immediately; otherwise it drains the queue to empty, one session at a time.
   */
  async ensureRunning(): Promise<void> {
    // Already draining — record that new work arrived so the active loop picks it up before exiting,
    // instead of stranding an upload enqueued in the moment the drain was winding down.
    if (this.running) {
      this.wake = true;
      return;
    }
    this.running = true;
    // Whether the Android foreground service is up. Started once (lazily, only for real work) and
    // stopped once when the whole drain finishes — NOT per do-while iteration, so back-to-back
    // uploads don't stop+restart the service (which Android 12+ can block when backgrounded, and
    // which flashes the notification off/on).
    let keepAliveStarted = false;
    try {
      do {
        this.wake = false;
        // Nothing to do — crucially, DON'T start the Android foreground service for an empty queue
        // (that would flash a notification on every foreground and fail Play review).
        if (!this.nextPending()) continue;
        if (!keepAliveStarted) {
          // Hold the process alive while draining (Android foreground service; no-op elsewhere) so a
          // backgrounded run isn't frozen/killed.
          await keepAlive.begin();
          keepAliveStarted = true;
        }
        for (;;) {
          const session = this.nextPending();
          if (!session) break;
          void keepAlive.note(this.notificationText());
          await this.runSession(session);
        }
      } while (this.wake || this.nextPending());
    } finally {
      if (keepAliveStarted) await keepAlive.end();
      this.running = false;
    }
  }

  private notificationText(): string {
    const n = this.sessions.size;
    return n <= 1 ? 'Uploading your pulse…' : `Uploading ${n} pulses…`;
  }

  /**
   * Settle drafts left `'uploading'` by an app kill (sessions are in-memory
   * only) — run at launch and on every return to the foreground. One rule: GET
   * the draft's own artifacts URL once. Serving (2xx, or a storage adapter's
   * presigned redirect) means the native background task finished the transfer
   * while the app was dead — mark it uploaded (safe to trust: the draft was
   * locked for the whole run, so the bytes can only be its own content). Any
   * other answer burns the pairing — including an iOS background transfer still
   * in flight at launch, whose orphan the server's retention cleans up. Only a
   * fetch that throws (offline) says nothing either way and leaves the row for
   * the next sweep.
   */
  async sweepInterruptedUploads(): Promise<void> {
    const rows = await getInterruptedUploads();
    await Promise.all(rows.map((row) => this.settleInterrupted(row)));
  }

  private async settleInterrupted(row: Draft): Promise<void> {
    if (this.sessions.has(row.id) || this.controllers.has(row.id)) return;
    // An 'uploading' row always carries its pairing; one without it has nothing to probe.
    if (row.uploadServer && row.uploadArtifactId) {
      let res: Response;
      try {
        res = await fetch(artifactUrl(row.uploadServer, row.uploadArtifactId), {
          redirect: 'manual',
          headers: { Range: 'bytes=0-0', ...authHeaders(await getDraftToken(row.id)) },
        });
      } catch {
        return;
      }
      await (res.body as { cancel?: () => Promise<void> } | null)?.cancel?.().catch(() => {});
      if (res.ok || isRedirect(res)) {
        // CAS: a cancel that landed during the probe already burned the row — its verdict stands.
        await markUploaded(row.id, row.uploadArtifactId);
        return;
      }
    }
    if (await burnUploadPairing(row.id)) {
      this.showToast?.(`${INTERRUPTED_MESSAGE} — scan a new link to try again.`);
    }
  }

  private nextPending(): UploadSession | null {
    for (const [draftId, session] of this.sessions) {
      if (!this.controllers.has(draftId)) return session;
    }
    return null;
  }

  // ---- per-session orchestration ----

  private async runSession(session: UploadSession): Promise<void> {
    const { draftId, destination } = session;
    const controller = new AbortController();
    this.controllers.set(draftId, controller);
    this.setLive(draftId, { status: 'uploading', phase: 'preparing', progress: 0 });
    // Transport was decided at PAIRING time (capabilities are probed once, at
    // scan): the pairing either advertised the presigned direct profile or it
    // didn't. No per-run probe — a server capability change applies to new
    // pairings, never to a link already scanned.
    const transport = destination.directUpload ? directServerTransport : tusServerTransport;
    try {
      await this.uploadMerged(session, transport, controller.signal);
      // The row is the arbiter: a cancel that raced the final await already burned it,
      // and this CAS then fails — the cancelled draft is never resurrected with a watch link.
      // Either way the session is over (the drain loop re-runs any session left without
      // a controller), so it leaves the queue before the outcome is acted on.
      const settled = await markUploaded(draftId, destination.artifactId);
      this.sessions.delete(draftId);
      if (!settled) {
        // Lost the CAS: a cancel/burn landed first and owns the row, but its reset may
        // predate this run's last progress tick — so reset again, and discard what the run
        // created exactly as cancel does (under a burned pairing it is all debris).
        this.setLive(draftId, { status: 'idle' });
        await this.discardCreated(draftId, destination.token);
        return;
      }
      this.created.delete(draftId);
      // The one-shot done state carries the tokened watch link (tokens never land in the DB).
      const watchUrl = destination.token
        ? `${artifactUrl(destination.server, destination.artifactId)}?token=${encodeURIComponent(destination.token)}`
        : artifactUrl(destination.server, destination.artifactId);
      this.setLive(draftId, { status: 'done', resourceUrl: watchUrl });
      // `done` is a one-shot signal for the export screen's watch prompt; if no screen is around
      // to `acknowledge` it (the run finished on Home / in the background), expire it so it
      // doesn't sit in the live map forever and pop a stale prompt on a much-later screen visit.
      // `acknowledge` no-ops unless the state is still `done`, so this can't clobber a new run.
      setTimeout(() => this.acknowledge(draftId), DONE_STATE_TTL_MS);
      // Tell the user their pulse landed — only surfaces if the app is backgrounded / off-screen.
      void uploadNotify.complete();
    } catch (err) {
      if (isAbortError(err)) {
        // Cancelled via cancel() — that path owns the reset (burn + idle);
        // it already removed the session before aborting.
      } else if (this.sessions.get(draftId) === session) {
        // Terminal failure: the pairing is spent. Burn it, reset the draft to
        // editable, and say why — there is nothing to retry against.
        this.sessions.delete(draftId);
        await this.settleFailure(draftId, describeError(err), destination.token);
      }
    } finally {
      if (this.controllers.get(draftId) === controller) this.controllers.delete(draftId);
    }
  }

  private async uploadOne(
    transport: UploadTransport,
    draftId: string,
    destination: Destination,
    artifact: ArtifactInput,
    checksum: string | undefined,
    signal: AbortSignal,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<{ resourceUrl: string }> {
    // Re-checked before every artifact (not just at the start of a run) — a token fine at the
    // start can go stale partway through a session.
    if (isTokenExpired(destination.token, Date.now())) throw new ExpiredPairingError();
    return transport.run({
      destination,
      artifact: {
        artifactId: artifact.artifactId,
        filename: artifact.filename,
        kind: artifact.kind,
        relatedTo: artifact.relatedTo,
        checksum,
        name: artifact.name,
        file: artifact.file,
      },
      signal,
      onProgress,
      // Remembered in memory only — the cancel/discard handle, never a resume identity.
      onResourceCreated: (url) => {
        this.created.set(draftId, [...(this.created.get(draftId) ?? []), url]);
      },
    });
  }

  /** Upload a session-related artifact (captions / beat manifest / thumbnail) under a fresh ephemeral id. */
  private async uploadRelatedArtifact(
    transport: UploadTransport,
    session: UploadSession,
    spec: { filename: string; kind: ArtifactKind; file: File },
    signal: AbortSignal,
  ): Promise<void> {
    const { draftId, destination } = session;
    await this.uploadOne(
      transport,
      draftId,
      destination,
      {
        // Minted per run, never persisted: if this run dies the whole pairing is
        // burned, so there is no retry that could want the same id back.
        artifactId: Crypto.randomUUID(),
        filename: spec.filename,
        kind: spec.kind,
        relatedTo: destination.artifactId,
        file: spec.file,
      },
      undefined,
      signal,
    );
  }

  /** The draft's cover for a merged upload: the first clip's persisted jpeg, or a frame from the merge. */
  private async resolveThumbnailFile(
    session: UploadSession,
    mergedPath: string,
  ): Promise<File | null> {
    const firstThumb = session.segments[0]?.thumbnail;
    if (firstThumb) {
      const persisted = new File(absolutize(firstThumb));
      if (persisted.exists) return persisted;
    }
    const dir = new Directory(Paths.cache, 'uploads');
    dir.create({ intermediates: true, idempotent: true });
    const out = new File(dir, `${session.draftId}.jpg`);
    if (out.exists) out.delete();
    const ok = await generateThumbnailFile(toFileUri(mergedPath), out.uri);
    return ok && out.exists ? out : null;
  }

  private async uploadMerged(
    session: UploadSession,
    transport: UploadTransport,
    signal: AbortSignal,
  ): Promise<void> {
    const { draftId, destination, segments, merged } = session;
    if (!merged) throw new Error('Export is not ready yet');
    // merged.path is a bare filesystem path on Android (RNVT) — normalize to a file:// URI or the
    // File API rejects it outright ("URI is not absolute").
    const file = new File(toFileUri(merged.path));
    // The draft's title rides the video — the session anchor.
    const draftName = await getDraftName(draftId);
    // The merged output is a native cache file; if it was evicted (rare, but possible after a long
    // gap or an app kill) there's nothing to upload — surface a clear, actionable reason rather
    // than crashing in `bytes()`. Re-opening the draft re-exports and re-enqueues with a fresh path.
    if (!file.exists) {
      throw new Error(
        'The merged video is no longer available — reopen the draft to re-export, then upload.',
      );
    }
    const checksum = await md5Checksum(file);

    // The small related artifacts go FIRST. The big video PATCH is the only network step that
    // survives iOS backgrounding (native background URLSession) — JS-driven fetches freeze the
    // moment the app leaves the foreground. With the video last, a backgrounded upload has only
    // the verification HEAD + status write left when the OS wakes the app for the completed
    // background transfer, instead of stalling at "100%" with captions/manifest/thumbnail
    // (all a few KB each) still queued behind a suspended JS thread.

    // Captions: the draft's single MERGED transcript (hand-edit if present, else auto).
    const row = await getDraftTranscriptRow(draftId);
    const lines = parseTranscriptLines(row?.editedLines ?? row?.lines);
    if (lines.length > 0) {
      this.setLive(draftId, { status: 'uploading', phase: 'captions', progress: 0 });
      const vttFile = writeTempTextFile(`${draftId}.vtt`, linesToVtt(lines));
      await this.uploadRelatedArtifact(
        transport,
        session,
        { filename: `${draftId}.vtt`, kind: 'captions', file: vttFile },
        signal,
      );
    }

    // Beat manifest: per-segment timecodes on the merged timeline (groundwork for HLS).
    this.setLive(draftId, { status: 'uploading', phase: 'manifest', progress: 0 });
    const manifestFile = writeTempTextFile(
      `${draftId}-beats.pulse`,
      JSON.stringify(buildBeatManifest(segments, merged.durationMs)),
    );
    await this.uploadRelatedArtifact(
      transport,
      session,
      { filename: `${draftId}-beats.pulse`, kind: 'project', file: manifestFile },
      signal,
    );

    // Thumbnail (poster frame).
    this.setLive(draftId, { status: 'uploading', phase: 'thumbnail', progress: 0 });
    const thumbFile = await this.resolveThumbnailFile(session, merged.path);
    if (thumbFile) {
      await this.uploadRelatedArtifact(
        transport,
        session,
        { filename: `${draftId}.jpg`, kind: 'thumbnail', file: thumbFile },
        signal,
      );
    }

    // The video itself — LAST, so it's the only thing still moving when backgrounded.
    // Throttle progress to at most one store update / 200ms — the native task ticks fast; the
    // final (EOF) tick always goes through so the bar still reaches 100%.
    this.setLive(draftId, { status: 'uploading', phase: 'video', progress: 0 });
    let lastTick = 0;
    await this.uploadOne(
      transport,
      draftId,
      destination,
      {
        artifactId: destination.artifactId,
        filename: `${draftId}.mp4`,
        kind: 'video',
        name: draftName,
        file,
      },
      checksum,
      signal,
      ({ bytesSent, totalBytes }) => {
        const done = totalBytes > 0 && bytesSent >= totalBytes;
        const now = Date.now();
        if (!done && now - lastTick < 200) return;
        lastTick = now;
        this.setLive(draftId, {
          status: 'uploading',
          phase: 'video',
          progress: totalBytes ? bytesSent / totalBytes : 0,
        });
      },
    );
  }
}

/** The app-wide singleton. Imported by `upload-deep-link-provider` so it registers for the app's lifetime. */
export const uploads = new BackgroundUploadManager();

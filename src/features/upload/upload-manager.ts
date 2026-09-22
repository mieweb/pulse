import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { getInfoAsync } from 'expo-file-system/legacy';

import { deleteDestination, getDestinationIdByArtifactId } from '@/db/destinations';
import {
  getDraftName,
  getDraftUploadStatus,
  getResumableDrafts,
  getUploadArtifact,
  draftQuery,
  segmentsForDraft,
  setCaptionsUploadStatus,
  setUploadProgress,
  type UploadArtifactKey,
  upsertUploadArtifact,
} from '@/db/drafts';
import type { Draft } from '@/db/schema';
import { getDraftToken } from '@/db/secure-token';
import { getDraftTranscriptRow } from '@/db/transcripts';
import { loadMergedExport } from '@/features/export/merged-export';
import { linesToVtt } from '@/features/transcription/vtt';
import { parseTranscriptLines } from '@/features/transcription/whisper';
import { absolutize, toFileUri } from '@/utils/file-store';
import { effMs } from '@/utils/segment-window';
import { generateThumbnailFile } from '@/utils/video';

import { buildBeatManifest } from './beat-manifest';
import { isTokenExpired } from './capability-token';
import { keepAlive } from './keep-alive';
import { uploadNotify } from './notify';
import { tusServerTransport } from './transports/tus-server-transport';
import type { ArtifactKind } from './tus-client';
import type {
  Destination,
  LiveUploadState,
  UploadProgress,
  UploadSession,
  UploadTransport,
} from './types';

const EXPIRED_PAIRING_MESSAGE = 'Upload link expired — ask the operator for a new pairing link.';

/** How long a finished run's one-shot `done` live state survives without being acknowledged. */
const DONE_STATE_TTL_MS = 60_000;

class ExpiredPairingError extends Error {
  readonly retryable = false;
  constructor() {
    super(EXPIRED_PAIRING_MESSAGE);
    this.name = 'ExpiredPairingError';
  }
}

/** Stable idle reference so `useSyncExternalStore`'s `getSnapshot` returns `===` for untouched drafts. */
const IDLE: LiveUploadState = { status: 'idle' };

type RetryableError = Error & { retryable: boolean };
type ErrorDescription = { reason: string; retryable: boolean };

function describeError(err: unknown): ErrorDescription {
  if (err && typeof err === 'object' && 'retryable' in err) {
    const retryableError = err as RetryableError;
    return {
      reason: retryableError.message ?? 'Upload failed',
      retryable: retryableError.retryable,
    };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { reason: 'Cancelled', retryable: true };
  }
  return { reason: err instanceof Error ? err.message : 'Upload failed', retryable: true };
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

/** The session anchor (the video) or a related sub-artifact — the input to `uploadOne`. */
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
 * (created once at import, exported as `uploads`) that owns a queue of upload
 * sessions and drives them to completion regardless of which screen is mounted
 * or whether the app is foregrounded — the piece that replaces the orchestration
 * that used to live inside the `useUpload` React hook.
 *
 * Durable state (destination, resume identity, status) lives in SQLite; this
 * holds only what SQLite doesn't: the in-flight AbortControllers, the live
 * byte-progress the UI subscribes to (never persisted per-tick), a run-lock, and
 * the enqueued sessions. Because the queue of pending work is really the set of
 * drafts with an `uploading` status in SQLite, a session is crash-safe: after a
 * kill it is rebuilt from the row, the clip table, and the draft's persisted
 * merged export (`drafts/{id}/export.mp4`). The draft is locked while its run is
 * live (see `assertNotUploading`), so nothing it reads can change under it.
 */
class BackgroundUploadManager {
  private readonly transport: UploadTransport = tusServerTransport;

  private readonly listeners = new Set<() => void>();
  private readonly live = new Map<string, LiveUploadState>();
  private readonly sessions = new Map<string, UploadSession>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly currentUpload = new Map<
    string,
    { artifactId: string; resourceUrl: string | null }
  >();
  /** Drafts whose run failed — kept in `sessions` so `retry` can re-run them, but skipped by the drain. */
  private readonly failed = new Set<string>();
  private running = false;
  /** Set when a new upload is enqueued while a drain is already running, so it isn't stranded. */
  private wake = false;

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
   * context. Reads the live state, so it must run BEFORE the
   * error state overwrites it.
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

  // ---- public API ----

  /** Queue a draft's upload and start draining if not already. Ignored if the draft is already in flight. */
  enqueue(session: UploadSession): void {
    if (this.controllers.has(session.draftId)) return;
    // Dead on arrival — surface the expired pairing immediately instead of flashing 'uploading'
    // and churning the DB status before the run inevitably fails inside `uploadOne`.
    if (isTokenExpired(session.destination.token, Date.now())) {
      this.setLive(session.draftId, {
        status: 'error',
        reason: EXPIRED_PAIRING_MESSAGE,
        retryable: false,
      });
      void setUploadProgress(session.draftId, { status: 'failed' });
      return;
    }
    this.failed.delete(session.draftId);
    this.sessions.set(session.draftId, session);
    // Ask for notification permission now — a foreground moment (the user just tapped Upload) — so
    // the background completion/failure banner can fire later without prompting mid-upload.
    void uploadNotify.ensurePermission();
    this.setLive(session.draftId, { status: 'uploading', phase: 'preparing', progress: 0 });
    void setUploadProgress(session.draftId, { status: 'uploading' });
    void this.ensureRunning();
  }

  /**
   * Re-run a failed upload. Reuses the in-memory session if present, otherwise reconstructs it from
   * durable state — so the uploads inbox can retry a run that failed before the app was relaunched.
   */
  async retry(draftId: string): Promise<void> {
    if (this.controllers.has(draftId)) return;
    let session = this.sessions.get(draftId);
    if (!session) {
      const [row] = await draftQuery(draftId);
      if (!row) return;
      const result = await this.reconstructSession(row);
      if (!result.ok) {
        // Can't rebuild the run (expired token / evicted export) — surface it rather than silently
        // no-op, so the user sees a clear reason and can re-pair / re-export.
        this.setLive(draftId, { status: 'error', reason: result.reason, retryable: false });
        await setUploadProgress(draftId, { status: 'failed' });
        return;
      }
      session = result.session;
    }
    this.failed.delete(draftId);
    this.sessions.set(draftId, session);
    this.setLive(draftId, { status: 'uploading', phase: 'preparing', progress: 0 });
    void setUploadProgress(draftId, { status: 'uploading' });
    void this.ensureRunning();
  }

  /** Abort + server-cancel whatever's in flight for a draft, and drop it from the queue. */
  async cancel(draftId: string): Promise<void> {
    // A COMPLETED upload has nothing to cancel — and resetting its row would strip the
    // 'uploaded' marker that keeps a later clip edit from wiping its (finished) upload state.
    // Only bail when nothing is actually live, so the reset keeps un-wedging stuck rows.
    if (!this.sessions.has(draftId) && !this.controllers.has(draftId)) {
      const status = await getDraftUploadStatus(draftId);
      if (status === 'uploaded') return;
    }
    this.controllers.get(draftId)?.abort();
    const session = this.sessions.get(draftId);
    // Target whatever's actually in flight — a sub-artifact may not be the session anchor —
    // falling back to the anchor only if nothing had started uploading yet.
    const target =
      this.currentUpload.get(draftId)?.resourceUrl ?? session?.destination.resourceUrl ?? null;
    const token = session?.destination.token ?? null;
    // Drop it from the queue and reset durable + live state FIRST — before the network round-trip
    // below. You often cancel *because* the network died, so a slow/failing server-cancel must not
    // leave the row stuck 'uploading'; the resume path (`hydrateFromDb`) would otherwise resurrect
    // and complete the run the user just cancelled.
    this.sessions.delete(draftId);
    this.failed.delete(draftId);
    this.controllers.delete(draftId);
    this.currentUpload.delete(draftId);
    await setUploadProgress(draftId, { status: 'idle' });
    this.setLive(draftId, { status: 'idle' });
    // Best-effort server-side cancel (TUS DELETE); its failure must not revert the reset above. A
    // stale server-side "uploading" sidecar is the documented un-wedge gap (re-pair / fresh id).
    if (target) {
      try {
        await this.transport.cancel(target, token);
      } catch {
        // Network down / already gone — the local reset stands.
      }
    }
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
        await this.hydrateFromDb();
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
    // Failed drafts stay in `sessions` (so `retry` can reuse them) but aren't in flight — exclude
    // them from the count so the notification doesn't read "Uploading 3 pulses…" for one live run.
    const n = this.sessions.size - this.failed.size;
    return n <= 1 ? 'Uploading your pulse…' : `Uploading ${n} pulses…`;
  }

  /**
   * Rebuild sessions for drafts left mid-upload (status still `uploading`) that aren't already in
   * memory — the after-kill/relaunch resume path. Everything a run needs is reconstructed from
   * durable state: destination + resume URL from the drizzle row, token from secure-store, segments
   * from the clip table, and the video from the draft's persisted export. A run that can't
   * be rebuilt (expired token, no valid export) is settled to failed rather than restarted.
   */
  private async hydrateFromDb(): Promise<void> {
    const rows = await getResumableDrafts();
    for (const row of rows) {
      if (this.sessions.has(row.id) || this.controllers.has(row.id)) continue;
      const result = await this.reconstructSession(row);
      if (!result.ok) {
        // Can't resume off-screen (expired token / evicted export). Settle it to `failed` so the UI
        // surfaces the reason — and so it stops being re-hydrated on every drain — instead of
        // leaving a perpetual 'uploading' ring that never progresses and can't be cleared.
        this.setLive(row.id, { status: 'error', reason: result.reason, retryable: false });
        await setUploadProgress(row.id, { status: 'failed' });
        continue;
      }
      this.sessions.set(row.id, result.session);
      this.setLive(row.id, { status: 'uploading', phase: 'preparing', progress: 0 });
    }
  }

  /**
   * Rebuild an upload session from a persisted draft row (destination + token + segments + export),
   * or a failure `reason` if it can't be resumed off-screen — a missing destination, an expired
   * token, or no persisted export of these clips (a backstop — the draft is locked while
   * uploading, so its clips and export can't change under the run).
   */
  private async reconstructSession(
    row: Draft,
  ): Promise<{ ok: true; session: UploadSession } | { ok: false; reason: string }> {
    if (!row.uploadServer || !row.uploadArtifactId) {
      return { ok: false, reason: 'Upload destination is missing — re-pair to upload.' };
    }
    const token = await getDraftToken(row.id);
    if (isTokenExpired(token, Date.now())) return { ok: false, reason: EXPIRED_PAIRING_MESSAGE };
    // The same clip set the export screen merges and uploads (zero-length clips can't be joined).
    const segments = (await segmentsForDraft(row.id)).filter((s) => effMs(s) > 0);
    const merged = await loadMergedExport(row.id, segments);
    if (!merged) {
      return {
        ok: false,
        reason: 'The video is no longer available — reopen the draft to re-export, then upload.',
      };
    }
    // Re-link the single-use pool destination (that id isn't persisted on the session) so a resumed
    // run still removes it on success — otherwise a spent destination lingers in the pool and gets
    // reused against an already-consumed server-minted artifactId (409).
    const consumedDestinationId = await getDestinationIdByArtifactId(row.uploadArtifactId);
    return {
      ok: true,
      session: {
        draftId: row.id,
        destination: {
          server: row.uploadServer,
          token,
          artifactId: row.uploadArtifactId,
          resourceUrl: row.uploadResourceUrl,
        },
        segments,
        merged,
        consumedDestinationId,
      },
    };
  }

  private nextPending(): UploadSession | null {
    for (const [draftId, session] of this.sessions) {
      if (!this.controllers.has(draftId) && !this.failed.has(draftId)) return session;
    }
    return null;
  }

  // ---- per-session orchestration (moved verbatim in behaviour from the old useUpload hook) ----

  private async runSession(session: UploadSession): Promise<void> {
    const { draftId } = session;
    const controller = new AbortController();
    this.controllers.set(draftId, controller);
    this.setLive(draftId, { status: 'uploading', phase: 'preparing', progress: 0 });
    await setUploadProgress(draftId, { status: 'uploading' });
    try {
      const resourceUrl = await this.uploadPulse(session, controller.signal);
      // Displaced-run guard BEFORE any terminal write: if a cancel removed this session while the
      // final transfer was resolving, resurrecting 'uploaded'/'done' here would overrule it —
      // cancel owns all state from the moment it removed this run from the map.
      if (this.sessions.get(draftId) !== session) return;
      await setUploadProgress(draftId, { status: 'uploaded', resourceUrl });
      this.setLive(draftId, { status: 'done', resourceUrl });
      // `done` is a one-shot signal for the export screen's watch prompt; if no screen is around
      // to `acknowledge` it (the run finished on Home / in the background), expire it so it
      // doesn't sit in the live map forever and pop a stale prompt on a much-later screen visit.
      // `acknowledge` no-ops unless the state is still `done`, so this can't clobber a new run.
      setTimeout(() => this.acknowledge(draftId), DONE_STATE_TTL_MS);
      // Tell the user their pulse landed — only surfaces if the app is backgrounded / off-screen.
      void uploadNotify.complete();
      // Single-use: remove the consumed pool destination now the run finished.
      if (session.consumedDestinationId) {
        await deleteDestination(session.consumedDestinationId);
      }
      if (this.sessions.get(draftId) === session) {
        this.sessions.delete(draftId);
        this.failed.delete(draftId);
      }
    } catch (err) {
      // Every branch below is identity-guarded: a cancel may have cleared the maps AND a fresh
      // session for the same draft may have been enqueued inside the abort window — a displaced
      // run must neither tear down the fresh run's entries nor write its own terminal state over it.
      if (err instanceof Error && err.name === 'AbortError') {
        // Cancelled via cancel() — that path owns resetting status/live to idle;
        // don't race it by overwriting with an error state or keeping the session as "failed".
        if (this.sessions.get(draftId) === session) {
          this.sessions.delete(draftId);
          this.failed.delete(draftId);
        }
      } else if (this.sessions.get(draftId) === session) {
        const { reason, retryable } = describeError(err);
        this.setLive(draftId, {
          status: 'error',
          reason: this.failureReason(draftId, reason),
          retryable,
        });
        await setUploadProgress(draftId, { status: 'failed' });
        // Tell the user it failed — only surfaces if the app is backgrounded / off-screen.
        void uploadNotify.failed();
        // Keep the session (in `failed`) so `retry` can re-run it; the drain skips it.
        this.failed.add(draftId);
      }
    } finally {
      if (this.controllers.get(draftId) === controller) {
        this.controllers.delete(draftId);
        this.currentUpload.delete(draftId);
      }
    }
  }

  private async uploadOne(
    draftId: string,
    destination: Destination,
    artifact: ArtifactInput,
    resourceUrl: string | null,
    checksum: string | undefined,
    signal: AbortSignal,
    onProgress?: (progress: UploadProgress) => void,
    // Fired the instant the server assigns a resource URL — the caller persists it so an app kill
    // mid-transfer can resume via HEAD+PATCH. WITHOUT this the resume path has no handle and
    // re-creates the upload, which the server rejects as a duplicate reserve (409).
    persistResourceUrl?: (url: string) => void,
  ): Promise<{ resourceUrl: string }> {
    // Re-checked before every artifact (not just at the start of a run) — a token fine at the
    // start can go stale partway through a session.
    if (isTokenExpired(destination.token, Date.now())) throw new ExpiredPairingError();
    this.currentUpload.set(draftId, { artifactId: artifact.artifactId, resourceUrl });
    const result = await this.transport.run({
      destination,
      artifact: {
        artifactId: artifact.artifactId,
        filename: artifact.filename,
        kind: artifact.kind,
        relatedTo: artifact.relatedTo,
        checksum,
        name: artifact.name,
        file: artifact.file,
        resourceUrl,
      },
      signal,
      onProgress,
      onResourceCreated: (url) => {
        this.currentUpload.set(draftId, { artifactId: artifact.artifactId, resourceUrl: url });
        persistResourceUrl?.(url);
      },
    });
    this.currentUpload.set(draftId, {
      artifactId: artifact.artifactId,
      resourceUrl: result.resourceUrl,
    });
    return result;
  }

  /** Reserve → upload → persist a session-related artifact (captions / beat manifest / thumbnail). */
  private async uploadRelatedArtifact(
    draftId: string,
    destination: Destination,
    localKey: UploadArtifactKey,
    spec: { filename: string; kind: ArtifactKind; file: File },
    signal: AbortSignal,
  ): Promise<void> {
    const existing = await getUploadArtifact(draftId, localKey);
    const artifactId = existing?.artifactId ?? Crypto.randomUUID();
    if (!existing) await upsertUploadArtifact(draftId, localKey, { artifactId });
    const result = await this.uploadOne(
      draftId,
      destination,
      {
        artifactId,
        filename: spec.filename,
        kind: spec.kind,
        relatedTo: destination.artifactId,
        file: spec.file,
      },
      existing?.resourceUrl ?? null,
      undefined,
      signal,
      undefined,
      // Persist this sub-artifact's resource URL at creation so a kill mid-transfer resumes it via
      // HEAD instead of re-creating (409).
      (url) => void upsertUploadArtifact(draftId, localKey, { artifactId, resourceUrl: url }),
    );
    await upsertUploadArtifact(draftId, localKey, { artifactId, resourceUrl: result.resourceUrl });
  }

  /** The draft's cover: the first clip's persisted jpeg, or a frame from the video. */
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

  /**
   * Upload a pulse: its captions, beat manifest and thumbnail (each `relatedTo` the video), then
   * the video itself — the session anchor, named by the pairing link's `artifactId`.
   */
  private async uploadPulse(session: UploadSession, signal: AbortSignal): Promise<string> {
    const { draftId, destination, segments, merged } = session;
    if (!merged) throw new Error('Export is not ready yet');
    // merged.path is a bare filesystem path on Android (RNVT) — normalize to a file:// URI or the
    // File API rejects it outright ("URI is not absolute").
    const file = new File(toFileUri(merged.path));
    // The draft's title rides the video — the session anchor.
    const draftName = await getDraftName(draftId);
    // Backstop: the persisted export lives in the draft dir (safe from cache sweeps) and the draft
    // is locked while uploading, so a missing file means something outside the app removed it —
    // surface an actionable reason rather than crashing in `bytes()`.
    if (!file.exists) {
      throw new Error(
        'The video is no longer available — reopen the draft to re-export, then upload.',
      );
    }
    const checksum = await md5Checksum(file);

    // The small related artifacts go FIRST. The big video PATCH is the only network step that
    // survives iOS backgrounding (native background URLSession) — JS-driven fetches freeze the
    // moment the app leaves the foreground. With the video last, a backgrounded upload has only
    // the verification HEAD + status write left when the OS wakes the app for the completed
    // background transfer, instead of stalling at "100%" with captions/manifest/thumbnail
    // (all a few KB each) still queued behind a suspended JS thread.

    // Captions: the draft's transcript of the video (hand-edit if present, else auto).
    const row = await getDraftTranscriptRow(draftId);
    const lines = parseTranscriptLines(row?.editedLines ?? row?.lines);
    if (lines.length > 0) {
      this.setLive(draftId, { status: 'uploading', phase: 'captions', progress: 0 });
      await setCaptionsUploadStatus(draftId, 'uploading');
      const vttFile = writeTempTextFile(`${draftId}.vtt`, linesToVtt(lines));
      await this.uploadRelatedArtifact(
        draftId,
        destination,
        'captions',
        { filename: `${draftId}.vtt`, kind: 'captions', file: vttFile },
        signal,
      );
      await setCaptionsUploadStatus(draftId, 'uploaded');
    }

    // Beat manifest: each recorded clip's start/end on the video's timeline (groundwork for HLS).
    this.setLive(draftId, { status: 'uploading', phase: 'manifest', progress: 0 });
    const manifestFile = writeTempTextFile(
      `${draftId}-beats.pulse`,
      JSON.stringify(buildBeatManifest(segments, merged.durationMs)),
    );
    await this.uploadRelatedArtifact(
      draftId,
      destination,
      'manifest',
      { filename: `${draftId}-beats.pulse`, kind: 'project', file: manifestFile },
      signal,
    );

    // Thumbnail (poster frame).
    this.setLive(draftId, { status: 'uploading', phase: 'thumbnail', progress: 0 });
    const thumbFile = await this.resolveThumbnailFile(session, merged.path);
    if (thumbFile) {
      await this.uploadRelatedArtifact(
        draftId,
        destination,
        'thumbnail',
        { filename: `${draftId}.jpg`, kind: 'thumbnail', file: thumbFile },
        signal,
      );
    }

    // The video itself — LAST, so it's the only thing still moving when backgrounded.
    // Throttle progress to at most one store update / 200ms — the native task ticks fast; the
    // final (EOF) tick always goes through so the bar still reaches 100%.
    this.setLive(draftId, { status: 'uploading', phase: 'video', progress: 0 });
    let lastTick = 0;
    const result = await this.uploadOne(
      draftId,
      destination,
      {
        artifactId: destination.artifactId,
        filename: `${draftId}.mp4`,
        kind: 'video',
        name: draftName,
        file,
      },
      destination.resourceUrl,
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
      // Persist the video's resource URL the moment it's created (the anchor lives on the draft
      // row) so an app kill DURING the video transfer resumes via HEAD+PATCH rather than
      // re-creating the upload — which the server rejects as a duplicate reserve (409).
      (url) => void setUploadProgress(draftId, { status: 'uploading', resourceUrl: url }),
    );
    // Re-persist after the video lands (same URL); the final 'uploaded' status write lives in
    // `runSession`, after its displaced-run guard — see the comment there.
    await setUploadProgress(draftId, { status: 'uploading', resourceUrl: result.resourceUrl });
    return result.resourceUrl;
  }
}

/** The app-wide singleton. Imported by `upload-deep-link-provider` so it registers for the app's lifetime. */
export const uploads = new BackgroundUploadManager();

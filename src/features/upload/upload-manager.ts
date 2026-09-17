import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { getInfoAsync } from 'expo-file-system/legacy';

import { deleteDestination, getDestinationIdByArtifactId } from '@/db/destinations';
import {
  getDraftName,
  getDraftUploadStatus,
  getResumableDrafts,
  getUploadArtifact,
  clearUploadResumeRows,
  draftQuery,
  listUploadResumeUrls,
  registerUploadInvalidationHook,
  segmentsForDraft,
  setCaptionsUploadStatus,
  setUploadMerged,
  setUploadProgress,
  type UploadArtifactKey,
  upsertUploadArtifact,
  otherDraftPairedTo,
} from '@/db/drafts';
import type { Draft } from '@/db/schema';
import { getDraftToken } from '@/db/secure-token';
import { getDraftTranscriptRow } from '@/db/transcripts';
import { linesToVtt } from '@/features/transcription/vtt';
import { parseTranscriptLines } from '@/features/transcription/whisper';
import { absolutize, toFileUri } from '@/utils/file-store';
import { generateThumbnailFile } from '@/utils/video';

import { buildBeatManifest } from './beat-manifest';
import { CAPABILITIES_REJECTION_MESSAGE, checkCapabilities } from './capabilities';
import { isTokenExpired } from './capability-token';
import { keepAlive } from './keep-alive';
import { uploadNotify } from './notify';
import { directServerTransport } from './transports/direct-server-transport';
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

/** The server explicitly rejected this client's protocol version — terminal, like pairing. */
class CapabilityMismatchError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityMismatchError';
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
 * (created once at import, exported as `uploads`) that owns a queue of upload
 * sessions and drives them to completion regardless of which screen is mounted
 * or whether the app is foregrounded — the piece that replaces the orchestration
 * that used to live inside the `useUpload` React hook.
 *
 * Durable state (destination, resume identity, status, the merged output path)
 * lives in SQLite; this holds only what SQLite doesn't: the in-flight
 * AbortControllers, the live byte-progress the UI subscribes to (never
 * persisted per-tick), a run-lock, and the enqueued sessions. Because the
 * queue of pending work is really the set of drafts with an `uploading`
 * status in SQLite — and `beginRun` commits the merged output BEFORE that
 * status — a session is crash-safe from the moment it starts: an app kill at
 * any point resumes from launch via `hydrateFromDb`.
 */
class BackgroundUploadManager {
  /**
   * Default transport (TUS) — also the one cancellation/invalidation paths
   * use for server-side cancels: both transports persist handles that a
   * bearer-authorized DELETE frees (a tus resource URL, or the direct
   * profile's artifact URL), and `cancel` is exactly that DELETE.
   */
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
    if (this.inFlight(session.draftId)) return;
    // One live session per destination artifactId: two drafts claiming the same pool
    // destination would race one server-side reservation (whichever POSTs second 409s,
    // and "recovering" it would adopt the OTHER draft's upload). Surface it as a clear
    // terminal error on the later draft instead.
    for (const [otherDraftId, other] of this.sessions) {
      if (
        otherDraftId !== session.draftId &&
        !this.failed.has(otherDraftId) &&
        other.destination.artifactId === session.destination.artifactId
      ) {
        this.setLive(session.draftId, {
          status: 'error',
          reason: 'This upload link is already in use by another draft — pair a new link.',
          retryable: false,
        });
        void setUploadProgress(session.draftId, { status: 'failed' });
        return;
      }
    }
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
    void this.beginRun(session);
  }

  /**
   * Re-run a failed upload. Reuses the in-memory session if present, otherwise reconstructs it from
   * durable state — so the uploads inbox can retry a run that failed before the app was relaunched.
   */
  async retry(draftId: string): Promise<void> {
    if (this.inFlight(draftId)) return;
    let session = this.sessions.get(draftId);
    if (!session) {
      const [row] = await draftQuery(draftId);
      if (!row) return;
      const result = await this.reconstructSession(row);
      if (!result.ok) {
        // Can't rebuild the run (expired token / evicted export) — surface it and release
        // the dead reservations rather than silently no-op, so the user sees a clear
        // reason and can re-pair / re-export.
        await this.settleUnresumable(draftId, result.reason);
        return;
      }
      session = result.session;
    }
    this.failed.delete(draftId);
    this.sessions.set(draftId, session);
    this.setLive(draftId, { status: 'uploading', phase: 'preparing', progress: 0 });
    void this.beginRun(session);
  }

  /**
   * Durable start-of-run sequence for `enqueue`/`retry`, ORDERED: the merged
   * output (path + duration) must commit BEFORE the `'uploading'` status does.
   * `hydrateFromDb` treats an `'uploading'` row without a merged path as
   * unresumable, so the old fire-and-forget pair plus an app kill between the
   * two writes could persist exactly that row and permanently demand a
   * re-export. A failed write settles the draft instead of starting a run
   * whose after-kill guarantee would be broken from the start.
   */
  private async beginRun(session: UploadSession): Promise<void> {
    const { draftId } = session;
    try {
      // Ownership-gated like every mid-run persistence: a structural mutation
      // can displace this session while either write is pending, and a commit
      // landing after the invalidation's sweep must be undone (ownedWrite
      // re-checks and re-sweeps), not hydrated as stale content next launch.
      await this.ownedWrite(draftId, session, () => setUploadMerged(draftId, session.merged));
      await this.ownedWrite(draftId, session, () =>
        setUploadProgress(draftId, { status: 'uploading' }),
      );
    } catch {
      if (this.sessions.get(draftId) === session) {
        this.failed.add(draftId);
        this.setLive(draftId, {
          status: 'error',
          reason: 'Could not save the upload state — try again.',
          retryable: true,
        });
      }
      return;
    }
    void this.ensureRunning();
  }

  /** Abort + server-cancel whatever's in flight for a draft, and drop it from the queue. */
  async cancel(draftId: string): Promise<void> {
    // A COMPLETED upload has nothing to cancel — and resetting its row would strip the
    // 'uploaded' marker that shields the finished server artifacts from the invalidation
    // path (Home calls cancel() right before deleteDraft()). Only bail when nothing is
    // actually live, so the reset keeps un-wedging genuinely stuck rows.
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
   * Whether a draft's upload is already live: running (controller exists) OR
   * queued-but-not-yet-running (a non-failed session waiting on `beginRun`/the
   * drain). Guarding entry points on the controller alone left a pre-run
   * window where a second tap could replace the queued session and race two
   * `beginRun` persistence sequences for one draft.
   */
  private inFlight(draftId: string): boolean {
    return (
      this.controllers.has(draftId) || (this.sessions.has(draftId) && !this.failed.has(draftId))
    );
  }

  /**
   * Rebuild sessions for drafts left mid-upload (status still `uploading`) that aren't already in
   * memory — the after-kill/relaunch resume path. Everything a run needs is reconstructed from
   * durable state: destination + resume URL from the drizzle row, token from secure-store, segments
   * from the clip table, and the merged output from the columns persisted at enqueue. A merged run
   * with no persisted output path (older row) or an expired token is skipped rather than restarted.
   */
  private async hydrateFromDb(): Promise<void> {
    const rows = await getResumableDrafts();
    for (const row of rows) {
      if (this.sessions.has(row.id) || this.controllers.has(row.id)) continue;
      const result = await this.reconstructSession(row);
      if (!result.ok) {
        // Can't resume off-screen (expired token / evicted export / a legacy
        // pre-merged-path row). Settle it to `failed` — and release the server
        // reservations and resume rows it was holding — so the UI surfaces the
        // reason and it stops being re-hydrated on every drain, instead of
        // leaving a perpetual 'uploading' ring that never progresses.
        await this.settleUnresumable(row.id, result.reason);
        continue;
      }
      this.sessions.set(row.id, result.session);
      this.setLive(row.id, { status: 'uploading', phase: 'preparing', progress: 0 });
    }
  }

  /**
   * Settle a draft whose run can't be rebuilt (missing destination, expired
   * token, evicted merged output — including legacy segment-era rows migrated
   * without one) as `failed`, AND release what it was still holding: every
   * persisted resume handle is server-cancelled (fire-and-forget, like
   * `invalidateForMutation`) and the local resume rows are wiped. Without the
   * release, a row settled here kept its server reservations 409-pinned until
   * retention and its `uploadArtifacts` rows pointed at resources no future
   * run could safely resume.
   */
  private async settleUnresumable(draftId: string, reason: string): Promise<void> {
    // Capture the handles BEFORE wiping the rows that hold them.
    const urls = new Set(await listUploadResumeUrls(draftId));
    const token = await getDraftToken(draftId);
    await clearUploadResumeRows(draftId);
    this.setLive(draftId, { status: 'error', reason, retryable: false });
    await setUploadProgress(draftId, { status: 'failed' });
    if (urls.size > 0) {
      // Best-effort: the token may itself be the expired thing — a missed
      // DELETE is the documented un-wedge gap, same as mutation invalidation.
      void Promise.allSettled([...urls].map((u) => this.transport.cancel(u, token)));
    }
  }

  /**
   * Rebuild an upload session from a persisted draft row (destination + token + segments + merged
   * output), or a failure `reason` if it can't be resumed off-screen — a missing destination, an
   * expired token, or a merged run whose native export file is gone.
   */
  private async reconstructSession(
    row: Draft,
  ): Promise<{ ok: true; session: UploadSession } | { ok: false; reason: string }> {
    if (!row.uploadServer || !row.uploadArtifactId) {
      return { ok: false, reason: 'Upload destination is missing — re-pair to upload.' };
    }
    const token = await getDraftToken(row.id);
    if (isTokenExpired(token, Date.now())) return { ok: false, reason: EXPIRED_PAIRING_MESSAGE };
    const merged =
      row.uploadMergedPath && row.uploadMergedDurationMs != null
        ? { path: row.uploadMergedPath, durationMs: row.uploadMergedDurationMs }
        : null;
    if (!merged) {
      return {
        ok: false,
        reason:
          'The merged video is no longer available — reopen the draft to re-export, then upload.',
      };
    }
    const segments = await segmentsForDraft(row.id);
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
    const { draftId, destination } = session;
    const controller = new AbortController();
    this.controllers.set(draftId, controller);
    this.setLive(draftId, { status: 'uploading', phase: 'preparing', progress: 0 });
    // Durable counterpart of enqueue's in-memory duplicate-destination guard:
    // after a restart the sessions map is empty, but a failed draft's pairing
    // survives in the drafts table — running anyway would race one server-side
    // reservation, and 409-adoption could then publish the WRONG draft's video.
    const rival = await otherDraftPairedTo(destination.artifactId, draftId);
    // A cancel or mutation invalidation can remove this session while the rival
    // check was in flight — it owns all state from that moment, so neither the
    // rival branch's 'failed' nor the 'uploading' transition below may land on
    // top of its reset. (The controller cleanup in `finally` still runs.)
    if (this.sessions.get(draftId) !== session || controller.signal.aborted) {
      this.controllers.delete(draftId);
      return;
    }
    if (rival) {
      this.controllers.delete(draftId);
      // Settle as failed like any terminal run error — without this the drain
      // would re-pick the session forever (it's neither running nor failed).
      this.failed.add(draftId);
      this.setLive(draftId, {
        status: 'error',
        reason: 'This upload link is already in use by another draft — pair a new link.',
        retryable: false,
      });
      await setUploadProgress(draftId, { status: 'failed' });
      return;
    }
    await this.ownedWrite(draftId, session, () =>
      setUploadProgress(draftId, { status: 'uploading' }),
    );
    try {
      // Transport per run: servers advertising the direct-upload profile get
      // presigned PUTs (bytes bypass the app server); everything else —
      // including an unreachable /capabilities probe (offline → the retry
      // loop inside the transport owns connectivity errors) — uses TUS.
      const transport = await this.resolveTransport(draftId, destination);
      const resourceUrl = await this.uploadMerged(session, transport, controller.signal);
      // Displaced-run guard BEFORE any terminal write: if a mutation invalidation swapped this
      // session out while the final transfer was resolving, resurrecting 'uploaded'/'done' here
      // would stamp completion onto a draft whose content just changed — the invalidation owns
      // all state from the moment it removed this run from the map.
      if (this.sessions.get(draftId) !== session) return;
      // Persist completion here (not inside uploadMerged) so the row always settles to
      // 'uploaded' in one place, right next to the displaced-run guard above.
      await setUploadProgress(draftId, { status: 'uploaded', resourceUrl });
      // The write itself can straddle an invalidation: ownership held at the guard, the
      // mutation swept the draft while the UPDATE was in flight, and the commit then
      // stamped 'uploaded' onto changed content (the sweep skips rows already marked
      // uploaded, so it can't undo this write itself). Re-check and compensate with the
      // reset the invalidation would have applied.
      if (this.sessions.get(draftId) !== session) {
        await setUploadProgress(draftId, { status: 'idle', resourceUrl: null });
        await clearUploadResumeRows(draftId);
        return;
      }
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
      // Every branch below is identity-guarded: an invalidation/cancel may have cleared the
      // maps AND a fresh session for the same draft may have been enqueued inside the abort
      // window — a displaced run must neither tear down the fresh run's entries nor write
      // its own terminal state over it.
      if (err instanceof Error && err.name === 'AbortError') {
        // Cancelled via cancel()/invalidation — that path owns resetting status/live to idle;
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

  /**
   * A structural draft mutation is about to wipe this draft's upload resume state (see
   * `registerUploadInvalidationHook`): abort anything in flight so a stale-snapshot session
   * can't finish and write 'uploaded' onto the changed draft, and server-cancel every
   * persisted TUS reservation so a fresh session's re-creates under the same artifactIds
   * can't 409. The cancels are fire-and-forget — a UI edit must not block on the network;
   * a missed DELETE surfaces as a visible retry failure (the documented un-wedge gap).
   */
  async invalidateForMutation(draftId: string): Promise<void> {
    // Capture the in-flight resource BEFORE clearing the map — its URL may not have reached
    // SQLite yet (the persistence callbacks are async), and it must still be cancelled.
    const current = this.currentUpload.get(draftId)?.resourceUrl ?? null;
    this.controllers.get(draftId)?.abort();
    const session = this.sessions.get(draftId);
    this.sessions.delete(draftId);
    this.failed.delete(draftId);
    this.controllers.delete(draftId);
    this.currentUpload.delete(draftId);
    this.setLive(draftId, { status: 'idle' });
    // Capture the URLs before the caller wipes the rows.
    const urls = new Set(await listUploadResumeUrls(draftId));
    if (current) urls.add(current);
    if (urls.size === 0) return;
    const token = session?.destination.token ?? (await getDraftToken(draftId));
    void Promise.allSettled([...urls].map((u) => this.transport.cancel(u, token)));
  }

  /**
   * Pick the transport for one run by probing `/capabilities`. Direct upload
   * is an opt-in the server advertises; anything else falls back to TUS, which
   * is always served. Probed per run (not persisted at pairing) so a server
   * upgrade or rollback takes effect on the next upload without re-pairing.
   */
  private async resolveTransport(
    draftId: string,
    destination: Destination,
  ): Promise<UploadTransport> {
    const result = await checkCapabilities(destination.server);
    if (result.ok) {
      if (!result.capabilities.directUpload) return this.transport;
      // Advertised direct upload does NOT move a run that already holds TUS
      // resume state: profiles share the artifactId space, so a direct grant
      // for an id with a live TUS reservation is a hard 409 (a TUS reservation
      // is never same-shape re-grantable) — the run would wedge terminally,
      // and even a successful switch would throw away mid-file TUS progress.
      // The upgraded server keeps serving TUS; fresh runs pick up direct.
      if (await this.hasTusResumeIdentity(draftId)) return this.transport;
      return directServerTransport;
    }
    if (result.reason !== 'unreachable') {
      // The server answered and refused this client's protocol version. Pairing
      // rejects that combination outright — silently downgrading the run to TUS
      // would sidestep the same contract, so it's a terminal error instead.
      throw new CapabilityMismatchError(CAPABILITIES_REJECTION_MESSAGE[result.reason]);
    }
    // Unreachable probe (offline / server down). A draft already holding a
    // direct-profile identity must stay on the direct transport: TUS cannot
    // resume an `/artifacts/…` handle (profiles never share resume identities),
    // and the direct client's connectivity errors are retryable, so the run
    // waits out the outage exactly like TUS would. Fresh drafts fall to TUS.
    if (await this.hasDirectResumeIdentity(draftId, destination.server)) {
      return directServerTransport;
    }
    return this.transport;
  }

  /** True if any persisted resume URL for this draft is a direct-profile artifact handle. */
  private async hasDirectResumeIdentity(draftId: string, server: string): Promise<boolean> {
    const prefix = `${server.replace(/\/+$/, '')}/artifacts/`;
    const urls = await listUploadResumeUrls(draftId);
    return urls.some((u) => u.startsWith(prefix));
  }

  /** True if any persisted resume URL is a live TUS resource (anything that isn't an `/artifacts/` handle) — the mirror of `hasDirectResumeIdentity` for the upgrade direction. */
  private async hasTusResumeIdentity(draftId: string): Promise<boolean> {
    const urls = await listUploadResumeUrls(draftId);
    return urls.some((u) => !u.includes('/artifacts/'));
  }

  private async uploadOne(
    transport: UploadTransport,
    draftId: string,
    destination: Destination,
    artifact: ArtifactInput,
    resourceUrl: string | null,
    checksum: string | undefined,
    signal: AbortSignal,
    onProgress?: (progress: UploadProgress) => void,
    // Fired the instant the server assigns a resource URL — AWAITED by the transport before
    // any byte moves, so the caller's persist is durable first. WITHOUT this the resume path
    // has no handle after a kill and re-creates the upload, which the server rejects as a
    // duplicate reserve (409) — recoverable now via the client's derive-and-resume, but the
    // durable handle stays the primary mechanism.
    persistResourceUrl?: (url: string) => void | Promise<void>,
  ): Promise<{ resourceUrl: string }> {
    // Re-checked before every artifact (not just at the start of a run) — a token fine at the
    // start can go stale partway through a session.
    if (isTokenExpired(destination.token, Date.now())) throw new ExpiredPairingError();
    // Profiles never share resume identities: a persisted direct handle
    // (`/artifacts/{id}`) is meaningless to TUS — HEADing it yields no
    // Upload-Offset and the run wedges. If a capability rollback dropped this
    // run to TUS after a direct attempt, discard the handle and create fresh.
    if (transport !== directServerTransport && resourceUrl?.includes('/artifacts/')) {
      resourceUrl = null;
    }
    this.currentUpload.set(draftId, { artifactId: artifact.artifactId, resourceUrl });
    const result = await transport.run({
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
      onResourceCreated: async (url) => {
        this.currentUpload.set(draftId, { artifactId: artifact.artifactId, resourceUrl: url });
        await persistResourceUrl?.(url);
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
    transport: UploadTransport,
    session: UploadSession,
    localKey: UploadArtifactKey,
    spec: { filename: string; kind: ArtifactKind; file: File },
    signal: AbortSignal,
  ): Promise<void> {
    const { draftId, destination } = session;
    const existing = await getUploadArtifact(draftId, localKey);
    const artifactId = existing?.artifactId ?? Crypto.randomUUID();
    // Every persist below is ownership-gated, exactly like the video's resume-URL
    // writes: a run displaced by mutation invalidation must not re-land artifact
    // rows the invalidation wiped — a later run could otherwise resume/adopt a
    // server resource holding the OLD content's bytes.
    if (!existing) {
      await this.ownedWrite(draftId, session, () =>
        upsertUploadArtifact(draftId, localKey, { artifactId }),
      );
    }
    const result = await this.uploadOne(
      transport,
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
      // Persist this sub-artifact's resource URL at creation — awaited by the transport before
      // the first byte moves — so a kill mid-transfer resumes it via HEAD instead of re-creating.
      this.ownedPersist(draftId, session, (url) =>
        upsertUploadArtifact(draftId, localKey, { artifactId, resourceUrl: url }),
      ),
    );
    await this.ownedWrite(draftId, session, () =>
      upsertUploadArtifact(draftId, localKey, { artifactId, resourceUrl: result.resourceUrl }),
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

  /** True while `session` still owns its draft's slot — persistence callbacks are gated on
   * this so a run displaced by mutation invalidation can't write stale resume URLs back. */
  private owns(draftId: string, session: UploadSession): boolean {
    return this.sessions.get(draftId) === session;
  }

  /**
   * Ownership-gated write — the general shape behind every mid-run persistence:
   * runs `write` only while `session` still owns the draft's slot, and undoes a
   * write that straddled an invalidation. The write itself can commit AFTER an
   * invalidation swept the resume rows (ownership held at the check, lost during
   * the await) — re-landing stale handles a later run could resume old bytes
   * from — so ownership is re-checked after the commit and the sweep re-applied.
   * Worst case the re-sweep also catches a newer session's freshly persisted
   * URL — that only costs it restart-resume (the live run keeps its in-memory
   * handle), never correctness.
   */
  private async ownedWrite(
    draftId: string,
    session: UploadSession,
    write: () => Promise<unknown>,
  ): Promise<void> {
    if (!this.owns(draftId, session)) return;
    await write();
    if (!this.owns(draftId, session)) await clearUploadResumeRows(draftId);
  }

  /**
   * Ownership-gated persistence callback: `ownedWrite` in the `(url) => …`
   * shape every resume-URL persist takes — a displaced run must not resurrect
   * state the invalidation wiped.
   */
  private ownedPersist(
    draftId: string,
    session: UploadSession,
    write: (url: string) => Promise<unknown>,
  ): (url: string) => Promise<void> {
    return (url) => this.ownedWrite(draftId, session, () => write(url));
  }

  private async uploadMerged(
    session: UploadSession,
    transport: UploadTransport,
    signal: AbortSignal,
  ): Promise<string> {
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
      await setCaptionsUploadStatus(draftId, 'uploading');
      const vttFile = writeTempTextFile(`${draftId}.vtt`, linesToVtt(lines));
      await this.uploadRelatedArtifact(
        transport,
        session,
        'captions',
        { filename: `${draftId}.vtt`, kind: 'captions', file: vttFile },
        signal,
      );
      await setCaptionsUploadStatus(draftId, 'uploaded');
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
      'manifest',
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
      // Persist the video's resource URL the moment it's created (the merged anchor lives on the
      // draft row) — awaited by the transport before the first byte moves — so an app kill DURING
      // the video transfer resumes via HEAD+PATCH rather than re-creating the upload.
      this.ownedPersist(draftId, session, (url) =>
        setUploadProgress(draftId, { status: 'uploading', resourceUrl: url }),
      ),
    );
    // Re-persist after the video lands (same URL); the final 'uploaded' status write lives in
    // `runSession`, not here — see the comment there.
    if (this.owns(draftId, session)) {
      await setUploadProgress(draftId, { status: 'uploading', resourceUrl: result.resourceUrl });
    }
    return result.resourceUrl;
  }
}

/** The app-wide singleton. Imported by `upload-deep-link-provider` so it registers for the app's lifetime. */
export const uploads = new BackgroundUploadManager();

// Structural draft mutations (delete/edit/reset/reorder in db/drafts) invalidate upload resume
// state through this hook — registered here so the db layer never imports the upload feature.
registerUploadInvalidationHook((draftId) => uploads.invalidateForMutation(draftId));

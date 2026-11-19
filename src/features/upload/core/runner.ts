import { eq } from 'drizzle-orm';
import { File } from 'expo-file-system';
import { getInfoAsync } from 'expo-file-system/legacy';
import { AppState } from 'react-native';

import { subscribeNetwork, waitingForNetwork } from '@/core/network';
import { db } from '@/db/client';
import { draftDisplayName } from '@/db/drafts';
import { hostContextOf } from '@/db/host-context';
import { wifiOnlyUploads } from '@/db/local-settings';
import { drafts } from '@/db/schema';
import {
  getUploadJob,
  listUploadJobs,
  parseParts,
  subscribeUploadJobs,
  type UploadJob,
  type UploadPart,
} from '@/db/upload-jobs';
import { absolutize } from '@/utils/file-store';

import { clientHeaders } from './client-identity';
import {
  getUploadTarget,
  HostRequestError,
  refreshUploadToken,
  uploadToken,
  type HostPlace,
  type HostUploadTarget,
  type TokenRequest,
  type TokenResult,
  type UploadTargetRequest,
} from './host-services';
import {
  attachRunningUpload,
  cancelOrphanedUploadTasks,
  uploadChunkNative,
} from './native-chunk-upload';
import {
  applyTransition,
  hostErrorEvent,
  recoverInterruptedSends,
  resumePausedJobs,
  type JobEvent,
} from './outbox';
import { finishRetirements, retireDelivered, type DeliveryOutcome } from './retire';
import { TusUploadError, uploadViaTus, type ArtifactKind, type UploadChunk } from './tus-client';
import { describeError, shortId, uploadLog, type UploadLog } from './upload-log';

// The embedded upload outbox's job loop (PLAN §6.1–6.3, E3–E5, AD6, AD9). It drives each job the
// outbox (outbox.ts) holds through its states, and owns nothing persistent itself: every step is an
// outbox event, written before the next one starts, so a kill anywhere resumes from the rows.
//
//   queued      ask the host for a target (getUploadTarget; `renewArtifact` after a 404), check
//               that it echoes this job's clientKey, then upload
//   uploading   the parts in order (captions, manifest, thumbnail, then the video) over TUS with
//               the target's token: each part's upload URL is written as soon as it exists, so a
//               relaunch HEADs it and resumes rather than creating another
//   delivering  poll the status route (foreground only) until the host's outcome, then retire
//
// Errors: a retryable failure goes back to `queued` with backoff; `destination.gone`,
// `upload.refused`, `upload.too_large` and a host that answers for another upload fail the job;
// a create that meets an unfinished upload of the same artifact (its 201 was lost, or a kill came
// after the server made it) waits until PulseVault reclaims that idle upload (`upload.conflict`);
// an expired or refused token is refreshed once (`refreshUploadToken`), and a host that doesn't
// answer pauses the job (`needs_credentials`). A 404 from PulseVault (it forgot the artifact, e.g.
// after its 24 h partial-upload retention) asks the host again with `renewArtifact`.
//
// Launch rule (§6.3), at boot and on `resumeOutbox`: Sends that stopped while preparing go back to
// drafts; retirements a kill interrupted are finished; background upload tasks that belong to no
// live job are cancelled (a live job's task carries on, and the job waits for it before its HEAD);
// each uploading job asks the status route first, then HEADs and resumes. `boot` and
// `resumeOutbox` resolve once those steps are done; the uploads themselves go on after.

/** Tokens this close to expiry are refreshed before use. */
export const TOKEN_MARGIN_MS = 60_000;
/** Progress events per draft at most this often (≤ 4/s). */
export const PROGRESS_INTERVAL_MS = 250;
/** `bytes_sent` written at most this often while the video uploads. */
export const PERSIST_INTERVAL_MS = 5_000;
/** The status route is polled first after this, then less often, up to `POLL_MAX_MS`. */
export const POLL_BASE_MS = 3_000;
export const POLL_MAX_MS = 60_000;
/**
 * How long a create that met an unfinished upload of the same artifact waits: PulseVault reclaims
 * such an upload only once it has been idle this long (its `reclaim.idleSeconds`, 300 by
 * default), and answers 409 until then. A margin on top for clocks.
 */
export const CREATE_CONFLICT_RETRY_MS = 5 * 60_000 + 15_000;

/** How the runner reaches the host: the host-service channel by default, a fake in tests. */
export type RunnerHost = {
  getUploadTarget(r: UploadTargetRequest): Promise<HostUploadTarget>;
  refreshUploadToken(r: TokenRequest): Promise<TokenResult>;
  /** The token held in memory for `uploadId`, if any (never on disk, AD7). */
  token(uploadId: string): TokenResult | null;
};

export type RunnerDeps = {
  host: RunnerHost;
  /** Headers-only requests: TUS create and HEAD, and the status route. */
  fetchImpl: typeof fetch;
  /** The byte-carrying PATCH. */
  uploadChunk: UploadChunk;
  /** Cancels background upload tasks of uploads not in `live` (§6.3 step 1). */
  cancelOrphans: (live: readonly string[]) => Promise<number>;
  /**
   * Waits for a background task still sending to `url` (§6.3: reattach), before the upload is
   * HEADed; null at once when there is none. `onProgress` gets the upload's offset.
   */
  attachRunning: (
    url: string,
    file: File,
    opts: { signal?: AbortSignal; onProgress?: (offset: number) => void },
  ) => Promise<{ status: number } | null>;
  /** A part's file, from its path relative to the documents root. */
  openFile: (rel: string) => File;
  /** The video's `md5:<hex>`, sent when its upload is created. */
  checksum: (file: File) => Promise<string | undefined>;
  /** Whether the host app is in the foreground: status polling runs only then. */
  isForeground: () => boolean;
  /** Whether uploads may use the network now (online, and on Wi-Fi when that's required). */
  canUpload: () => boolean;
  now: () => number;
  log: UploadLog;
};

/** An upload's progress, for the host's `uploadProgress` events. */
export type UploadProgress = { draftId: string; bytesSent: number; bytesTotal: number };

const ROLE_ORDER: Record<UploadPart['role'], number> = {
  captions: 0,
  manifest: 1,
  thumbnail: 2,
  video: 3,
};
const KIND: Record<UploadPart['role'], ArtifactKind> = {
  captions: 'captions',
  manifest: 'project',
  thumbnail: 'thumbnail',
  video: 'video',
};
const FILENAME: Record<UploadPart['role'], (draftId: string) => string> = {
  captions: (id) => `${id}.vtt`,
  manifest: (id) => `${id}-beats.pulse`,
  thumbnail: (id) => `${id}.jpg`,
  video: (id) => `${id}.mp4`,
};

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';
/** tus-client's create answered 409: the artifact id already has an upload (PROTOCOL.md §6.5). */
const isCreateConflict = (e: unknown) =>
  e instanceof TusUploadError && e.statusCode === 409 && !e.retryable;

async function md5Of(file: File): Promise<string | undefined> {
  const info = await getInfoAsync(file.uri, { md5: true });
  return info.exists && info.md5 ? `md5:${info.md5}` : undefined;
}

const DEFAULT_DEPS: RunnerDeps = {
  host: { getUploadTarget, refreshUploadToken, token: uploadToken },
  fetchImpl: (...args) => fetch(...args),
  uploadChunk: uploadChunkNative,
  cancelOrphans: (live) => cancelOrphanedUploadTasks(live),
  attachRunning: attachRunningUpload,
  openFile: (rel) => new File(absolutize(rel)),
  checksum: md5Of,
  isForeground: () => AppState.currentState === 'active',
  canUpload: () => !waitingForNetwork(wifiOnlyUploads()),
  now: () => Date.now(),
  log: uploadLog,
};

/** What the status route says about an artifact (PROTOCOL.md §6.5). */
type StatusAnswer =
  | { kind: 'ok'; state: string; outcome: DeliveryOutcome | null }
  | { kind: 'refused' }
  | { kind: 'unavailable'; message: string };

function outcomeOf(value: unknown): DeliveryOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o.state !== 'done' && o.state !== 'kept') return null;
  return {
    state: o.state,
    note: typeof o.note === 'string' ? o.note : null,
    reason: typeof o.reason === 'string' ? o.reason : null,
  };
}

export type JobRunner = {
  /** One pass over the draft's job: as far as it can go now. */
  runJob(draftId: string): Promise<void>;
  /** Every job that can move now, one at a time, until none can. */
  drain(): Promise<void>;
  /**
   * The launch rule (§6.3): at runtime start. Resolves once its steps are done (seconds at most);
   * the jobs then run without being awaited (`idle()` waits for them).
   */
  boot(): Promise<void>;
  /** The host's `resumeOutbox()`: paused jobs are queued again, then the launch rule. */
  resumeOutbox(): Promise<void>;
  /** Resolves when no pass is running (tests, and anything that must wait for the uploads). */
  idle(): Promise<void>;
  /**
   * Whether this runtime's namespace is the signed-in account's. While it isn't, no job runs and
   * an upload under way stops (it resumes from the server's offset later); once it is again, the
   * jobs run (when started).
   */
  setAccountActive(active: boolean): void;
  /** Follow the foreground, the network and the outbox; returns the stop. */
  start(): () => void;
  /** Progress of the video uploads, at most 4 per second per draft. Returns the unsubscribe. */
  subscribeProgress(listener: (p: UploadProgress) => void): () => void;
};

/** Make a job runner; tests pass fakes for any dependency. */
export function createJobRunner(overrides: Partial<RunnerDeps> = {}): JobRunner {
  const deps: RunnerDeps = { ...DEFAULT_DEPS, ...overrides };
  const { host, log } = deps;

  let accountActive = true;
  /** Drafts whose next upload pass asks the status route first (set by the launch rule). */
  const statusFirst = new Set<string>();
  /** When each delivering draft is polled next, and how many polls it has had. */
  const polls = new Map<string, { at: number; n: number }>();
  /** The pass under way for each draft, and how to stop it. */
  const running = new Map<string, { clientKey: string; abort: AbortController }>();
  const progressListeners = new Set<(p: UploadProgress) => void>();
  const lastProgress = new Map<string, number>();

  let draining: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  // -- writes ------------------------------------------------------------------------------------

  /**
   * Apply `event` to the draft's job only if it is still the job this pass started with (same
   * clientKey): a cancel, an edit and a new Send replace the row, and a late write from the old
   * pass must not land on the new one. Synchronous from the check to the commit.
   */
  function apply(job: UploadJob, event: JobEvent): UploadJob | null {
    const current = getUploadJob(job.draftId);
    if (!current || current.clientKey !== job.clientKey) return null;
    const t = applyTransition(job.draftId, event, { now: deps.now() });
    if (t.kind === 'ignore' || t.kind === 'refuse') {
      log.info(`job ${shortId(job.draftId)}: ${event.type} not applied (${t.message})`);
    }
    return getUploadJob(job.draftId);
  }

  function emitProgress(draftId: string, bytesSent: number, bytesTotal: number, force = false) {
    const now = deps.now();
    if (!force && now - (lastProgress.get(draftId) ?? -Infinity) < PROGRESS_INTERVAL_MS) return;
    lastProgress.set(draftId, now);
    for (const listener of [...progressListeners]) {
      try {
        listener({ draftId, bytesSent, bytesTotal });
      } catch (e) {
        log.warn(`a progress listener failed: ${describeError(e)}`);
      }
    }
  }

  // -- the host ----------------------------------------------------------------------------------

  function draftFor(draftId: string) {
    return (
      db
        .select({
          name: drafts.name,
          contextKey: drafts.contextKey,
          contextLabel: drafts.contextLabel,
          contextJson: drafts.contextJson,
          uploadTypeJson: drafts.uploadTypeJson,
          mergedDurationMs: drafts.mergedDurationMs,
        })
        .from(drafts)
        .where(eq(drafts.id, draftId))
        .get() ?? null
    );
  }

  /**
   * Ask the host for the job's target (`renew`: PulseVault forgot the artifact). Returns the job
   * as the answer left it, or null when the pass ends here (the failure is written).
   */
  async function askTarget(job: UploadJob, renew: boolean): Promise<UploadJob | null> {
    const draft = draftFor(job.draftId);
    const place = draft ? hostContextOf(draft) : null;
    if (!draft || !place) {
      apply(job, {
        type: 'permanentError',
        code: 'host_misconfigured',
        message: 'The draft has no place to send it to.',
      });
      return null;
    }
    let target: HostUploadTarget;
    try {
      target = await host.getUploadTarget({
        draftId: job.draftId,
        clientKey: job.clientKey,
        draftKey: job.draftKey,
        context: place as HostPlace,
        name: draftDisplayName(draft.name, draft.contextLabel),
        durationMs: draft.mergedDurationMs ?? 0,
        bytes: job.bytesTotal ?? 0,
        sentAt: job.sentAt,
        attempt: renew ? job.attempts : job.attempts + 1,
        renewArtifact: renew,
      });
    } catch (e) {
      log.warn(`job ${shortId(job.draftId)}: no upload target: ${describeError(e)}`);
      apply(job, hostErrorEvent(e));
      return null;
    }
    if (target.clientKey !== job.clientKey) {
      log.warn(`job ${shortId(job.draftId)}: the host answered for another upload`);
      apply(job, {
        type: 'permanentError',
        code: 'host_misconfigured',
        message: 'The host answered with an upload for another Send.',
      });
      return null;
    }
    log.info(
      `job ${shortId(job.draftId)}: target ${shortId(target.uploadId)}` +
        `${renew ? ' (renewed artifact)' : ''}${target.state ? `, server says ${target.state}` : ''}`,
    );
    return apply(job, {
      type: 'targetAnswered',
      uploadId: target.uploadId,
      artifactId: target.artifactId,
      endpoint: target.endpoint,
      tokenExp: target.expiresAt,
      state: target.state,
    });
  }

  /**
   * The job's token: the one in memory while it's fresh, else a refreshed one (`force`: the server
   * refused the one in memory). Null when the pass ends here: a host that doesn't answer pauses
   * the job, and a refusal is written as the host's error.
   */
  async function tokenFor(job: UploadJob, force = false): Promise<string | null> {
    if (!job.uploadId) return null;
    const held = host.token(job.uploadId);
    if (!force && held && held.expiresAt - deps.now() > TOKEN_MARGIN_MS) return held.token;
    try {
      const fresh = await host.refreshUploadToken({
        uploadId: job.uploadId,
        clientKey: job.clientKey,
        draftId: job.draftId,
      });
      apply(job, { type: 'tokenRefreshed', tokenExp: fresh.expiresAt });
      return fresh.token;
    } catch (e) {
      log.warn(`job ${shortId(job.draftId)}: token not refreshed: ${describeError(e)}`);
      const event = hostErrorEvent(e);
      // A token that ran out with nobody to refresh it: waiting for credentials, not for a host.
      apply(
        job,
        event.type === 'credentialsLost' && e instanceof HostRequestError && e.unanswered
          ? { ...event, code: 'credentials.expired' }
          : event,
      );
      return null;
    }
  }

  // -- PulseVault --------------------------------------------------------------------------------

  async function status(
    endpoint: string,
    artifactId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<StatusAnswer> {
    try {
      const res = await deps.fetchImpl(`${endpoint}/artifacts/${artifactId}/status`, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          ...clientHeaders(),
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-cache',
        },
      });
      if (res.status === 401 || res.status === 403) return { kind: 'refused' };
      if (res.status !== 200) {
        return { kind: 'unavailable', message: `The status route answered ${res.status}` };
      }
      const body = (await res.json()) as { state?: unknown; outcome?: unknown };
      return {
        kind: 'ok',
        state: typeof body.state === 'string' ? body.state : 'unknown',
        outcome: outcomeOf(body.outcome),
      };
    } catch (e) {
      if (isAbort(e)) throw e;
      return { kind: 'unavailable', message: describeError(e) };
    }
  }

  /** The status route, with one refresh when it refuses the token. */
  async function statusWithRefresh(
    job: UploadJob,
    token: string,
    signal?: AbortSignal,
  ): Promise<StatusAnswer | null> {
    const artifactId = job.artifactId;
    if (!job.endpoint || !artifactId) return null;
    const first = await status(job.endpoint, artifactId, token, signal);
    if (first.kind !== 'refused') return first;
    const fresh = await tokenFor(job, true);
    if (!fresh) return null;
    return status(job.endpoint, artifactId, fresh, signal);
  }

  /** How a failed part ends the pass, or what to do about it. */
  type Failure =
    { kind: 'refresh' } | { kind: 'renew' } | { kind: 'event'; event: JobEvent } | { kind: 'stop' };

  function classify(e: unknown): Failure {
    if (isAbort(e)) return { kind: 'stop' };
    const message = describeError(e);
    if (e instanceof TusUploadError) {
      const code = e.statusCode;
      if (code === 401 || code === 403) return { kind: 'refresh' };
      if (code === 404 || code === 410) return { kind: 'renew' };
      if (code === 413) {
        return {
          kind: 'event',
          event: { type: 'permanentError', code: 'upload.too_large', message },
        };
      }
      if (!e.retryable) {
        return {
          kind: 'event',
          event: { type: 'permanentError', code: 'upload.refused', message },
        };
      }
    }
    return { kind: 'event', event: { type: 'retryableError', code: 'upload.failed', message } };
  }

  /**
   * Upload the job's parts that aren't done, in order. The pass ends when the video is done
   * (`delivering`), on a failure (written), or when the job changes under it.
   */
  async function upload(start: UploadJob, signal: AbortSignal): Promise<void> {
    let job = start;
    let token = await tokenFor(job);
    if (!token || signal.aborted) return;

    if (statusFirst.delete(job.draftId)) {
      // After a relaunch: the video may have landed while Pulse wasn't running.
      const answer = await statusWithRefresh(job, token, signal).catch(() => null);
      if (signal.aborted) return;
      if (answer?.kind === 'ok' && (answer.state === 'processing' || answer.state === 'ready')) {
        log.info(`job ${shortId(job.draftId)}: the server has the video already`);
        const parts = parseParts(job.partsJson).map((p) => ({ ...p, done: true }));
        apply(job, { type: 'videoDone', parts });
        return;
      }
      // A refresh that failed wrote its outcome (paused, retry or failed): this pass ends there,
      // rather than sending the refused token and asking the host a second time.
      const current = getUploadJob(job.draftId);
      if (current?.clientKey !== job.clientKey || current.state !== 'uploading') return;
      job = current;
      token = host.token(job.uploadId ?? '')?.token ?? token;
    }

    let refreshed = false;
    let renewed = false;
    let parts = sortedParts(job);
    let i = 0;
    let lastPersist = deps.now();
    while (i < parts.length) {
      if (signal.aborted) return;
      const part = parts[i];
      if (part.done) {
        i++;
        continue;
      }
      const video = parts.find((p) => p.role === 'video');
      const file = deps.openFile(part.file);
      if (!part.artifactId || !video?.artifactId || !job.endpoint) {
        apply(job, {
          type: 'retryableError',
          code: 'upload.failed',
          message: 'The upload target is incomplete.',
        });
        return;
      }
      if (!file.exists) {
        apply(job, {
          type: 'permanentError',
          code: 'upload.refused',
          message: `The ${part.role} file is gone from the draft.`,
        });
        return;
      }
      const isVideo = part.role === 'video';
      const name = isVideo ? (draftFor(job.draftId)?.name ?? undefined) : undefined;
      try {
        if (part.tusUrl) await attachRunning(job, part, file, signal);
        if (signal.aborted) return;
        const result = await uploadViaTus({
          server: job.endpoint,
          token,
          artifactId: part.artifactId,
          filename: FILENAME[part.role](job.draftId),
          kind: KIND[part.role],
          relatedTo: isVideo ? undefined : video.artifactId,
          checksum: isVideo && !part.tusUrl ? await deps.checksum(file) : undefined,
          name,
          file,
          resumeUrl: part.tusUrl ?? undefined,
          signal,
          fetchImpl: deps.fetchImpl,
          uploadChunk: deps.uploadChunk,
          log,
          onResourceCreated: (url) => {
            // Written before any byte moves: a relaunch resumes this upload, never makes another.
            parts = parts.map((p, j) => (j === i ? { ...p, tusUrl: url } : p));
            job = apply(job, { type: 'partsProgress', parts }) ?? job;
          },
          onProgress: isVideo
            ? ({ bytesSent, totalBytes }) => {
                emitProgress(job.draftId, bytesSent, totalBytes);
                if (deps.now() - lastPersist < PERSIST_INTERVAL_MS) return;
                lastPersist = deps.now();
                job = apply(job, { type: 'partsProgress', parts, bytesSent }) ?? job;
              }
            : undefined,
        });
        parts = parts.map((p, j) =>
          j === i ? { ...p, tusUrl: result.resourceUrl, done: true } : p,
        );
        if (isVideo) {
          emitProgress(job.draftId, part.bytes, part.bytes, true);
          log.info(`job ${shortId(job.draftId)}: video done; waiting for the host's outcome`);
          apply(job, { type: 'videoDone', parts });
          return;
        }
        const next = apply(job, { type: 'partsProgress', parts });
        if (!next || next.state !== 'uploading') return;
        job = next;
        i++;
      } catch (e) {
        if (signal.aborted || isAbort(e)) return;
        if (isCreateConflict(e) && !parts[i].tusUrl) {
          // Our own create, made before a kill or with its 201 lost: PulseVault takes it over once
          // it has been idle long enough, and answers 409 until then (not a refusal).
          log.warn(
            `job ${shortId(job.draftId)}: the ${part.role} upload exists without its URL; ` +
              'trying again once the server can reclaim it',
          );
          apply(job, {
            type: 'retryableError',
            code: 'upload.conflict',
            message: describeError(e),
            retryAfterMs: CREATE_CONFLICT_RETRY_MS,
          });
          return;
        }
        const failure = classify(e);
        if (failure.kind === 'stop') return;
        if (failure.kind === 'refresh' && !refreshed) {
          refreshed = true;
          const fresh = await tokenFor(job, true);
          if (!fresh) return;
          token = fresh;
          continue;
        }
        if (failure.kind === 'renew' && !renewed) {
          renewed = true;
          log.warn(`job ${shortId(job.draftId)}: the server lost the ${part.role}; renewing`);
          const next = await askTarget(job, true);
          if (!next || next.state !== 'uploading' || signal.aborted) return;
          job = next;
          token = host.token(job.uploadId ?? '')?.token ?? token;
          parts = sortedParts(job);
          i = 0;
          continue;
        }
        const event: JobEvent =
          failure.kind === 'event'
            ? failure.event
            : failure.kind === 'refresh'
              ? { type: 'permanentError', code: 'upload.refused', message: describeError(e) }
              : { type: 'retryableError', code: 'upload.failed', message: describeError(e) };
        log.warn(`job ${shortId(job.draftId)}: ${part.role} failed: ${describeError(e)}`);
        apply(job, event);
        return;
      }
    }
  }

  /**
   * §6.3 step 1: a background task iOS kept sending this part's bytes is waited for before the
   * HEAD (PulseVault's HEAD takes the upload's lock and would cut it). Its outcome doesn't matter
   * here: the HEAD that follows says where the upload is.
   */
  async function attachRunning(
    job: UploadJob,
    part: UploadPart,
    file: File,
    signal: AbortSignal,
  ): Promise<void> {
    if (!part.tusUrl) return;
    try {
      const ended = await deps.attachRunning(part.tusUrl, file, {
        signal,
        onProgress:
          part.role === 'video'
            ? (offset) => emitProgress(job.draftId, Math.min(offset, part.bytes), part.bytes)
            : undefined,
      });
      if (ended) {
        log.info(
          `job ${shortId(job.draftId)}: the ${part.role}'s background task ended (${ended.status})`,
        );
      }
    } catch (e) {
      if (isAbort(e)) return;
      log.info(`job ${shortId(job.draftId)}: no background task to wait for: ${describeError(e)}`);
    }
  }

  function sortedParts(job: UploadJob): UploadPart[] {
    return parseParts(job.partsJson).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  }

  /** One poll of a delivering job's status route; retires it on an outcome. */
  async function poll(job: UploadJob, signal: AbortSignal): Promise<void> {
    const due = polls.get(job.draftId);
    if (due && due.at > deps.now()) return;
    const token = await tokenForDelivery(job);
    const answer = token ? await statusWithRefresh(job, token, signal) : null;
    if (signal.aborted) return;
    if (answer?.kind === 'ok' && answer.outcome) {
      polls.delete(job.draftId);
      const current = getUploadJob(job.draftId);
      if (current?.clientKey !== job.clientKey) return;
      retireDelivered(job.draftId, answer.outcome, deps.now());
      return;
    }
    if (answer?.kind === 'unavailable') log.info(`job ${shortId(job.draftId)}: ${answer.message}`);
    const n = (due?.n ?? 0) + 1;
    polls.set(job.draftId, {
      at: deps.now() + Math.min(POLL_BASE_MS * 2 ** (n - 1), POLL_MAX_MS),
      n,
    });
  }

  /** A delivering job's token: refreshing it can't pause the job, so a failure only waits. */
  async function tokenForDelivery(job: UploadJob): Promise<string | null> {
    if (!job.uploadId) return null;
    const held = host.token(job.uploadId);
    if (held && held.expiresAt - deps.now() > TOKEN_MARGIN_MS) return held.token;
    try {
      const fresh = await host.refreshUploadToken({
        uploadId: job.uploadId,
        clientKey: job.clientKey,
        draftId: job.draftId,
      });
      return fresh.token;
    } catch (e) {
      log.info(`job ${shortId(job.draftId)}: status not checked, no token: ${describeError(e)}`);
      return null;
    }
  }

  // -- the loop ----------------------------------------------------------------------------------

  async function runJob(draftId: string): Promise<void> {
    if (!accountActive || running.has(draftId)) return;
    let job = getUploadJob(draftId);
    if (!job) return;
    const abort = new AbortController();
    running.set(draftId, { clientKey: job.clientKey, abort });
    try {
      // Each state at most once per pass: queued → uploading → delivering.
      for (let step = 0; step < 3 && job && accountActive && !abort.signal.aborted; step++) {
        const before: UploadJob = job;
        switch (before.state) {
          case 'queued':
            if (before.nextAttemptAt != null && before.nextAttemptAt > deps.now()) return;
            if (!deps.canUpload()) return;
            await askTarget(before, false);
            break;
          case 'uploading':
            if (!deps.canUpload()) return;
            await upload(before, abort.signal);
            break;
          case 'delivering':
            if (!deps.isForeground()) return;
            await poll(before, abort.signal);
            return;
          default:
            return;
        }
        job = getUploadJob(draftId);
        if (!job || job.clientKey !== before.clientKey || job.state === before.state) return;
      }
    } catch (e) {
      if (!isAbort(e)) log.warn(`job ${shortId(draftId)}: pass stopped: ${describeError(e)}`);
    } finally {
      running.delete(draftId);
    }
  }

  function drain(): Promise<void> {
    if (draining) {
      again = true;
      return draining;
    }
    draining = (async () => {
      do {
        again = false;
        for (const job of listUploadJobs(['queued', 'uploading', 'delivering'])) {
          if (!accountActive) return;
          await runJob(job.draftId);
        }
      } while (again && accountActive);
    })().finally(() => {
      draining = null;
      schedule();
    });
    return draining;
  }

  /** Wake up for the next retry or poll that's due (only while started). */
  function schedule(): void {
    if (!started) return;
    if (timer) clearTimeout(timer);
    timer = null;
    if (!accountActive) return;
    const now = deps.now();
    let next = Infinity;
    for (const job of listUploadJobs(['queued', 'delivering'])) {
      if (job.state === 'queued' && job.nextAttemptAt != null)
        next = Math.min(next, job.nextAttemptAt);
      if (job.state === 'delivering' && deps.isForeground()) {
        next = Math.min(next, polls.get(job.draftId)?.at ?? now);
      }
    }
    if (next === Infinity) return;
    timer = setTimeout(
      () => {
        timer = null;
        void drain();
      },
      Math.max(0, next - now),
    );
  }

  /** §6.3: the same at boot and on `resumeOutbox`. */
  async function launch(): Promise<void> {
    recoverInterruptedSends();
    finishRetirements(deps.now());
    const jobs = listUploadJobs();
    const live = jobs.flatMap((j) => parseParts(j.partsJson).map((p) => p.tusUrl));
    try {
      const cancelled = await deps.cancelOrphans(live.filter((u): u is string => !!u));
      if (cancelled > 0) log.info(`launch: ${cancelled} upload task(s) of no live job cancelled`);
    } catch (e) {
      log.warn(`launch: background tasks not checked: ${describeError(e)}`);
    }
    for (const job of jobs) {
      if (job.state === 'uploading' && !running.has(job.draftId)) statusFirst.add(job.draftId);
      if (job.state === 'delivering') polls.delete(job.draftId);
    }
    // Not awaited: a whole video upload can be in there, and the host's call answers now.
    void drain();
  }

  async function idle(): Promise<void> {
    while (draining) await draining;
  }

  function stopRunning(): void {
    for (const { abort } of running.values()) abort.abort();
  }

  // For the runner's life: a job taken out (cancel, edit, delete) or replaced under a pass stops
  // that pass, and once started, any change (a new Send, a resume) is a reason to look again.
  subscribeUploadJobs((draftIds) => {
    for (const id of draftIds) {
      const pass = running.get(id);
      if (pass && getUploadJob(id)?.clientKey !== pass.clientKey) pass.abort.abort();
    }
    if (started) void drain();
  });

  return {
    runJob,
    drain,
    boot: launch,
    idle,
    async resumeOutbox() {
      if (!accountActive) return;
      const resumed = resumePausedJobs();
      if (resumed > 0) log.info(`resumeOutbox: ${resumed} paused job(s) queued again`);
      await launch();
    },
    setAccountActive(active) {
      if (accountActive === active) return;
      accountActive = active;
      if (!active) {
        log.info('account inactive: uploads pause');
        stopRunning();
        if (timer) clearTimeout(timer);
        timer = null;
      } else if (started) {
        void drain();
      }
    },
    start() {
      started = true;
      const appState = AppState.addEventListener('change', (next) => {
        if (next !== 'active' || !accountActive) return;
        // Foreground: a paused job tries again, and delivering jobs are polled.
        resumePausedJobs();
        void drain();
      });
      const network = subscribeNetwork(() => {
        if (deps.canUpload()) void drain();
      });
      void drain();
      return () => {
        started = false;
        appState.remove();
        network();
        if (timer) clearTimeout(timer);
        timer = null;
      };
    },
    subscribeProgress(listener) {
      progressListeners.add(listener);
      return () => {
        progressListeners.delete(listener);
      };
    },
  };
}

import { eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import { mergedSignature } from '@/core/media/merge-signature';
import { db } from '@/db/client';
import { segmentsForDraft } from '@/db/drafts';
import { LibraryError } from '@/db/host-context';
import { drafts, uploadJobs } from '@/db/schema';
import {
  getUploadJob,
  listUploadJobs,
  notifyUploadJobs,
  parseParts,
  readJob,
  serializeParts,
  setJobCancelHook,
  type JobState,
  type UploadJob,
  type UploadPart,
} from '@/db/upload-jobs';

import { jobKeys } from './client-key';
import {
  confirmSend,
  HostRequestError,
  releaseUploadTarget,
  uploadToken,
  type HostPlace,
  type ReleaseRequest,
  type HostUploadTarget,
} from './host-services';
import { writeSendFiles } from './send-files';
import { cancelTusUpload } from './tus-client';
import { describeError, shortId, uploadLog } from './upload-log';

// The embedded upload outbox's state machine (pulse-schema.md §3.3, PLAN §6.1, AD33). A draft's
// `upload_jobs` row is the only upload state it has; every change to it is one of the events
// below, decided by the pure `nextJobState` and written by `applyTransition` in one synchronous
// transaction (with the `drafts` columns the same event sets). The job loop (runner.ts) and the
// host's commands drive the events; this file knows nothing about TUS progress or the network.
//
//   (none) ──send──► preparing ──prepared──► queued ──target──► uploading ──videoDone──► delivering
//                      │  └ needs confirm: confirmed ─► queued       │                    │ outcome
//                      │                  confirmFailed ─► (none)    │ retryable ─► queued ▼
//                      ├ sendRefused (too large) ─► (none)           │                   retire
//                      └ mergeFailed ─► failed                       │ target (renewed) / tokenRefreshed
//                                                                    └──► uploading
//   queued, uploading ─ host away / no_account / expired ─► needs_credentials ─resume─► queued
//   queued, uploading ─ destination.gone / upload.refused / upload.too_large ─► failed
//   queued, uploading (cancel only), needs_credentials, failed ─ cancel/edit/delete ─► (none)

/** The first retry's wait; each later one doubles, up to `BACKOFF_MAX_MS`. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

/** The wait before retry number `n` (0 = the first): 5 s · 2^n, at most 15 min. */
export function backoffMs(n: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(n, 30)), BACKOFF_MAX_MS);
}

/** Why a job waits for the host: it didn't answer, nobody is signed in, or the token ran out. */
export type CredentialsCode = 'host.unavailable' | 'no_account' | 'credentials.expired';
/** Why a job failed for good (until Retry, Move to…, Edit or Delete). */
export type PermanentCode =
  'destination.gone' | 'upload.refused' | 'upload.too_large' | 'host_misconfigured';

export type JobEvent =
  /** Send in Export, or `upload(id)` from the host's list, with the keys of the cut being sent. */
  | { type: 'send'; clientKey: string; draftKey: string; mergedSignature: string }
  /** The merge and the send files are ready; `needsConfirm`: the type asks the host first. */
  | { type: 'prepared'; parts: UploadPart[]; bytesTotal: number; needsConfirm: boolean }
  | { type: 'mergeFailed'; message: string }
  /** The host's `confirmSend` succeeded: the draft is clock-bound from here on. */
  | { type: 'confirmed'; confirmedAt: number }
  /** The host's `confirmSend` failed: nothing is queued and the draft is a draft again. */
  | { type: 'confirmFailed' }
  /** At launch: a Send that was still preparing when the app stopped never happened. */
  | { type: 'interrupted' }
  /** A check before the confirm refused the Send (over the type's `maxBytes`): nothing queued. */
  | { type: 'sendRefused' }
  /**
   * The host's `getUploadTarget` answered: from `queued`, or from `uploading` when the job loop
   * asked again mid-upload with `renewArtifact` (PulseVault forgot the artifact, 404).
   */
  | {
      type: 'targetAnswered';
      uploadId: string;
      artifactId: string;
      endpoint: string;
      tokenExp: number;
      state?: HostUploadTarget['state'];
    }
  /** `refreshUploadToken` answered: the new token's expiry (the token stays in memory). */
  | { type: 'tokenRefreshed'; tokenExp: number }
  | { type: 'credentialsLost'; code: CredentialsCode; message: string }
  /** Foreground, `resumeOutbox`, or a host answer: try a paused job again. */
  | { type: 'resume' }
  | { type: 'retryableError'; code: string; message: string }
  | { type: 'permanentError'; code: PermanentCode; message: string }
  /** While uploading: a part was created or finished, or the video moved (not its end). */
  | { type: 'partsProgress'; parts: UploadPart[]; bytesSent?: number }
  | { type: 'videoDone'; parts: UploadPart[] }
  /** The status route has the outcome: the draft retires (retire.ts). */
  | { type: 'outcome'; outcome: 'done' | 'kept' }
  | { type: 'cancel'; reason: ReleaseRequest['reason'] };

/** What else a transition asks for, after its write commits. */
export type JobEffect =
  | { type: 'release'; request: ReleaseRequest }
  /** TUS DELETE of the uploads the job created (the token is the upload's, if Pulse has it). */
  | { type: 'deleteUploads'; uploadId: string | null; urls: string[] };

type JobRow = typeof uploadJobs.$inferInsert;
type JobChanges = Partial<Omit<JobRow, 'draftId'>>;

export type Transition =
  | { kind: 'insert'; row: Omit<JobRow, 'draftId'>; replaces: boolean; draft: { sentAt: number } }
  | { kind: 'update'; to: JobState; set: JobChanges; draft?: { hostConfirmedAt: number } }
  | { kind: 'delete'; effects: JobEffect[] }
  | { kind: 'retire'; outcome: 'done' | 'kept' }
  | { kind: 'refuse'; code: 'draft.locked' | 'not_found'; message: string }
  | { kind: 'ignore'; message: string };

/** What `nextJobState` reads besides the job: the time, new ids, and the draft's Send columns. */
export type TransitionContext = {
  now: number;
  newId: () => string;
  draft: { sentAt: number | null; hostConfirmedAt: number | null } | null;
};

const ignore = (job: UploadJob | null, event: JobEvent): Transition => ({
  kind: 'ignore',
  message: `${event.type} doesn't apply to a job ${job ? `in ${job.state}` : 'that isn’t there'}`,
});
const locked = (state: JobState): Transition => ({
  kind: 'refuse',
  code: 'draft.locked',
  message: `The draft is ${state}: it goes up as it was at Send.`,
});

/**
 * The parts for a renewed artifact (PulseVault forgot the old one, 404 → `renewArtifact`): the
 * video under its new id, the related parts under new ids, and nothing uploaded yet.
 */
export function renewParts(
  parts: readonly UploadPart[],
  videoArtifactId: string,
  newId: () => string,
): UploadPart[] {
  return parts.map((p) => ({
    ...p,
    artifactId: p.role === 'video' ? videoArtifactId : newId(),
    tusUrl: null,
    done: false,
  }));
}

/** The video part's id set to the target's; a different one than before renews every part. */
function partsForTarget(
  job: UploadJob,
  artifactId: string,
  newId: () => string,
): string | undefined {
  const parts = parseParts(job.partsJson);
  if (parts.length === 0) return undefined;
  const previous = parts.find((p) => p.role === 'video')?.artifactId ?? null;
  if (previous === artifactId) return undefined;
  if (previous === null) {
    return serializeParts(
      parts.map((p) => (p.role === 'video' ? { ...p, artifactId, tusUrl: null, done: false } : p)),
    );
  }
  return serializeParts(renewParts(parts, artifactId, newId));
}

/**
 * The outbox's transition table (pulse-schema.md §3.3): what `event` does to `job` (null: the
 * draft has none). Pure: the caller writes what it returns. An event that doesn't apply to the
 * job's state (a late answer after a cancel, say) is ignored; one the lock rule forbids is refused.
 */
export function nextJobState(
  job: UploadJob | null,
  event: JobEvent,
  ctx: TransitionContext,
): Transition {
  const { now } = ctx;
  const update = (to: JobState, set: JobChanges = {}, draft?: { hostConfirmedAt: number }) =>
    ({
      kind: 'update',
      to,
      set: { ...set, state: to, updatedAt: now },
      ...(draft ? { draft } : {}),
    }) as const;

  switch (event.type) {
    case 'send': {
      if (!ctx.draft) return { kind: 'refuse', code: 'not_found', message: 'No such draft.' };
      if (job && job.state !== 'failed') {
        if (job.state === 'queued' || job.state === 'needs_credentials') {
          // Sent already: the same cut is a no-op, another one needs the job cancelled first
          // (an edit does that).
          return job.clientKey === event.clientKey
            ? { kind: 'ignore', message: 'Already sent.' }
            : locked(job.state);
        }
        return locked(job.state);
      }
      // A clock-bound draft keeps the time its Send was confirmed at (the clock action's).
      const { sentAt: firstSentAt, hostConfirmedAt } = ctx.draft;
      const sentAt = hostConfirmedAt != null && firstSentAt != null ? firstSentAt : now;
      return {
        kind: 'insert',
        replaces: job !== null,
        row: {
          state: 'preparing',
          clientKey: event.clientKey,
          draftKey: event.draftKey,
          mergedSignature: event.mergedSignature,
          sentAt,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
        draft: { sentAt },
      };
    }

    case 'prepared': {
      if (job?.state !== 'preparing') return ignore(job, event);
      const set = { partsJson: serializeParts(event.parts), bytesTotal: event.bytesTotal };
      return event.needsConfirm ? update('preparing', set) : update('queued', set);
    }

    case 'mergeFailed':
      if (job?.state !== 'preparing') return ignore(job, event);
      return update('failed', { lastErrorCode: 'export.failed', lastErrorMessage: event.message });

    case 'confirmed':
      if (job?.state !== 'preparing') return ignore(job, event);
      return update('queued', {}, { hostConfirmedAt: event.confirmedAt });

    case 'confirmFailed':
    case 'interrupted':
    case 'sendRefused':
      if (job?.state !== 'preparing') return ignore(job, event);
      return { kind: 'delete', effects: [] };

    case 'targetAnswered': {
      if (job?.state !== 'queued' && job?.state !== 'uploading') return ignore(job, event);
      // The server has the video already (a resend after a kill): straight to its outcome.
      const landed =
        event.state === 'processing' || event.state === 'delivered' || event.state === 'kept';
      const partsJson = partsForTarget(job, event.artifactId, ctx.newId);
      return update(landed ? 'delivering' : 'uploading', {
        uploadId: event.uploadId,
        artifactId: event.artifactId,
        endpoint: event.endpoint,
        tokenExp: event.tokenExp,
        // `attempts` counts the asks from `queued`; a renewal mid-upload is the same attempt.
        attempts: job.state === 'queued' ? job.attempts + 1 : job.attempts,
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        ...(partsJson === undefined ? {} : { partsJson, bytesSent: 0 }),
      });
    }

    case 'tokenRefreshed':
      if (job?.state !== 'queued' && job?.state !== 'uploading') return ignore(job, event);
      return update(job.state, { tokenExp: event.tokenExp });

    case 'credentialsLost':
      if (job?.state !== 'queued' && job?.state !== 'uploading') return ignore(job, event);
      return update('needs_credentials', {
        lastErrorCode: event.code,
        lastErrorMessage: event.message,
      });

    case 'resume':
      if (job?.state !== 'needs_credentials') return ignore(job, event);
      return update('queued', { nextAttemptAt: null });

    case 'retryableError': {
      if (job?.state !== 'queued' && job?.state !== 'uploading') return ignore(job, event);
      // `attempts` counts the asks for a target; a failed ask (queued) counts as one too. The
      // wait doubles with each.
      const attempts = job.state === 'queued' ? job.attempts + 1 : Math.max(job.attempts, 1);
      return update('queued', {
        attempts,
        nextAttemptAt: now + backoffMs(attempts - 1),
        lastErrorCode: event.code,
        lastErrorMessage: event.message,
      });
    }

    case 'permanentError':
      if (job?.state !== 'queued' && job?.state !== 'uploading') return ignore(job, event);
      return update('failed', {
        nextAttemptAt: null,
        lastErrorCode: event.code,
        lastErrorMessage: event.message,
      });

    case 'partsProgress':
      if (job?.state !== 'uploading') return ignore(job, event);
      return update('uploading', {
        partsJson: serializeParts(event.parts),
        ...(event.bytesSent === undefined ? {} : { bytesSent: event.bytesSent }),
      });

    case 'videoDone':
      if (job?.state !== 'uploading') return ignore(job, event);
      return update('delivering', {
        partsJson: serializeParts(event.parts),
        bytesSent: job.bytesTotal,
      });

    case 'outcome':
      if (job?.state !== 'delivering') return ignore(job, event);
      return { kind: 'retire', outcome: event.outcome };

    case 'cancel': {
      if (!job) return ignore(job, event);
      // Cancel sending stops an upload under way; an edit or delete waits for it (the lock rule).
      const cancellable =
        job.state === 'queued' ||
        job.state === 'needs_credentials' ||
        job.state === 'failed' ||
        (job.state === 'uploading' && event.reason === 'canceled');
      if (!cancellable) return locked(job.state);
      const urls = parseParts(job.partsJson)
        .map((p) => p.tusUrl)
        .filter((u): u is string => !!u);
      const effects: JobEffect[] = [];
      if (urls.length > 0) effects.push({ type: 'deleteUploads', uploadId: job.uploadId, urls });
      if (job.uploadId) {
        effects.push({
          type: 'release',
          request: { uploadId: job.uploadId, clientKey: job.clientKey, reason: event.reason },
        });
      }
      return { kind: 'delete', effects };
    }
  }
}

/**
 * Apply `event` to the draft's job: read the job and the draft, decide, and write the result, in
 * one synchronous transaction. Subscribers to the outbox (`subscribeUploadJobs`) hear of every
 * committed change. Returns the transition; refusals and ignored events wrote nothing, and a
 * retirement is the caller's (retire.ts).
 */
export function applyTransition(
  draftId: string,
  event: JobEvent,
  options: { now?: number; newId?: () => string } = {},
): Transition {
  const now = options.now ?? Date.now();
  const newId = options.newId ?? Crypto.randomUUID;
  const transition = db.transaction((tx) => {
    const job = readJob(tx, draftId);
    const draft =
      tx
        .select({ sentAt: drafts.sentAt, hostConfirmedAt: drafts.hostConfirmedAt })
        .from(drafts)
        .where(eq(drafts.id, draftId))
        .get() ?? null;
    const t = nextJobState(job, event, { now, newId, draft });
    switch (t.kind) {
      case 'insert':
        tx.update(drafts).set(t.draft).where(eq(drafts.id, draftId)).run();
        if (t.replaces) tx.delete(uploadJobs).where(eq(uploadJobs.draftId, draftId)).run();
        tx.insert(uploadJobs)
          .values({ ...t.row, draftId })
          .run();
        break;
      case 'update':
        tx.update(uploadJobs).set(t.set).where(eq(uploadJobs.draftId, draftId)).run();
        if (t.draft) tx.update(drafts).set(t.draft).where(eq(drafts.id, draftId)).run();
        break;
      case 'delete':
        tx.delete(uploadJobs).where(eq(uploadJobs.draftId, draftId)).run();
        break;
    }
    return t;
  });
  if (
    transition.kind === 'insert' ||
    transition.kind === 'update' ||
    transition.kind === 'delete'
  ) {
    notifyUploadJobs([draftId]);
  }
  return transition;
}

/** The event a host request's failure is for a job waiting on it (HostServiceError's rules). */
export function hostErrorEvent(error: unknown): JobEvent {
  const message = describeError(error);
  if (error instanceof HostRequestError) {
    switch (error.code) {
      case 'destination.gone':
      case 'upload.refused':
      case 'upload.too_large':
      case 'host_misconfigured':
        return { type: 'permanentError', code: error.code, message };
      case 'no_account':
        return { type: 'credentialsLost', code: 'no_account', message };
      case 'host.unavailable':
        // Nobody answered in 20 s: wait for the host. A host that said so itself: retry.
        return error.unanswered
          ? { type: 'credentialsLost', code: 'host.unavailable', message }
          : { type: 'retryableError', code: 'host.unavailable', message };
    }
  }
  return { type: 'retryableError', code: 'upload.failed', message };
}

// Send, cancel and launch -----------------------------------------------------------------------

/** What a Send hands back: the keys the host follows it by, and when it was sent. */
export type SendResult = { draftId: string; clientKey: string; draftKey: string; sentAt: number };

type SendColumns = {
  contextKey: string | null;
  contextLabel: string | null;
  contextJson: string | null;
  uploadTypeJson: string | null;
  hostConfirmedAt: number | null;
};

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The draft's place as the host gave it (its `PulseContext`), or null without one. */
function placeOf(row: SendColumns): HostPlace | null {
  if (!row.contextKey || !row.contextLabel) return null;
  const rest = parseJson(row.contextJson);
  return {
    ...(typeof rest === 'object' && rest !== null ? rest : {}),
    key: row.contextKey,
    label: row.contextLabel,
  };
}

function refused(t: Extract<Transition, { kind: 'refuse' }>, draftId: string): LibraryError {
  return new LibraryError(t.code, `Draft ${draftId}: ${t.message}`);
}

/** Where a Send is, for Export's states ("Clocking out…" is `confirming`). */
export type SendStage = 'merging' | 'confirming' | 'queued';

export type SendOptions = {
  /** Called as the Send reaches each stage. */
  onStage?: (stage: SendStage) => void;
  /**
   * Runs once the send files are written, before the host is asked to confirm (or the job is
   * queued): the type's `maxBytes` gate, say. Throwing (e.g. `upload.too_large`) leaves no job and
   * the draft unconfirmed; `sendDraft` rejects with that error.
   */
  beforeConfirm?: (prepared: { bytesTotal: number }) => void | Promise<void>;
};

/** Drafts whose `sendDraft` is under way in this process: `recoverInterruptedSends` skips them. */
const sendsInFlight = new Set<string>();

/** A transition the Send needs that didn't apply: its job went away under it. */
function sendStopped(draftId: string, t: Transition): LibraryError {
  return new LibraryError(
    'not_found',
    `Draft ${draftId}: the Send stopped before it was queued (${t.kind === 'ignore' || t.kind === 'refuse' ? t.message : t.kind}).`,
  );
}

/**
 * Send the draft (PLAN §6.1): freeze it as a `preparing` job keyed by its cut, `merge` it (the
 * persisted export when current), write its send files, run `beforeConfirm`, then ask the host's
 * `confirmSend` when its upload type wants one and the draft isn't confirmed yet, and queue it. A
 * merge that fails leaves a `failed` job; a refusal before the confirm, or a confirm that fails,
 * leaves no job (the draft stays on Export) and rejects with that error. Sending a queued draft
 * again with no edit returns its keys. A library a newer Pulse migrated still sends.
 */
export async function sendDraft(
  draftId: string,
  merge: () => Promise<{ durationMs: number }>,
  options: SendOptions = {},
): Promise<SendResult> {
  const segments = await segmentsForDraft(draftId);
  if (segments.length === 0) throw new LibraryError('not_found', `Draft ${draftId} has no clips.`);
  const signature = mergedSignature(segments);
  const keys = await jobKeys(draftId, signature);
  const sent = applyTransition(draftId, { type: 'send', ...keys, mergedSignature: signature });
  if (sent.kind === 'refuse') throw refused(sent, draftId);
  if (sent.kind !== 'insert') {
    const job = getUploadJob(draftId);
    if (!job) throw new LibraryError('not_found', `Draft ${draftId} has no job.`);
    return { draftId, clientKey: job.clientKey, draftKey: job.draftKey, sentAt: job.sentAt };
  }
  sendsInFlight.add(draftId);
  try {
    return await prepareAndQueue(draftId, keys, sent.draft.sentAt, merge, options);
  } finally {
    sendsInFlight.delete(draftId);
  }
}

async function prepareAndQueue(
  draftId: string,
  keys: { clientKey: string; draftKey: string },
  sentAt: number,
  merge: () => Promise<{ durationMs: number }>,
  { onStage, beforeConfirm }: SendOptions,
): Promise<SendResult> {
  uploadLog.info(`send: draft ${shortId(draftId)} preparing`);
  onStage?.('merging');

  let files;
  try {
    const merged = await merge();
    files = await writeSendFiles(draftId, merged.durationMs);
  } catch (e) {
    uploadLog.warn(`send: draft ${shortId(draftId)} couldn't be prepared: ${describeError(e)}`);
    applyTransition(draftId, { type: 'mergeFailed', message: describeError(e) });
    throw e;
  }

  if (beforeConfirm) {
    try {
      await beforeConfirm({ bytesTotal: files.bytesTotal });
    } catch (e) {
      uploadLog.warn(`send: draft ${shortId(draftId)} refused: ${describeError(e)}`);
      applyTransition(draftId, { type: 'sendRefused' });
      throw e;
    }
  }

  const row: SendColumns | undefined = db
    .select({
      contextKey: drafts.contextKey,
      contextLabel: drafts.contextLabel,
      contextJson: drafts.contextJson,
      uploadTypeJson: drafts.uploadTypeJson,
      hostConfirmedAt: drafts.hostConfirmedAt,
    })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  const uploadType = parseJson(row?.uploadTypeJson ?? null);
  const wantsConfirm =
    typeof uploadType === 'object' &&
    uploadType !== null &&
    (uploadType as { confirmSend?: unknown }).confirmSend === true;
  // A clock-bound draft's clock action ran at its first Send: it isn't asked again.
  const needsConfirm = wantsConfirm && row?.hostConfirmedAt == null;
  const prepared = applyTransition(draftId, { type: 'prepared', ...files, needsConfirm });
  if (prepared.kind !== 'update') throw sendStopped(draftId, prepared);

  if (needsConfirm) {
    onStage?.('confirming');
    const place = row ? placeOf(row) : null;
    let confirmedAt: number;
    try {
      if (!place) throw new HostRequestError('host_misconfigured', 'The draft has no place.');
      ({ confirmedAt } = await confirmSend({
        draftId,
        draftKey: keys.draftKey,
        context: place,
        uploadType,
        sentAt,
        bytes: files.bytesTotal,
      }));
    } catch (e) {
      uploadLog.warn(`send: draft ${shortId(draftId)} not confirmed: ${describeError(e)}`);
      applyTransition(draftId, { type: 'confirmFailed' });
      throw e;
    }
    const confirmed = applyTransition(draftId, { type: 'confirmed', confirmedAt });
    if (confirmed.kind !== 'update') throw sendStopped(draftId, confirmed);
  }
  uploadLog.info(`send: draft ${shortId(draftId)} queued`);
  onStage?.('queued');
  return { draftId, ...keys, sentAt };
}

/**
 * Take the draft's job back out of the outbox (Cancel sending, an edit, Move to… or Delete): the
 * draft is a draft again, and the next Send makes a new clientKey with the same draftKey. Refused
 * with `draft.locked` while the job prepares or delivers, and for an edit or delete while it
 * uploads. The host is told and the job's TUS uploads deleted after the commit, best effort.
 * Without a job, nothing happens.
 */
export function cancelJob(draftId: string, reason: ReleaseRequest['reason']): void {
  const t = applyTransition(draftId, { type: 'cancel', reason });
  if (t.kind === 'refuse') throw refused(t, draftId);
  if (t.kind === 'delete' && t.effects.length > 0) void runJobEffects(t.effects);
}

// drafts.ts's edits, Move to… and Delete take a draft's job out through `cancelJob`.
setJobCancelHook(cancelJob);

/** Carry out a transition's effects: TUS deletes with the upload's token, then the release. */
export async function runJobEffects(effects: readonly JobEffect[]): Promise<void> {
  for (const effect of effects) {
    if (effect.type !== 'deleteUploads') continue;
    // Read before the release forgets it.
    const token = effect.uploadId ? (uploadToken(effect.uploadId)?.token ?? null) : null;
    await Promise.all(
      effect.urls.map((url) =>
        cancelTusUpload(url, token).catch((e: unknown) =>
          uploadLog.warn(`couldn’t delete an upload: ${describeError(e)}`),
        ),
      ),
    );
  }
  await Promise.all(
    effects.map((effect) =>
      effect.type === 'release' ? releaseUploadTarget(effect.request) : Promise.resolve(),
    ),
  );
}

/**
 * At launch, before any job runs: a Send still `preparing` stopped with the app (mid-merge or
 * mid-confirm), so it never happened and the draft is a draft again. A confirm the host already
 * ran is found again by its draftKey at the next Send. A Send still running in this process (a
 * `resumeOutbox` while it waits on `confirmSend`) is left alone. Returns how many there were.
 */
export function recoverInterruptedSends(): number {
  let n = 0;
  for (const job of listUploadJobs(['preparing'])) {
    if (sendsInFlight.has(job.draftId)) continue;
    if (applyTransition(job.draftId, { type: 'interrupted' }).kind === 'delete') n++;
  }
  if (n > 0) uploadLog.info(`launch: ${n} Send(s) stopped while preparing; back to drafts`);
  return n;
}

/** Foreground, `resumeOutbox`, or the host back: every paused job is queued again. */
export function resumePausedJobs(): number {
  let n = 0;
  for (const job of listUploadJobs(['needs_credentials'])) {
    if (applyTransition(job.draftId, { type: 'resume' }).kind === 'update') n++;
  }
  return n;
}

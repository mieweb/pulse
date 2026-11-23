import { count, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { draftDisplayName } from '@/db/drafts';
import { LibraryError } from '@/db/host-context';
import {
  deleteExpiredReceipts,
  insertReceipt,
  markMediaDeleted,
  RECEIPT_TTL_MS,
  receiptsWithMedia,
  type UploadReceipt,
} from '@/db/receipts';
import { drafts, segments } from '@/db/schema';
import {
  isLockedJobState,
  notifyUploadJobs,
  readJob,
  type Tx,
  type UploadJob,
} from '@/db/upload-jobs';
import { deleteDraftDir } from '@/utils/file-store';

import { nextJobState } from './outbox';
import { describeError, shortId, uploadLog } from './upload-log';

// Retirement (AD9, pulse-schema.md §4.3): when PulseVault's status route reports the host's
// outcome (`done` or `kept`), the sent draft becomes a receipt. In order:
//   1. one synchronous transaction inserts the receipt and deletes the draft (the FK cascade takes
//      its clips, transcripts and job);
//   2. after the commit, the draft's folder `drafts/<id>/` is deleted and the receipt records it
//      (`media_deleted_at`);
//   3. at the next launch, a receipt whose folder isn't recorded as gone has it deleted again, so
//      a kill between 1 and 2 is finished; receipts past their 7 days are deleted.
// A video is never deleted before the host has it (only an outcome retires), and nothing here
// deletes a folder that no receipt names.

/** What the status route said the host did with the video (huddle-server.md §7). */
export type DeliveryOutcome = {
  state: 'done' | 'kept';
  /** The host's note for `done`. */
  note?: string | null;
  /** Why the host kept the video in the person's library instead (`kept`). */
  reason?: string | null;
};

/** The draft's columns a receipt keeps, and its clip count, read in `tx`. */
function draftForReceipt(tx: Tx, draftId: string) {
  const draft = tx
    .select({
      name: drafts.name,
      contextKey: drafts.contextKey,
      contextLabel: drafts.contextLabel,
      contextJson: drafts.contextJson,
      uploadTypeJson: drafts.uploadTypeJson,
      mergedDurationMs: drafts.mergedDurationMs,
      sentAt: drafts.sentAt,
    })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  if (!draft) return null;
  const clips = tx.select({ n: count() }).from(segments).where(eq(segments.draftId, draftId)).get();
  return { ...draft, clipCount: clips?.n ?? 0 };
}

/** Steps 2–3 for one draft: delete its folder, then record that it's gone. */
function deleteMedia(draftId: string, now: number): boolean {
  try {
    deleteDraftDir(draftId);
  } catch (e) {
    uploadLog.warn(
      `retire: draft ${shortId(draftId)}'s folder not deleted yet: ${describeError(e)}`,
    );
    return false;
  }
  markMediaDeleted(draftId, now);
  return true;
}

function writeReceipt(
  tx: Tx,
  draftId: string,
  job: Pick<UploadJob, 'uploadId' | 'artifactId' | 'clientKey' | 'sentAt'> | null,
  outcome: DeliveryOutcome,
  now: number,
): boolean {
  const draft = draftForReceipt(tx, draftId);
  if (!draft) return false;
  insertReceipt(tx, {
    draftId,
    name: draftDisplayName(draft.name, draft.contextLabel),
    contextKey: draft.contextKey,
    contextLabel: draft.contextLabel,
    contextJson: draft.contextJson,
    uploadTypeJson: draft.uploadTypeJson,
    outcome: outcome.state,
    note: outcome.state === 'done' ? (outcome.note ?? null) : null,
    reason: outcome.state === 'kept' ? (outcome.reason ?? null) : null,
    uploadId: job?.uploadId ?? '',
    artifactId: job?.artifactId ?? '',
    clientKey: job?.clientKey ?? '',
    clipCount: draft.clipCount,
    durationMs: draft.mergedDurationMs ?? 0,
    sentAt: job?.sentAt ?? draft.sentAt ?? now,
    deliveredAt: now,
    expiresAt: now + RECEIPT_TTL_MS,
  });
  // The cascade takes the clips, transcripts and the job.
  tx.delete(drafts).where(eq(drafts.id, draftId)).run();
  return true;
}

/**
 * Retire a delivering draft with the host's `outcome`: the receipt and the draft's deletion in one
 * transaction, then its folder. Returns false, writing nothing, when the draft's job isn't
 * delivering any more (a cancel or a second poll got there first).
 */
export function retireDelivered(
  draftId: string,
  outcome: DeliveryOutcome,
  now: number = Date.now(),
): boolean {
  const retired = db.transaction((tx) => {
    const job = readJob(tx, draftId);
    const t = nextJobState(
      job,
      { type: 'outcome', outcome: outcome.state },
      {
        now,
        newId: () => '',
        draft: null,
      },
    );
    if (t.kind !== 'retire' || !job) return false;
    return writeReceipt(tx, draftId, job, outcome, now);
  });
  if (!retired) return false;
  notifyUploadJobs([draftId]);
  uploadLog.info(`retire: draft ${shortId(draftId)} ${outcome.state}; receipt kept 7 days`);
  deleteMedia(draftId, now);
  return true;
}

/**
 * `retireDraft(id)` in 'file' mode (pulse-schema.md §4.3): the host stored the MP4 itself, so the
 * draft retires now with outcome `done` and no server ids. Refused with `draft.locked` while a job
 * locks the draft; any other job goes with the draft.
 */
export function retireSentFile(draftId: string, now: number = Date.now()): void {
  const retired = db.transaction((tx) => {
    const job = readJob(tx, draftId);
    if (job && isLockedJobState(job.state)) {
      throw new LibraryError('draft.locked', `Draft ${draftId} is ${job.state}.`);
    }
    return writeReceipt(tx, draftId, null, { state: 'done' }, now);
  });
  if (!retired) throw new LibraryError('not_found', `No draft ${draftId}.`);
  notifyUploadJobs([draftId]);
  deleteMedia(draftId, now);
}

/**
 * At launch (§4.3 steps 4–5): delete the folder of every receipt not recorded as gone (a kill
 * between the rows and the files), then the receipts past their 7 days. Returns what it did.
 */
export function finishRetirements(now: number = Date.now()): {
  foldersDeleted: number;
  receiptsExpired: number;
} {
  let foldersDeleted = 0;
  for (const receipt of receiptsWithMedia()) {
    if (deleteMedia(receipt.draftId, now)) foldersDeleted++;
  }
  const expired = deleteExpiredReceipts(now);
  if (foldersDeleted > 0 || expired.length > 0) {
    uploadLog.info(
      `launch: ${foldersDeleted} retired folder(s) deleted, ${expired.length} receipt(s) expired`,
    );
  }
  return { foldersDeleted, receiptsExpired: expired.length };
}

export type { UploadReceipt };

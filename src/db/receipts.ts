import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';

import { db } from './client';
import { uploadReceipts, type UploadReceipt } from './schema';
import type { Tx } from './upload-jobs';

// Upload receipts (`upload_receipts`, LOCAL; pulse-schema.md §4.1): what is left of a draft the
// embedded shell sent once it retired, for 7 days and without its media. Retirement
// (features/upload/core/retire.ts) writes the receipt in the transaction that deletes the draft,
// then deletes the draft's folder and records that here (`media_deleted_at`). A receipt whose
// folder isn't recorded as gone is the list of what the next launch deletes (§4.3 step 4): a record
// of what to delete, never an orphan sweep.

export type { UploadReceipt };
export type NewReceipt = typeof uploadReceipts.$inferInsert;

/** How long a receipt is kept after delivery (Q5). */
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Write `row` inside the retirement transaction (`media_deleted_at` starts null). */
export function insertReceipt(tx: Tx, row: Omit<NewReceipt, 'mediaDeletedAt'>): void {
  tx.insert(uploadReceipts)
    .values({ ...row, mediaDeletedAt: null })
    .run();
}

/** The receipt of a retired draft, or null. */
export function getReceipt(draftId: string): UploadReceipt | null {
  return db.select().from(uploadReceipts).where(eq(uploadReceipts.draftId, draftId)).get() ?? null;
}

/** Every receipt, newest delivery first (expired ones included until `deleteExpiredReceipts`). */
export function listReceipts(): UploadReceipt[] {
  return db
    .select()
    .from(uploadReceipts)
    .all()
    .sort((a, b) => b.deliveredAt - a.deliveredAt);
}

/** Receipts whose draft folder isn't recorded as deleted yet: the next launch deletes those. */
export function receiptsWithMedia(): UploadReceipt[] {
  return db.select().from(uploadReceipts).where(isNull(uploadReceipts.mediaDeletedAt)).all();
}

/** Record that the draft's folder is gone. */
export function markMediaDeleted(draftId: string, now: number): void {
  db.update(uploadReceipts)
    .set({ mediaDeletedAt: now })
    .where(and(eq(uploadReceipts.draftId, draftId), isNull(uploadReceipts.mediaDeletedAt)))
    .run();
}

/**
 * Delete the receipts that expired before `now` (§4.3 step 5); they have no media, so nothing
 * else goes. A receipt whose folder is still to delete is kept until that is done. Returns the
 * ids deleted.
 */
export function deleteExpiredReceipts(now: number): string[] {
  return db
    .delete(uploadReceipts)
    .where(and(lt(uploadReceipts.expiresAt, now), isNotNull(uploadReceipts.mediaDeletedAt)))
    .returning({ draftId: uploadReceipts.draftId })
    .all()
    .map((r) => r.draftId);
}

/**
 * `dismissReceipt(id)`: a 'kept' receipt stops counting for attention (the host moved the video).
 * Returns false when there is no such receipt; dismissing again keeps the first time.
 */
export function dismissReceipt(draftId: string, now: number): boolean {
  const receipt = getReceipt(draftId);
  if (!receipt) return false;
  if (receipt.dismissedAt == null) {
    db.update(uploadReceipts)
      .set({ dismissedAt: now })
      .where(eq(uploadReceipts.draftId, draftId))
      .run();
  }
  return true;
}

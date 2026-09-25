import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import {
  absolutize,
  deleteDraftDir,
  deleteSegmentFile,
  editCoverRelPath,
  editedThumbRelPath,
  thumbRelPath,
} from '@/utils/file-store';
import { editTimelineMs, parseEdit } from '@/utils/segment-window';
import { generateThumbnailFile } from '@/utils/video';
import { db } from './client';
import type { PairedDestination } from './destinations';
import type { Draft, Segment } from './schema';
import { drafts, segments } from './schema';
import { deleteViewLink } from './secure-token';

const now = sql`(unixepoch('subsec') * 1000)`;

/** A new clip to append to a draft; `thumbnail` is populated only when the camera/importer
 * already produced one, otherwise it's derived later from the first frame. */
type NewSegment = {
  id: string;
  originalFilename: string;
  durationMs: number;
  thumbnail?: string | null;
};

/** One row per draft with its segment count, trim-aware duration, and cover clip. */
export const draftListQuery = db
  .select({
    id: drafts.id,
    name: drafts.name,
    lastModified: drafts.lastModified,
    // Persisted upload status, so a draft card can show its own upload state on the home screen.
    uploadStatus: drafts.uploadStatus,
    segmentCount: count(segments.id),
    // Effective duration = sum of each clip's edited duration (if edited) else its original.
    durationMs: sql<number>`coalesce(sum(coalesce(${segments.editedDurationMs}, ${segments.durationMs})), 0)`,
    // Cover frame: the first clip's persisted thumbnail (+ its effective file as a legacy fallback).
    firstSegmentFilename: sql<
      string | null
    >`(select coalesce(edited_filename, original_filename) from ${segments} where ${segments.draftId} = ${drafts.id} order by sort_order limit 1)`,
    firstSegmentThumbnail: sql<
      string | null
    >`(select thumbnail from ${segments} where ${segments.draftId} = ${drafts.id} order by sort_order limit 1)`,
  })
  .from(drafts)
  .leftJoin(segments, eq(segments.draftId, drafts.id))
  .groupBy(drafts.id)
  .orderBy(desc(drafts.lastModified));

export function segmentsForDraft(draftId: string) {
  return db
    .select()
    .from(segments)
    .where(eq(segments.draftId, draftId))
    .orderBy(asc(segments.order));
}

/**
 * The draft's human-facing name (the title shown in the library / set via
 * `renameDraft`), or `undefined` when it was never named — so it drops straight
 * into an optional upload field without a `null` seam at the call site. Read
 * fresh at upload time (like the transcript) so a rename right before upload
 * wins over a value snapshotted at enqueue.
 */
export async function getDraftName(draftId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ name: drafts.name })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .limit(1);
  return row?.name ?? undefined;
}

/** Every segment in the library — drives the global background transcription engine. */
// Mutations — each is a single-row write that autosaves the draft (§3).

export async function createDraft(): Promise<string> {
  const id = Crypto.randomUUID();
  await db.insert(drafts).values({ id });
  return id;
}

export async function addSegment(draftId: string, segment: NewSegment): Promise<void> {
  await beginClipMutation(draftId);
  // Everything is read-then-write, so it all runs inside one transaction: the badge number
  // comes from the draft's monotonic `lastClipNumber` counter (bump + read back atomically;
  // never decremented, so deletes/renames can't cause reuse), and `order` is the next free
  // slot (max + 1, race-safe and hole-tolerant after deletes — the unique (draftId, order)
  // index backstops any regression).
  await db.transaction(async (tx) => {
    const [counter] = await tx
      .update(drafts)
      .set({ lastClipNumber: sql`${drafts.lastClipNumber} + 1`, lastModified: now })
      .where(eq(drafts.id, draftId))
      .returning({ clipNumber: drafts.lastClipNumber });
    if (!counter) throw new Error(`addSegment: draft ${draftId} not found`);

    const [{ maxOrder }] = await tx
      .select({ maxOrder: sql<number | null>`max(${segments.order})` })
      .from(segments)
      .where(eq(segments.draftId, draftId));

    await tx.insert(segments).values({
      id: segment.id,
      draftId,
      order: (maxOrder ?? -1) + 1,
      label: String(counter.clipNumber),
      originalFilename: segment.originalFilename,
      durationMs: segment.durationMs,
      thumbnail: segment.thumbnail ?? null,
    });
  });
}

/** The draft's persisted upload status (null when unset / draft missing). */
export async function getDraftUploadStatus(draftId: string): Promise<Draft['uploadStatus']> {
  const [row] = await db
    .select({ status: drafts.uploadStatus })
    .from(drafts)
    .where(eq(drafts.id, draftId));
  return row?.status ?? null;
}

/**
 * A draft is LOCKED while it uploads: it goes up exactly as it was when Upload was tapped, and
 * cancelling is the only way back to editing. The UI never offers an edit on an uploading draft,
 * so this throwing is a backstop, not a user-reachable path.
 */
export async function assertNotUploading(draftId: string): Promise<void> {
  if ((await getDraftUploadStatus(draftId)) === 'uploading') {
    throw new Error(`Draft ${draftId} is uploading — cancel the upload to edit it`);
  }
}

/**
 * Entry point of every clip mutation (add/delete/trim/reset/reorder): refuse while uploading.
 * The persisted merged export is deliberately left alone — the export screen compares its
 * signature with the clips on arrival, so edits that are undone (reorder back, reset a trim,
 * delete an added clip) reuse it, and anything still changed merges again.
 */
async function beginClipMutation(draftId: string): Promise<void> {
  await assertNotUploading(draftId);
}

/** The draft's persisted-export record (see `drafts.mergedSignature`), or null if no row. */
export async function getMergedExport(
  draftId: string,
): Promise<{ signature: string | null; durationMs: number | null } | null> {
  const [row] = await db
    .select({ signature: drafts.mergedSignature, durationMs: drafts.mergedDurationMs })
    .from(drafts)
    .where(eq(drafts.id, draftId));
  return row ?? null;
}

/** Record (or clear, with `null`) the content key of the draft's persisted export. */
export async function setMergedExport(
  draftId: string,
  merged: { signature: string; durationMs: number } | null,
): Promise<void> {
  await db
    .update(drafts)
    .set({
      mergedSignature: merged?.signature ?? null,
      mergedDurationMs: merged?.durationMs ?? null,
    })
    .where(eq(drafts.id, draftId));
}

/** Delete a segment and its clip file, unless a sibling segment still references the file. */
export async function deleteSegment(segmentId: string): Promise<void> {
  const [seg] = await db.select().from(segments).where(eq(segments.id, segmentId));
  if (!seg) return;

  await beginClipMutation(seg.draftId);
  await db.delete(segments).where(eq(segments.id, segmentId));

  const [{ value: stillReferenced }] = await db
    .select({ value: count() })
    .from(segments)
    .where(eq(segments.originalFilename, seg.originalFilename));
  if (stillReferenced === 0) deleteSegmentFile(seg.originalFilename);
  // The edited file and both thumbnails are per-segment (never shared) — delete with the row.
  if (seg.editedFilename) {
    deleteSegmentFile(seg.editedFilename);
    deleteSegmentFile(editedThumbRelPath(seg.editedFilename));
  }
  deleteSegmentFile(thumbRelPath(seg.draftId, segmentId));
  // The row's cover may not match either derived path (e.g. a prior revision's thumb kept as a
  // fallback after a failed regeneration) — delete whatever the row actually references too.
  if (seg.thumbnail) deleteSegmentFile(seg.thumbnail);

  await db.update(drafts).set({ lastModified: now }).where(eq(drafts.id, seg.draftId));
}

/**
 * Save an edit as settings: the editor's `editState` (applied when the clip plays, and by the
 * export's merge), its timeline length (`editedDurationMs`, for the draft-list SQL), and a cover
 * rendered from the original with the edit applied. Nothing is encoded. Replaces any earlier edit
 * — a legacy baked file included, dropped once the row no longer points at it.
 */
export async function setEditState(segmentId: string, editState: string): Promise<void> {
  const edit = parseEdit(editState);
  const durationMs = editTimelineMs(editState);
  if (!edit || durationMs == null) throw new Error('The editor returned an unusable edit');
  const [seg] = await db.select().from(segments).where(eq(segments.id, segmentId));
  if (!seg) return;
  await beginClipMutation(seg.draftId);
  const coverRel = editCoverRelPath(seg.draftId, segmentId, Date.now());
  const ok = await generateThumbnailFile(absolutize(seg.originalFilename), absolutize(coverRel), {
    editState,
    startMs: edit.startMs,
  });
  await db
    .update(segments)
    .set({
      editState,
      editedDurationMs: durationMs,
      editedFilename: null,
      thumbnail: ok ? coverRel : seg.thumbnail,
    })
    .where(eq(segments.id, segmentId));
  // Drop replaced files only now that the row points away from them, so a failure above never
  // leaves the segment referencing deleted files. The prior cover goes only if the new one took
  // its place; the pristine thumb stays on disk, ready for a reset.
  if (seg.editedFilename) deleteSegmentFile(seg.editedFilename);
  if (ok && seg.thumbnail && seg.thumbnail !== thumbRelPath(seg.draftId, segmentId)) {
    deleteSegmentFile(seg.thumbnail);
  }
  await db.update(drafts).set({ lastModified: now }).where(eq(drafts.id, seg.draftId));
}

/**
 * Reset a segment back to its pristine original — clear the edit (settings and any legacy baked
 * file), so it plays whole and the editor next opens fresh.
 */
export async function resetEdit(segmentId: string): Promise<void> {
  const [seg] = await db.select().from(segments).where(eq(segments.id, segmentId));
  if (!seg) return;
  await beginClipMutation(seg.draftId);
  // Revert the cover to the pristine original's thumbnail.
  const thumbRel = thumbRelPath(seg.draftId, segmentId);
  const ok = await generateThumbnailFile(absolutize(seg.originalFilename), absolutize(thumbRel));
  await db
    .update(segments)
    .set({
      editedFilename: null,
      editedDurationMs: null,
      editState: null,
      thumbnail: ok ? thumbRel : null,
    })
    .where(eq(segments.id, segmentId));
  // Drop the now-orphaned edited file and thumb only after the row no longer references them.
  if (seg.editedFilename) {
    deleteSegmentFile(seg.editedFilename);
    deleteSegmentFile(editedThumbRelPath(seg.editedFilename));
  }
  // The prior cover may be from an older revision than `editedFilename` (kept as a fallback
  // after a failed re-edit thumb generation) — drop it too, but never the fresh `thumbRel`.
  if (seg.thumbnail && seg.thumbnail !== thumbRel) deleteSegmentFile(seg.thumbnail);
  await db.update(drafts).set({ lastModified: now }).where(eq(drafts.id, seg.draftId));
}

/** Persist a new clip ordering (ids in target order) for a single draft. */
export async function reorderSegments(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const [target] = await db.select().from(segments).where(eq(segments.id, orderedIds[0]));
  if (target) await beginClipMutation(target.draftId);
  await db.transaction(async (tx) => {
    // Two passes: SQLite checks UNIQUE per statement, so renumbering in place would collide
    // with rows still holding their old slot. Park all rows on distinct negatives first,
    // then assign final slots via one CASE update.
    await tx
      .update(segments)
      .set({ order: sql`-${segments.order} - 1` })
      .where(inArray(segments.id, orderedIds));
    const finalOrder = sql`case ${sql.join(
      orderedIds.map((id, i) => sql`when ${segments.id} = ${id} then ${i}`),
      sql` `,
    )} else ${segments.order} end`;
    await tx.update(segments).set({ order: finalOrder }).where(inArray(segments.id, orderedIds));
    const [first] = await tx.select().from(segments).where(eq(segments.id, orderedIds[0]));
    if (first) {
      await tx.update(drafts).set({ lastModified: now }).where(eq(drafts.id, first.draftId));
    }
  });
}

export async function renameDraft(draftId: string, name: string | null): Promise<void> {
  // Locked too — the name rides the upload as the video's title. The video itself doesn't
  // change, so the persisted export stays valid.
  await assertNotUploading(draftId);
  await db.update(drafts).set({ name, lastModified: now }).where(eq(drafts.id, draftId));
}

/** Delete a draft (segments cascade), its on-disk directory (clips + export) and its view link. */
export async function deleteDraft(draftId: string): Promise<void> {
  await assertNotUploading(draftId);
  await db.delete(drafts).where(eq(drafts.id, draftId));
  deleteDraftDir(draftId);
  await deleteViewLink(draftId);
}

// Upload pairing -------------------------------------------------------------------------------

/**
 * Claim a pool destination for a draft: the draft is `uploading` (and locked, see
 * `assertNotUploading`) from this write on. Written BEFORE the pool row is removed, so a kill
 * between the two leaves an `uploading` draft for the launch check to fail cleanly, never a spent
 * link with nothing to show for it. The link's bearer token isn't stored with the draft: the
 * upload carries it in memory, and nothing needs it once the upload settles.
 */
export async function setUploadDestination(
  draftId: string,
  destination: Pick<PairedDestination, 'server' | 'artifactId'>,
): Promise<void> {
  await db
    .update(drafts)
    .set({
      uploadServer: destination.server,
      uploadArtifactId: destination.artifactId,
      uploadStatus: 'uploading',
      lastModified: now,
    })
    .where(eq(drafts.id, draftId));
}

/**
 * Settle a finished upload: `uploaded` only if the draft is still `uploading` this same artifact.
 * Returns whether it did — `false` means a cancel or failure cleared the pairing first, and that
 * outcome stands.
 */
export async function markUploaded(draftId: string, artifactId: string): Promise<boolean> {
  const rows = await db
    .update(drafts)
    .set({ uploadStatus: 'uploaded', lastModified: now })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.uploadStatus, 'uploading'),
        eq(drafts.uploadArtifactId, artifactId),
      ),
    )
    .returning({ id: drafts.id });
  return rows.length > 0;
}

/**
 * Unpair a draft whose upload failed or was cancelled: clear its upload columns — only while it's
 * still `uploading`, so a finished upload is never cleared. Given `artifactId`, only while it's
 * uploading that link, so an upload's own failure can't unpair a newer claim. Returns whether it
 * did; `false` means the upload already settled the other way.
 */
export async function burnUploadPairing(draftId: string, artifactId?: string): Promise<boolean> {
  const rows = await db
    .update(drafts)
    .set({ uploadServer: null, uploadArtifactId: null, uploadStatus: null, lastModified: now })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.uploadStatus, 'uploading'),
        artifactId === undefined ? undefined : eq(drafts.uploadArtifactId, artifactId),
      ),
    )
    .returning({ id: drafts.id });
  return rows.length > 0;
}

/** Drafts whose upload finished — at launch, the ones whose view link may still work. */
export async function getUploadedDraftIds(): Promise<string[]> {
  const rows = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.uploadStatus, 'uploaded'));
  return rows.map((r) => r.id);
}

/** Drafts marked `uploading` — at launch, the uploads a killed app never finished. */
export async function getUploadingDraftIds(): Promise<string[]> {
  const rows = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.uploadStatus, 'uploading'));
  return rows.map((r) => r.id);
}

// Draft transfer (.pulse export/import) ----------------------------------------------------

/** Load a draft's draft row + ordered segments for packing into a `.pulse` bundle. */
export async function getDraftForExport(
  draftId: string,
): Promise<{ draft: Draft; segments: Segment[] } | null> {
  const [draft] = await db.select().from(drafts).where(eq(drafts.id, draftId));
  if (!draft) return null;
  const rows = await segmentsForDraft(draftId);
  return { draft, segments: rows };
}

/**
 * Insert an imported draft and its segments in one transaction. Caller mints fresh ids and
 * writes the clip files first; this only commits the rows once the media is on disk.
 */
export async function insertImportedDraft(
  draft: typeof drafts.$inferInsert,
  segmentRows: (typeof segments.$inferInsert)[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(drafts).values(draft);
    if (segmentRows.length > 0) await tx.insert(segments).values(segmentRows);
  });
}

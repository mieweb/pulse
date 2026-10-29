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
import { canonicalEdit, editTimelineMs, parseEdit, type ParsedEdit } from '@/utils/segment-window';
import { generateThumbnailFile } from '@/utils/video';
import { db } from './client';
import type { PairedDestination } from './destinations';
import type { Draft, Segment } from './schema';
import { drafts, segments } from './schema';
import { deleteSavedLink } from './secure-token';

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
    // Its edit as settings (none for a legacy baked file), so the fallback shows the edited frame.
    firstSegmentEditState: sql<
      string | null
    >`(select case when edited_filename is null then edit_state end from ${segments} where ${segments.draftId} = ${drafts.id} order by sort_order limit 1)`,
  })
  .from(drafts)
  .leftJoin(segments, eq(segments.draftId, drafts.id))
  .groupBy(drafts.id)
  .orderBy(desc(drafts.lastModified));

/** Every draft's clips (what the editor's caches keep). */
export function allSegments() {
  return db.select().from(segments);
}

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
  // index backstops any regression). drizzle's expo-sqlite transactions are synchronous (they
  // commit when the callback returns), so the callback awaits nothing and runs each statement
  // with the sync `.all()` / `.get()` / `.run()`.
  db.transaction((tx) => {
    const [counter] = tx
      .update(drafts)
      .set({ lastClipNumber: sql`${drafts.lastClipNumber} + 1`, lastModified: now })
      .where(eq(drafts.id, draftId))
      .returning({ clipNumber: drafts.lastClipNumber })
      .all();
    if (!counter) throw new Error(`addSegment: draft ${draftId} not found`);

    const [{ maxOrder }] = tx
      .select({ maxOrder: sql<number | null>`max(${segments.order})` })
      .from(segments)
      .where(eq(segments.draftId, draftId))
      .all();

    tx.insert(segments)
      .values({
        id: segment.id,
        draftId,
        order: (maxOrder ?? -1) + 1,
        label: String(counter.clipNumber),
        originalFilename: segment.originalFilename,
        durationMs: segment.durationMs,
        thumbnail: segment.thumbnail ?? null,
      })
      .run();
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

/** Whether a clip is still in the database (not deleted, nor its draft). */
export async function segmentExists(segmentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: segments.id })
    .from(segments)
    .where(eq(segments.id, segmentId));
  return !!row;
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

/**
 * Work that follows a change already committed: its files and the draft's `lastModified`. It
 * can't undo the change, so a failure here is logged rather than thrown; a caller that rejected
 * would report the clip as not deleted (or not reverted) when it already was.
 */
async function afterCommit(what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.warn(`[drafts] ${what}: cleanup after the change failed`, e);
  }
}

async function touchDraft(draftId: string): Promise<void> {
  await db.update(drafts).set({ lastModified: now }).where(eq(drafts.id, draftId));
}

/** Delete a segment and its clip file, unless a sibling segment still references the file. */
export async function deleteSegment(segmentId: string): Promise<void> {
  const [seg] = await db.select().from(segments).where(eq(segments.id, segmentId));
  if (!seg) return;

  await beginClipMutation(seg.draftId);
  await db.delete(segments).where(eq(segments.id, segmentId));

  // The draft's timestamp on its own, so a file that won't delete can't leave Home's order stale.
  await afterCommit('delete clip', () => touchDraft(seg.draftId));
  await afterCommit('delete clip', async () => {
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
  });
}

/**
 * Save an edit as settings: the editor's `editState` (applied when the clip plays, and by the
 * export's merge), its timeline length (`editedDurationMs`, for the draft-list SQL), and a cover
 * rendered from the original with the edit applied. Nothing is encoded. Replaces any earlier edit
 * — a legacy baked file included, dropped once the row no longer points at it.
 */
export async function setEditState(segmentId: string, editState: string): Promise<void> {
  await saveEdit(segmentId, editState);
}

/** `setEditState` for a typed edit, stored in its canonical form (which `parseEdit` reads). */
export async function setClipEdit(segmentId: string, edit: ParsedEdit): Promise<void> {
  const editState = canonicalEdit(JSON.stringify(edit));
  if (!editState) throw new Error('Unusable clip edit');
  await saveEdit(segmentId, editState);
}

// Edit covers are revision-stamped with `Date.now()`, kept strictly increasing so two edits saved
// in the same millisecond never render into (or delete) the same file.
let lastCoverRev = 0;
function coverRev(): number {
  lastCoverRev = Math.max(Date.now(), lastCoverRev + 1);
  return lastCoverRev;
}

/**
 * Per clip, the edit or revert asked for last (its cover revision). The edit and its cover are
 * written together once the cover is rendered, so a save that finishes after a newer one started
 * stands down rather than land over it.
 */
const latestEditRev = new Map<string, number>();

async function saveEdit(segmentId: string, editState: string): Promise<void> {
  const edit = parseEdit(editState);
  const durationMs = editTimelineMs(editState);
  if (!edit || durationMs == null) throw new Error('The editor returned an unusable edit');
  const [seg] = await db.select().from(segments).where(eq(segments.id, segmentId));
  if (!seg) return;
  await beginClipMutation(seg.draftId);
  const rev = coverRev();
  latestEditRev.set(segmentId, rev);
  // The cover first (160–600 ms on a Galaxy S24), then the edit and its cover in one write: the
  // row never holds an edit with another edit's cover, whenever the app stops.
  const coverRel = editCoverRelPath(seg.draftId, segmentId, rev);
  const ok = await generateThumbnailFile(absolutize(seg.originalFilename), absolutize(coverRel), {
    editState,
    startMs: edit.startMs,
  }).catch(() => false);
  if (latestEditRev.get(segmentId) !== rev) {
    if (ok) deleteSegmentFile(coverRel);
    return;
  }
  // A cover that failed leaves none (the clip shows its own first frame) rather than an older
  // edit's. What the row held is read here, so the files it replaces are the ones it referenced.
  const previous = db.transaction((tx) => {
    const row = tx
      .select({ thumbnail: segments.thumbnail, editedFilename: segments.editedFilename })
      .from(segments)
      .where(eq(segments.id, segmentId))
      .get();
    tx.update(segments)
      .set({
        editState,
        editedDurationMs: durationMs,
        editedFilename: null,
        thumbnail: ok ? coverRel : null,
      })
      .where(eq(segments.id, segmentId))
      .run();
    return row;
  });
  await afterCommit('save edit', () => touchDraft(seg.draftId));
  await afterCommit('save edit', async () => {
    // Deleted meanwhile: nothing references the new cover.
    if (!previous) {
      if (ok) deleteSegmentFile(coverRel);
      return;
    }
    if (previous.editedFilename) deleteSegmentFile(previous.editedFilename);
    // Drop the replaced cover only now that the row points away from it; the pristine thumb
    // stays for a reset.
    if (previous.thumbnail && previous.thumbnail !== thumbRelPath(seg.draftId, segmentId)) {
      deleteSegmentFile(previous.thumbnail);
    }
  });
}

/**
 * Reset a segment back to its pristine original — clear the edit (settings and any legacy baked
 * file), so it plays whole and the editor next opens fresh.
 */
export async function resetEdit(segmentId: string): Promise<void> {
  const [seg] = await db.select().from(segments).where(eq(segments.id, segmentId));
  if (!seg) return;
  await beginClipMutation(seg.draftId);
  const rev = coverRev();
  latestEditRev.set(segmentId, rev);
  // As in `saveEdit`: the pristine cover first, then the cleared edit and that cover in one write,
  // unless a newer edit was asked for meanwhile.
  const thumbRel = thumbRelPath(seg.draftId, segmentId);
  const ok = await generateThumbnailFile(
    absolutize(seg.originalFilename),
    absolutize(thumbRel),
  ).catch(() => false);
  if (latestEditRev.get(segmentId) !== rev) return;
  const previous = db.transaction((tx) => {
    const row = tx
      .select({ thumbnail: segments.thumbnail, editedFilename: segments.editedFilename })
      .from(segments)
      .where(eq(segments.id, segmentId))
      .get();
    tx.update(segments)
      .set({
        editedFilename: null,
        editedDurationMs: null,
        editState: null,
        thumbnail: ok ? thumbRel : null,
      })
      .where(eq(segments.id, segmentId))
      .run();
    return row;
  });
  await afterCommit('revert edits', () => touchDraft(seg.draftId));
  await afterCommit('revert edits', async () => {
    // Drop the now-orphaned edited file and thumb only after the row no longer references them.
    const edited = previous?.editedFilename ?? seg.editedFilename;
    if (edited) {
      deleteSegmentFile(edited);
      deleteSegmentFile(editedThumbRelPath(edited));
    }
    // The prior cover, read as it was replaced — never the fresh `thumbRel`.
    if (previous?.thumbnail && previous.thumbnail !== thumbRel) {
      deleteSegmentFile(previous.thumbnail);
    }
  });
}

/** Persist a new clip ordering (ids in target order) for a single draft. */
export async function reorderSegments(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const [target] = await db.select().from(segments).where(eq(segments.id, orderedIds[0]));
  if (target) await beginClipMutation(target.draftId);
  db.transaction((tx) => {
    // Two passes: SQLite checks UNIQUE per statement, so renumbering in place would collide
    // with rows still holding their old slot. Park all rows on distinct negatives first,
    // then assign final slots via one CASE update.
    tx.update(segments)
      .set({ order: sql`-${segments.order} - 1` })
      .where(inArray(segments.id, orderedIds))
      .run();
    const finalOrder = sql`case ${sql.join(
      orderedIds.map((id, i) => sql`when ${segments.id} = ${id} then ${i}`),
      sql` `,
    )} else ${segments.order} end`;
    tx.update(segments).set({ order: finalOrder }).where(inArray(segments.id, orderedIds)).run();
    const first = tx.select().from(segments).where(eq(segments.id, orderedIds[0])).get();
    if (first) {
      tx.update(drafts).set({ lastModified: now }).where(eq(drafts.id, first.draftId)).run();
    }
  });
}

export async function renameDraft(draftId: string, name: string | null): Promise<void> {
  // Locked too — the name rides the upload as the video's title. The video itself doesn't
  // change, so the persisted export stays valid.
  await assertNotUploading(draftId);
  await db.update(drafts).set({ name, lastModified: now }).where(eq(drafts.id, draftId));
}

/** Delete a draft (segments cascade), its on-disk directory (clips + export) and its saved link. */
export async function deleteDraft(draftId: string): Promise<void> {
  await assertNotUploading(draftId);
  await db.delete(drafts).where(eq(drafts.id, draftId));
  deleteDraftDir(draftId);
  await deleteSavedLink(draftId);
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
  db.transaction((tx) => {
    tx.insert(drafts).values(draft).run();
    if (segmentRows.length > 0) tx.insert(segments).values(segmentRows).run();
  });
}

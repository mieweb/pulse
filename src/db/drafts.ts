import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import {
  absolutize,
  deleteDraftDir,
  deleteSegmentFile,
  editedThumbRelPath,
  thumbRelPath,
} from '@/utils/file-store';
import { generateThumbnailFile } from '@/utils/video';
import { db } from './client';
import type { PairedDestination } from './destinations';
import type { Draft, Segment } from './schema';
import { drafts, segments } from './schema';
import { deleteDraftToken, setDraftToken } from './secure-token';

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
  // Structural mutation — blocked while an upload is in flight (see assertNotUploading).
  await assertNotUploading(draftId);
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

/**
 * Structural mutations are FORBIDDEN while a draft is uploading — the UI locks
 * an uploading draft (no tap-in, no edits; cancel is the only action), so this
 * throwing is a programming-error backstop, not a user-reachable path. It
 * replaces the old invalidation machinery: with edits impossible mid-upload,
 * there is no in-flight session to abort and no resume state to wipe.
 */
export async function assertNotUploading(draftId: string): Promise<void> {
  const [row] = await db
    .select({ status: drafts.uploadStatus })
    .from(drafts)
    .where(eq(drafts.id, draftId));
  if (row?.status === 'uploading') {
    throw new Error(`Draft ${draftId} is uploading — mutations are locked until it finishes`);
  }
}

/**
 * Burn a spent pairing: reset the draft's upload columns to unpaired/editable and
 * drop its bearer token. Called on terminal failure, cancel, and the launch sweep —
 * the deep link is single-shot, so there is nothing to retry against; the user
 * pairs a fresh link. Only an 'uploading' row can burn: an 'uploaded' draft keeps its
 * columns (they're the watch link), and an unpaired row has nothing to burn.
 * Returns whether a pairing was actually burned — false means the row was already
 * settled (or gone), so its token and server-side artifacts must be left alone.
 * (Pairings from pre-single-shot builds were reset in SQL by migration 0014; their
 * leftover keychain tokens expire on their own.)
 */
export async function burnUploadPairing(draftId: string): Promise<boolean> {
  const burned = await db
    .update(drafts)
    .set({ uploadServer: null, uploadArtifactId: null, uploadStatus: null, lastModified: now })
    .where(and(eq(drafts.id, draftId), eq(drafts.uploadStatus, 'uploading')))
    .returning({ id: drafts.id });
  if (burned.length > 0) await deleteDraftToken(draftId);
  return burned.length > 0;
}

/** Delete a segment and its clip file, unless a sibling segment still references the file. */
export async function deleteSegment(segmentId: string): Promise<void> {
  const [seg] = await db.select().from(segments).where(eq(segments.id, segmentId));
  if (!seg) return;

  await assertNotUploading(seg.draftId);
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

/** Apply a destructive edit: point the segment at its new re-encoded file + duration. */
export async function setEdited(
  segmentId: string,
  editedFilename: string,
  editedDurationMs: number,
): Promise<void> {
  const [seg] = await db.select().from(segments).where(eq(segments.id, segmentId));
  if (!seg) return;
  await assertNotUploading(seg.draftId);
  // Cover the edited file's first frame at its revision-paired thumb path (the pristine thumb
  // stays on disk untouched, ready for a reset).
  const thumbRel = editedThumbRelPath(editedFilename);
  const ok = await generateThumbnailFile(absolutize(editedFilename), absolutize(thumbRel));
  await db
    .update(segments)
    .set({ editedFilename, editedDurationMs, thumbnail: ok ? thumbRel : seg.thumbnail })
    .where(eq(segments.id, segmentId));
  // Replacing a prior edit — drop its files only now that the row points at the new revision,
  // so a failure above never leaves the segment referencing deleted files. Keep the old thumb
  // as the cover fallback if the new one failed to generate.
  if (seg.editedFilename && seg.editedFilename !== editedFilename) {
    deleteSegmentFile(seg.editedFilename);
    if (ok) deleteSegmentFile(editedThumbRelPath(seg.editedFilename));
  }
  await db.update(drafts).set({ lastModified: now }).where(eq(drafts.id, seg.draftId));
}

/** Reset a segment back to its pristine original — delete the edited file, clear the columns. */
export async function resetEdit(segmentId: string): Promise<void> {
  const [seg] = await db.select().from(segments).where(eq(segments.id, segmentId));
  if (!seg) return;
  await assertNotUploading(seg.draftId);
  // Revert the cover to the pristine original's thumbnail.
  const thumbRel = thumbRelPath(seg.draftId, segmentId);
  const ok = await generateThumbnailFile(absolutize(seg.originalFilename), absolutize(thumbRel));
  await db
    .update(segments)
    .set({ editedFilename: null, editedDurationMs: null, thumbnail: ok ? thumbRel : null })
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
  if (target) await assertNotUploading(target.draftId);
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
  // The lock is absolute — even a rename waits (the name rides the upload as metadata).
  await assertNotUploading(draftId);
  await db.update(drafts).set({ name, lastModified: now }).where(eq(drafts.id, draftId));
}

/** Delete a draft (segments cascade) and remove its on-disk clip directory. */
export async function deleteDraft(draftId: string): Promise<void> {
  // The UI cancels any live upload before offering delete; this backstops it.
  await assertNotUploading(draftId);
  await db.delete(drafts).where(eq(drafts.id, draftId));
  deleteDraftDir(draftId);
  await deleteDraftToken(draftId);
}

// Upload destination (deep-link pairing) -----------------------------------------------------

/**
 * Pair a draft with an upload destination (from a validated deep link +
 * `/capabilities` lookup) and commit it to a run in the same durable write:
 * the row lands already `'uploading'`, so a kill at ANY later point — before
 * the in-memory session even exists — is caught by the launch sweep instead
 * of stranding a consumed pairing on an idle-looking draft. The bearer token
 * is written to expo-secure-store, not this row (§ token security).
 */
export async function setUploadDestination(
  draftId: string,
  destination: PairedDestination,
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
  await setDraftToken(draftId, destination.token);
}

/**
 * Settle a run as uploaded — a compare-and-set on the exact pairing that ran
 * (`'uploading'` + this artifactId), so a cancel or burn that landed first wins
 * and the caller learns it did (false). This is the one ownership rule for the
 * success path; there is no in-memory guard to keep in step with it.
 */
export async function markUploaded(draftId: string, artifactId: string): Promise<boolean> {
  const settled = await db
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
  return settled.length > 0;
}

/**
 * Drafts left with a stale `'uploading'` status — the app was killed mid-run (sessions are
 * in-memory only). The launch sweep settles exactly these: one probe of the artifact's own
 * serving URL decides uploaded-vs-burned. Never re-driven — pairings are single-shot.
 */
export async function getInterruptedUploads(): Promise<Draft[]> {
  return db.select().from(drafts).where(eq(drafts.uploadStatus, 'uploading'));
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

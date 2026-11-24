import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import {
  absolutize,
  copyRelFile,
  deleteDraftDir,
  deleteQuietly,
  deleteSegmentFile,
  editCoverRelPath,
  editedThumbRelPath,
  relFileExists,
  thumbRelPath,
} from '@/utils/file-store';
import { type ClipAnchor, END, isEnd, noteClipsAdded } from '@/core/clip-anchor';
import { canonicalEdit, editTimelineMs, parseEdit, type ParsedEdit } from '@/utils/segment-window';
import { coverFailed, generateThumbnailFile, markCoverInFlight } from '@/utils/video';
import { isCaptionsOff, parseCaptionEdit, setCaptionsOff } from './captions';
import { db } from './client';
import type { PairedDestination } from './destinations';
import {
  assertEditable,
  hostContextColumns,
  hostContextOf,
  LibraryError,
  type HostContext,
  type HostContextColumns,
} from './host-context';
import type { ClipTranscript, Draft, Segment } from './schema';
import { clipTranscripts, drafts, segments, uploadJobs } from './schema';
import { noteHeldFiles } from './held-files';
import { deleteSavedLink } from './secure-token';
import {
  cancelJobForChange,
  isLockedJobState,
  type JobChangeReason,
  type JobState,
} from './upload-jobs';

const now = sql`(unixepoch('subsec') * 1000)`;

/** A new clip for a draft; `thumbnail` is populated only when the camera/importer already
 * produced one, otherwise it's derived later from the first frame. A clip copied from another
 * draft (`copyClipsInto`) also brings its edit and captions. */
export type NewSegment = {
  id: string;
  originalFilename: string;
  durationMs: number;
  thumbnail?: string | null;
  editedFilename?: string | null;
  editedDurationMs?: number | null;
  editState?: string | null;
  captionEdit?: string | null;
};

/** A draft list row's columns: its segment count, trim-aware duration, and cover clip. */
const draftListFields = {
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
  // The place it was recorded for, if a link opened its recorder (see `drafts.contextServer`).
  // An unnamed draft is called by that place's label while the place's destination is in the
  // pool: read live from the pool by whoever shows it (`usePlaceLabels`), never stored here.
  contextServer: drafts.contextServer,
  contextRef: drafts.contextRef,
};

/** One row per draft with its segment count, trim-aware duration, and cover clip. */
export const draftListQuery = db
  .select(draftListFields)
  .from(drafts)
  .leftJoin(segments, eq(segments.draftId, drafts.id))
  .groupBy(drafts.id)
  .orderBy(desc(drafts.lastModified));

/**
 * The drafts clips can be copied from into `draftId` ("From another Pulse"): every other draft
 * with a clip, newest first, as `draftListQuery` rows. `null`: every draft with a clip (a recorder
 * that hasn't made its draft yet). The library is the account's (one per namespace in the embed,
 * `setStorageRoots`), so this is the account's drafts.
 */
export function otherDraftsQuery(draftId: string | null) {
  return db
    .select(draftListFields)
    .from(drafts)
    .innerJoin(segments, eq(segments.draftId, drafts.id))
    .where(draftId ? ne(drafts.id, draftId) : undefined)
    .groupBy(drafts.id)
    .orderBy(desc(drafts.lastModified));
}

/**
 * A clip of another draft than `draftId` (any draft's, for `null`), or none: whether "From another
 * Pulse" has anything to offer. It stops at the first such clip, cheap enough to keep live while a
 * screen is open (it re-runs on every clip write); the full list (`otherDraftsQuery`) is read only
 * while its sheet shows.
 */
export function anotherDraftClipQuery(draftId: string | null) {
  return db
    .select({ id: segments.id })
    .from(segments)
    .where(draftId ? ne(segments.draftId, draftId) : undefined)
    .limit(1);
}

/**
 * What a draft is called where it's shown: its own name, else the label of the place it was
 * recorded for while that place's destination is in the pool (`placeLabel`), else "Untitled".
 * Uploads send only its own name (`getDraftName`).
 */
export function draftDisplayName(name: string | null, placeLabel: string | null): string {
  return name || placeLabel || 'Untitled';
}

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

/** The place a draft is recorded for: a link's server and `ref` (see `drafts.contextServer`). */
export type DraftContext = { server: string; ref: string };

/**
 * A new draft. Opened from a link that names a place, it is named with the link's `name` (or not
 * at all) and remembers that place (`context`). Recorded for a host's place (embedded), it stores
 * that place and its upload type (`hostContext`, `uploadType`, checked: `invalid_options`), and
 * `createdVia` says which shell made it.
 */
export async function createDraft(
  opts: {
    name?: string | null;
    context?: DraftContext | null;
    hostContext?: HostContext | null;
    uploadType?: unknown;
    createdVia?: 'app' | 'host';
  } = {},
): Promise<string> {
  assertEditable();
  const host = opts.hostContext ? hostContextColumns(opts.hostContext, opts.uploadType) : null;
  const id = Crypto.randomUUID();
  await db.insert(drafts).values({
    id,
    name: opts.name ?? null,
    contextServer: opts.context?.server ?? null,
    contextRef: opts.context?.ref ?? null,
    ...host,
    createdVia: opts.createdVia ?? 'app',
  });
  return id;
}

/**
 * The host place a draft's columns hold, as the host handed it over (with its upload type and
 * `data`), and with `kind` and `id` taken from the key (`kind:id`) when it didn't spell them out:
 * what a flow that reopens the draft returns as its context. Null for a draft without one.
 */
export function draftHostContext(columns: {
  [K in keyof HostContextColumns]: HostContextColumns[K] | null;
}): (HostContext & { kind: string; id: string }) | null {
  const context = hostContextOf(columns);
  if (!context) return null;
  const colon = context.key.indexOf(':');
  return {
    ...context,
    kind: typeof context.kind === 'string' ? context.kind : context.key.slice(0, colon),
    id: typeof context.id === 'string' ? context.id : context.key.slice(colon + 1),
  };
}

/**
 * Move an unsent draft to another host place (Move to…): its context and upload type, checked as
 * at birth (`invalid_options`). Refused with `draft.locked` while it uploads, and with reason
 * `clock_bound` once the host confirmed its Send: the clock action that ran for it stays its own.
 */
export async function setDraftContext(
  draftId: string,
  context: HostContext,
  uploadType?: unknown,
): Promise<void> {
  assertEditable();
  const columns = hostContextColumns(context, uploadType);
  const jobState = await readUploadLock(draftId);
  if (jobState) {
    // Checked before the job is taken out: a refused move leaves its Send queued.
    const row = db
      .select({ hostConfirmedAt: drafts.hostConfirmedAt })
      .from(drafts)
      .where(eq(drafts.id, draftId))
      .get();
    if (row?.hostConfirmedAt != null) throw clockBound(draftId);
    cancelJobForChange(draftId, 'edited');
  }
  db.transaction((tx) => {
    const row = tx
      .select({ hostConfirmedAt: drafts.hostConfirmedAt })
      .from(drafts)
      .where(eq(drafts.id, draftId))
      .get();
    if (!row) throw new LibraryError('not_found', `Draft ${draftId} doesn't exist.`);
    if (row.hostConfirmedAt != null) throw clockBound(draftId);
    tx.update(drafts)
      .set({ ...columns, lastModified: now })
      .where(eq(drafts.id, draftId))
      .run();
  });
}

function clockBound(draftId: string): LibraryError {
  return new LibraryError(
    'draft.locked',
    `Draft ${draftId} belongs to the clock action its Send confirmed.`,
    'clock_bound',
  );
}

/**
 * The draft a host's `record` for a place continues: the newest one recorded for that place
 * (`contextKey`) and upload type that hasn't been sent (no outbox job) and has a clip; an empty one
 * is about to be dropped by the recorder that made it. `null` when there's none.
 */
export async function findOpenHostDraft(
  contextKey: string,
  uploadTypeId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.contextKey, contextKey),
        sql`json_extract(${drafts.uploadTypeJson}, '$.id') = ${uploadTypeId}`,
        sql`not exists (select 1 from ${uploadJobs} where ${uploadJobs.draftId} = ${drafts.id})`,
        sql`exists (select 1 from ${segments} where ${segments.draftId} = ${drafts.id})`,
      ),
    )
    .orderBy(desc(drafts.lastModified))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The draft's place (null columns when it has none), its own name and whether it is uploading or
 * uploaded: live, for the export screen.
 */
export function draftPlaceQuery(draftId: string) {
  return db
    .select({
      server: drafts.contextServer,
      ref: drafts.contextRef,
      name: drafts.name,
      uploadStatus: drafts.uploadStatus,
    })
    .from(drafts)
    .where(eq(drafts.id, draftId));
}

/**
 * The draft a link for a place reopens: the newest one recorded for that place that hasn't been
 * uploaded (or started uploading) and has a clip — an empty one is about to be dropped by the
 * recorder that made it. A draft whose upload failed or was cancelled is unsent again, so the
 * place's next link comes back to it. `null` when there's none, and the link starts a new one.
 */
export async function findOpenDraftForContext(context: DraftContext): Promise<string | null> {
  const [row] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.contextServer, context.server),
        eq(drafts.contextRef, context.ref),
        isNull(drafts.uploadStatus),
        sql`exists (select 1 from ${segments} where ${segments.draftId} = ${drafts.id})`,
      ),
    )
    .orderBy(desc(drafts.lastModified))
    .limit(1);
  return row?.id ?? null;
}

/** Add a clip at the end of the draft, or at `anchor` (`insertSegments`). */
export async function addSegment(
  draftId: string,
  segment: NewSegment,
  anchor: ClipAnchor | (() => ClipAnchor) = END,
): Promise<void> {
  await insertSegments(draftId, anchor, [segment]);
}

/**
 * Add clips to a draft, contiguously and in the order given, at `anchor`: before a clip of this
 * draft, or at the end. An anchor whose clip has gone (deleted, or in another draft) means its
 * `next` clip, else the end, so a wait never loses a take or moves it elsewhere (`ClipAnchor`).
 * `anchor` may be a function: it is then read once the draft's earlier clip writes are done, just
 * before the transaction, so a cursor that moved meanwhile is followed. Returns the new clips' ids
 * in order, and tells `onClipsAdded` listeners once they're committed. `transcripts` (copied
 * clips' `clip_transcripts` rows, keyed by the new ids) go in with them.
 *
 * Everything is read-then-write, so it all runs inside one transaction: each badge number comes
 * from the draft's monotonic `lastClipNumber` counter (bumped by `k` and read back atomically;
 * never decremented, so deletes/renames can't cause reuse), and the new clips take the `k` slots
 * from the anchor's, the clips from there on moving up by `k` (holes after deletes are kept). The
 * unique (draftId, order) index is checked row by row, so those clips are parked on distinct
 * negatives first and then set to their old slot + k, as `reorderSegments` does. drizzle's
 * expo-sqlite transactions are synchronous (they commit when the callback returns), so the
 * callback awaits nothing and runs each statement with the sync `.all()` / `.get()` / `.run()`.
 */
export async function insertSegments(
  draftId: string,
  anchorOrGet: ClipAnchor | (() => ClipAnchor),
  newSegments: readonly NewSegment[],
  transcripts: readonly (typeof clipTranscripts.$inferInsert)[] = [],
): Promise<string[]> {
  if (newSegments.length === 0) return [];
  await beginClipMutation(draftId);
  const anchor = typeof anchorOrGet === 'function' ? anchorOrGet() : anchorOrGet;
  const k = newSegments.length;
  db.transaction((tx) => {
    const [counter] = tx
      .update(drafts)
      .set({ lastClipNumber: sql`${drafts.lastClipNumber} + ${k}`, lastModified: now })
      .where(eq(drafts.id, draftId))
      .returning({ clipNumber: drafts.lastClipNumber })
      .all();
    if (!counter) throw new Error(`insertSegments: draft ${draftId} not found`);

    const at = insertSlot(tx, draftId, anchor);
    if (at.shift) shiftFrom(tx, draftId, at.order, k);

    const firstLabel = counter.clipNumber - k + 1;
    tx.insert(segments)
      .values(
        newSegments.map((segment, i) => ({
          id: segment.id,
          draftId,
          order: at.order + i,
          label: String(firstLabel + i),
          originalFilename: segment.originalFilename,
          durationMs: segment.durationMs,
          thumbnail: segment.thumbnail ?? null,
          editedFilename: segment.editedFilename ?? null,
          editedDurationMs: segment.editedDurationMs ?? null,
          editState: segment.editState ?? null,
          captionEdit: segment.captionEdit ?? null,
        })),
      )
      .run();
    if (transcripts.length > 0)
      tx.insert(clipTranscripts)
        .values([...transcripts])
        .run();
  });
  const segmentIds = newSegments.map((s) => s.id);
  noteClipsAdded({ draftId, segmentIds });
  return segmentIds;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Move the draft's clips from slot `from` on up by `k`, in two passes (parked on distinct
 * negatives first) so the unique (draft, order) index never sees two rows on one slot.
 */
function shiftFrom(tx: Tx, draftId: string, from: number, k: number): void {
  tx.update(segments)
    .set({ order: sql`-${segments.order} - 1` })
    .where(sql`${segments.draftId} = ${draftId} and ${segments.order} >= ${from}`)
    .run();
  tx.update(segments)
    .set({ order: sql`-${segments.order} - 1 + ${k}` })
    .where(and(eq(segments.draftId, draftId), sql`${segments.order} < 0`))
    .run();
}

/** The slot of clip `id` in the draft, if it is there. */
function orderOf(tx: Tx, draftId: string, id: string): number | undefined {
  return tx
    .select({ order: segments.order })
    .from(segments)
    .where(and(eq(segments.id, id), eq(segments.draftId, draftId)))
    .get()?.order;
}

/**
 * The slot new clips take for `anchor`, and whether the clips from that slot on must move up: the
 * anchor clip's slot, else (it has gone) its `next` clip's, else the end (max + 1, hole-tolerant
 * after deletes).
 */
function insertSlot(
  tx: Tx,
  draftId: string,
  anchor: ClipAnchor,
): { order: number; shift: boolean } {
  if (!isEnd(anchor)) {
    for (const id of [anchor.before, anchor.next]) {
      const order = id == null ? undefined : orderOf(tx, draftId, id);
      if (order !== undefined) return { order, shift: true };
    }
  }
  const [{ maxOrder }] = tx
    .select({ maxOrder: sql<number | null>`max(${segments.order})` })
    .from(segments)
    .where(eq(segments.draftId, draftId))
    .all();
  return { order: (maxOrder ?? -1) + 1, shift: false };
}

/**
 * Whether a draft exists and can take a new clip: it isn't uploading, by its status or its outbox
 * job (see `assertNotUploading`).
 */
export async function draftTakesClips(draftId: string): Promise<boolean> {
  const [row] = await db
    .select({
      status: drafts.uploadStatus,
      jobState: sql<JobState | null>`(select ${uploadJobs.state} from ${uploadJobs} where ${uploadJobs.draftId} = ${drafts.id})`,
    })
    .from(drafts)
    .where(eq(drafts.id, draftId));
  return (
    row != null &&
    row.status !== 'uploading' &&
    !(row.jobState != null && isLockedJobState(row.jobState))
  );
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
 *
 * Two upload states, one per shell, read in one query (AD33): the Pulse app's `upload_status`
 * ('uploading' locks), and an embedded draft's outbox job, which locks while it prepares, uploads
 * or delivers and refuses with `draft.locked` (a queued, paused or failed job is taken out by the
 * edit instead: `takeOutForChange`, which every edit and delete runs).
 */
export async function assertNotUploading(draftId: string): Promise<void> {
  await readUploadLock(draftId);
}

/** `assertNotUploading`, returning the state of the draft's outbox job (null: none). */
async function readUploadLock(draftId: string): Promise<JobState | null> {
  const [row] = await db
    .select({
      status: drafts.uploadStatus,
      jobState: sql<JobState | null>`(select ${uploadJobs.state} from ${uploadJobs} where ${uploadJobs.draftId} = ${drafts.id})`,
    })
    .from(drafts)
    .where(eq(drafts.id, draftId));
  if (row?.status === 'uploading') {
    throw new Error(`Draft ${draftId} is uploading — cancel the upload to edit it`);
  }
  if (row?.jobState && isLockedJobState(row.jobState)) {
    throw new LibraryError(
      'draft.locked',
      `Draft ${draftId} is uploading (${row.jobState}): it goes up as it was at Send.`,
    );
  }
  return row?.jobState ?? null;
}

/**
 * Before an edit or delete changes the draft: refuse while it uploads (`assertNotUploading`), and
 * take a queued, paused or failed outbox job out (pulse-schema.md §3.3), so the job never sends
 * the cut from before the edit and the host's target is released. The next Send makes a new
 * clientKey. A draft without a job (every standalone one) costs no more than the lock check.
 */
async function takeOutForChange(draftId: string, reason: JobChangeReason): Promise<void> {
  if (await readUploadLock(draftId)) cancelJobForChange(draftId, reason);
}

/**
 * Entry point of every clip mutation (add/delete/trim/reset/reorder): refuse while uploading.
 * The persisted merged export is deliberately left alone — the export screen compares its
 * signature with the clips on arrival, so edits that are undone (reorder back, reset a trim,
 * delete an added clip) reuse it, and anything still changed merges again.
 */
/**
 * Mark a just-recorded clip's cover as on its way, before its row goes in (`addSegment` with no
 * thumbnail), so its tile waits for `addSegmentCover` instead of extracting a frame itself.
 */
export function expectSegmentCover(originalFilename: string) {
  markCoverInFlight(absolutize(originalFilename));
}

/**
 * A just-recorded clip's cover, made after its row so the clip shows as soon as it's saved (see
 * the recorder). Written only onto a row still without a cover or an edit: an edit saved
 * meanwhile brought its own.
 */
export async function addSegmentCover(
  draftId: string,
  segmentId: string,
  originalFilename: string,
): Promise<void> {
  const video = absolutize(originalFilename);
  // Takes a revision like `saveEdit` and `resetEdit`: an edit or reset asked for while this cover
  // renders owns the clip's cover from then on. Its own revision-stamped file, as an edit's
  // cover, never the pristine path a reset writes, so dropping it can't take a reset's cover.
  const rev = coverRev();
  latestEditRev.set(segmentId, rev);
  const coverRel = editCoverRelPath(draftId, segmentId, rev);
  const ok = await generateThumbnailFile(video, absolutize(coverRel)).catch(() => false);
  const applied =
    ok &&
    latestEditRev.get(segmentId) === rev &&
    db
      .update(segments)
      .set({ thumbnail: coverRel })
      .where(
        and(eq(segments.id, segmentId), isNull(segments.thumbnail), isNull(segments.editState)),
      )
      .returning({ id: segments.id })
      .all().length > 0;
  if (applied) return;
  if (ok) deleteSegmentFile(coverRel);
  coverFailed(video);
}

async function beginClipMutation(draftId: string): Promise<void> {
  assertEditable();
  await takeOutForChange(draftId, 'edited');
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
  // No `assertEditable`: Send merges and records the export, and a library a newer Pulse migrated
  // still sends (AD34). Edits clear it only after their own check.
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
  await afterCommit('delete clip', () => deleteRowFiles(seg));
}

/**
 * The files a deleted segment row used: its clip, its legacy edited file and both covers. The row
 * must be gone first. A file another row still uses (rows can share a clip: a legacy duplicate, a
 * project import) or one held for a redo (`takeOutSegments`) stays.
 */
async function deleteRowFiles(seg: Segment): Promise<void> {
  for (const rel of rowFiles(seg)) {
    if (heldFiles.has(rel) || (await fileInUse(rel))) continue;
    deleteSegmentFile(rel);
  }
}

/** Every file a row points at or owns (the row's cover may not match either derived path, e.g. a
 * prior revision's thumb kept as a fallback after a failed regeneration). */
function rowFiles(seg: Segment): string[] {
  const files = [seg.originalFilename, thumbRelPath(seg.draftId, seg.id)];
  if (seg.editedFilename) files.push(seg.editedFilename, editedThumbRelPath(seg.editedFilename));
  if (seg.thumbnail) files.push(seg.thumbnail);
  return [...new Set(files)];
}

/** Whether any row (in any draft) still plays or shows `rel`. */
async function fileInUse(rel: string): Promise<boolean> {
  const [{ value }] = await db
    .select({ value: count() })
    .from(segments)
    .where(
      or(
        eq(segments.originalFilename, rel),
        eq(segments.editedFilename, rel),
        eq(segments.thumbnail, rel),
      ),
    );
  return value > 0;
}

/** Files of clips taken out and not yet put back or dropped, with how many take-outs hold each. */
const heldFiles = new Map<string, number>();
const holding = new Set<TakenOutClips>();
function hold(taken: TakenOutClips): void {
  if (holding.has(taken)) return;
  holding.add(taken);
  for (const row of taken.rows) {
    for (const rel of rowFiles(row)) heldFiles.set(rel, (heldFiles.get(rel) ?? 0) + 1);
  }
}
function release(taken: TakenOutClips): void {
  if (!holding.delete(taken)) return;
  for (const row of taken.rows) {
    for (const rel of rowFiles(row)) {
      const left = (heldFiles.get(rel) ?? 0) - 1;
      if (left > 0) heldFiles.set(rel, left);
      else heldFiles.delete(rel);
    }
  }
}

/**
 * Clips taken out of a draft by the editor's undo of an addition, kept so a redo can put them
 * back (`restoreSegments`): the rows as they were, their transcripts, and the draft's order then.
 * Their files stay on disk until `dropTakenOut`.
 */
export type TakenOutClips = {
  draftId: string;
  /** The draft's clip ids in order, before they were taken out. */
  order: string[];
  rows: Segment[];
  transcripts: ClipTranscript[];
};

/**
 * Take clips out of their draft (the undo of adding them), keeping their files: the rows go (the
 * draft reads as if they were never added), and what's needed to put them back is returned.
 * Clips already gone are skipped; null when none of them is left.
 */
export async function takeOutSegments(
  segmentIds: readonly string[],
): Promise<TakenOutClips | null> {
  if (segmentIds.length === 0) return null;
  const [first] = await db
    .select({ draftId: segments.draftId })
    .from(segments)
    .where(inArray(segments.id, [...segmentIds]))
    .limit(1);
  if (!first) return null;
  const { draftId } = first;
  await beginClipMutation(draftId);
  const taken = db.transaction((tx) => {
    const all = tx
      .select()
      .from(segments)
      .where(eq(segments.draftId, draftId))
      .orderBy(asc(segments.order))
      .all();
    const wanted = new Set(segmentIds);
    const rows = all.filter((r) => wanted.has(r.id));
    if (rows.length === 0) return null;
    const ids = rows.map((r) => r.id);
    const transcripts = tx
      .select()
      .from(clipTranscripts)
      .where(inArray(clipTranscripts.segmentId, ids))
      .all();
    tx.delete(segments).where(inArray(segments.id, ids)).run();
    tx.update(drafts).set({ lastModified: now }).where(eq(drafts.id, draftId)).run();
    // Noted on disk too: if Pulse dies with the redo pending, the next launch deletes them.
    noteHeldFiles(tx, rows.flatMap(rowFiles));
    return { draftId, order: all.map((r) => r.id), rows, transcripts };
  });
  // Its files are kept for the redo, whatever else is deleted meanwhile.
  if (taken) hold(taken);
  return taken;
}

/**
 * Put clips `takeOutSegments` took out back (the redo of adding them), with their labels, edits,
 * captions and transcripts: each where it was, after the clip it followed then (or before the one
 * it preceded) if that clip is still here, else at the end. Tells no clips-added listener: this
 * is the same addition again, not a new one. A draft that has gone takes nothing back, and its
 * files are no longer held (its folder went with it).
 */
export async function restoreSegments(taken: TakenOutClips): Promise<void> {
  const { draftId } = taken;
  if (taken.rows.length === 0) return;
  await beginClipMutation(draftId);
  db.transaction((tx) => {
    const draft = tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, draftId)).get();
    if (!draft) return;
    const byId = new Map(taken.rows.map((r) => [r.id, r]));
    const present = new Set(
      tx
        .select({ id: segments.id })
        .from(segments)
        .where(eq(segments.draftId, draftId))
        .all()
        .map((r) => r.id),
    );
    // In the old order, so each clip finds the one before it already back.
    for (const [i, id] of taken.order.entries()) {
      const row = byId.get(id);
      if (!row || present.has(id)) continue;
      const before = taken.order
        .slice(0, i)
        .reverse()
        .find((x) => present.has(x));
      const after = taken.order.slice(i + 1).find((x) => present.has(x));
      const prevOrder = before === undefined ? undefined : orderOf(tx, draftId, before);
      const at =
        prevOrder !== undefined
          ? { order: prevOrder + 1, shift: true }
          : insertSlot(tx, draftId, after ? { before: after } : END);
      if (at.shift) shiftFrom(tx, draftId, at.order, 1);
      tx.insert(segments)
        .values({ ...row, draftId, order: at.order })
        .run();
      present.add(id);
    }
    const back = taken.transcripts.filter((t) => byId.has(t.segmentId));
    if (back.length) tx.insert(clipTranscripts).values(back).onConflictDoNothing().run();
    tx.update(drafts).set({ lastModified: now }).where(eq(drafts.id, draftId)).run();
  });
  // Its rows point at its files again, which keeps them; or nothing can put them back.
  release(taken);
}

/**
 * The files of clips taken out and never put back (the editor's redo history is gone): deleted as
 * `deleteSegment` would. A clip that is back in a draft keeps its files.
 */
export async function dropTakenOut(taken: TakenOutClips): Promise<void> {
  release(taken);
  for (const row of taken.rows) {
    if (await segmentExists(row.id)) continue;
    await afterCommit('drop undone clip', () => deleteRowFiles(row));
  }
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

/**
 * Persist a new clip ordering (ids in target order) for a single draft: the clips named take the
 * slots they hold between them, in this order, and every other clip keeps its own. So an order
 * worked out before clips were inserted (the editor's queued write, `draft-writes.ts`) still
 * applies over them without colliding: the new clips stay where they went, and ids that have
 * gone are skipped.
 */
export async function reorderSegments(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const [target] = await db
    .select({ draftId: segments.draftId })
    .from(segments)
    .where(inArray(segments.id, orderedIds))
    .limit(1);
  if (!target) return;
  await beginClipMutation(target.draftId);
  db.transaction((tx) => {
    const rows = tx
      .select({ id: segments.id, order: segments.order })
      .from(segments)
      .where(and(eq(segments.draftId, target.draftId), inArray(segments.id, orderedIds)))
      .orderBy(asc(segments.order))
      .all();
    const present = new Set(rows.map((r) => r.id));
    const ids = [...new Set(orderedIds)].filter((id) => present.has(id));
    if (ids.length === 0) return;
    // Two passes: SQLite checks UNIQUE per row, so renumbering in place would collide with rows
    // still holding their old slot. Park these rows on distinct negatives first, then assign
    // their final slots (the ones they held: no other row has them) via one CASE update.
    tx.update(segments)
      .set({ order: sql`-${segments.order} - 1` })
      .where(inArray(segments.id, ids))
      .run();
    const finalOrder = sql`case ${sql.join(
      ids.map((id, i) => sql`when ${segments.id} = ${id} then ${rows[i].order}`),
      sql` `,
    )} else ${segments.order} end`;
    tx.update(segments).set({ order: finalOrder }).where(inArray(segments.id, ids)).run();
    tx.update(drafts).set({ lastModified: now }).where(eq(drafts.id, target.draftId)).run();
  });
}

export async function renameDraft(draftId: string, name: string | null): Promise<void> {
  // Locked too — the name rides the upload as the video's title. The video itself doesn't
  // change, so the persisted export stays valid.
  assertEditable();
  await takeOutForChange(draftId, 'edited');
  await db.update(drafts).set({ name, lastModified: now }).where(eq(drafts.id, draftId));
}

/**
 * Turn the draft's captions off or back on (the embed's per-video switch). Locked like a rename:
 * the captions ride the Send as their own part, so a queued, paused or failed Send is taken out
 * (the next Send writes its parts again) and one that is uploading refuses with `draft.locked`.
 * Setting what is already set changes nothing, a queued Send included.
 */
export async function setDraftCaptionsOff(draftId: string, off: boolean): Promise<void> {
  // An edit, refused before the queued Send is taken out.
  assertEditable();
  if ((await isCaptionsOff(draftId)) === off) return;
  await takeOutForChange(draftId, 'edited');
  await setCaptionsOff(draftId, off);
}

/**
 * Copy a draft under a fresh id: its clips' files, and its rows with edits, clip names, captions
 * and clip transcripts carried over, their paths pointing at the copies. Not carried: the upload
 * pairing (a copy is a new, unsent draft), the place (a link's or a host's: a copy isn't for the
 * original's place) and the merged export (derived, merged again on export). The files are
 * copied first and the rows committed in one transaction; a failure removes the copy's files.
 * Returns the new draft's id.
 */
export async function duplicateDraft(draftId: string): Promise<string> {
  assertEditable();
  const source = await getDraftForExport(draftId);
  if (!source) throw new Error(`duplicateDraft: draft ${draftId} not found`);
  const copyId = Crypto.randomUUID();
  const newIds = new Map(source.segments.map((s) => [s.id, Crypto.randomUUID()]));
  // A file named after something else (e.g. a clip sharing another's original) keeps its name:
  // the copy's folder is new.
  const remap = clipFileRemap(copyId, (stem) => newIds.get(stem) ?? stem);
  const transcripts =
    newIds.size === 0
      ? []
      : await db
          .select()
          .from(clipTranscripts)
          .where(inArray(clipTranscripts.segmentId, [...newIds.keys()]));

  try {
    const segmentRows: (typeof segments.$inferInsert)[] = [];
    // Clips can share an original: each file is copied once.
    const copied = new Set<string>();
    for (const seg of source.segments) {
      const files = [seg.originalFilename, seg.editedFilename].filter((f): f is string => !!f);
      for (const rel of files) {
        if (copied.has(rel)) continue;
        copied.add(rel);
        if (!(await copyRelFile(rel, remap(rel)))) {
          console.warn('[drafts] duplicate: missing clip file', rel);
          throw new Error('One of its clips’ video is missing.');
        }
      }
      // A cover that won't copy leaves none (the clip shows its own first frame).
      const thumbnail =
        seg.thumbnail && (await copyRelFile(seg.thumbnail, remap(seg.thumbnail)))
          ? remap(seg.thumbnail)
          : null;
      const caption = parseCaptionEdit(seg.captionEdit);
      segmentRows.push({
        ...seg,
        id: newIds.get(seg.id)!,
        draftId: copyId,
        originalFilename: remap(seg.originalFilename),
        editedFilename: seg.editedFilename ? remap(seg.editedFilename) : null,
        thumbnail,
        captionEdit: caption ? JSON.stringify({ ...caption, file: remap(caption.file) }) : null,
      });
    }
    db.transaction((tx) => {
      tx.insert(drafts)
        .values({
          id: copyId,
          name: `${source.draft.name || 'Untitled'} copy`,
          captionY: source.draft.captionY,
          lastClipNumber: source.draft.lastClipNumber,
          createdVia: source.draft.createdVia,
        })
        .run();
      if (segmentRows.length > 0) tx.insert(segments).values(segmentRows).run();
      if (transcripts.length > 0) {
        tx.insert(clipTranscripts)
          .values(
            transcripts.map((t) => ({
              ...t,
              segmentId: newIds.get(t.segmentId)!,
              file: remap(t.file),
            })),
          )
          .run();
      }
    });
  } catch (e) {
    deleteDraftDir(copyId);
    throw e;
  }
  return copyId;
}

/**
 * Where a copied clip's files go in draft `draftId`: `drafts/{draft}/segments/{stem}.…` → the
 * draft's segments folder, the name's stem (a clip id, for every file but a clip sharing another's
 * original) given by `stemFor`, the rest of the name (`.edited.{rev}.mp4`, `.cover.{rev}.jpg`) kept.
 */
function clipFileRemap(draftId: string, stemFor: (stem: string) => string) {
  return (rel: string) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const stem = name.split('.')[0];
    return `drafts/${draftId}/segments/${stemFor(stem)}${name.slice(stem.length)}`;
  };
}

/** What `copyClipsInto` did. */
export type CopiedClips = {
  /** The draft they went to; null when a function target was never needed (nothing to copy). */
  draftId: string | null;
  /** The copies' ids, in their order in the target draft (the source's order). */
  segmentIds: string[];
  /** Clips asked for and not copied: gone from the source by then, or their video missing. */
  skipped: number;
};

/**
 * Copy clips of one draft into another at `anchor` ("From another Pulse", #308), in the source's
 * order: each clip's files (its video, a legacy baked edit's file, its cover) under fresh ids, and
 * its row with its edit (trim, speed, rotation, flip, crop, mute), its captions (`captionEdit`)
 * and its clip transcripts, their paths pointing at the copies. The copies get the target's next
 * clip numbers, and go in through `insertSegments`, so they're one addition (the editor's one undo
 * step). The source is only read: it may be locked (uploading); the target may not, and a locked
 * one is refused before anything is copied. `target` may be a function (a recorder that hasn't
 * made its draft yet): it's called just before the first file is copied, so a copy with nothing
 * to copy (every video missing) makes no draft (`draftId` null).
 *
 * The clips are as they were when the copy started: a clip deleted from the source meanwhile, or
 * one whose video is missing, is skipped (`skipped`); one whose cover went meanwhile (an edit
 * replacing it) comes without one and shows its own first frame. The files are copied first
 * (`onProgress(done, total)` after each clip), then the rows go in in one transaction. A file
 * copy that fails (a full disk), or a transaction that does, deletes every copy's files and
 * throws: nothing is added.
 */
export async function copyClipsInto(
  target: string | (() => Promise<string>),
  sourceDraftId: string,
  segmentIds: readonly string[],
  anchor: ClipAnchor | (() => ClipAnchor),
  onProgress?: (done: number, total: number) => void,
): Promise<CopiedClips> {
  assertEditable();
  const checkTarget = async (id: string) => {
    if (id === sourceDraftId) throw new Error('copyClipsInto: clips are copied into another draft');
    await assertNotUploading(id);
    const [row] = await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, id));
    if (!row) throw new LibraryError('not_found', `Draft ${id} doesn't exist.`);
  };
  let targetDraftId = typeof target === 'string' ? target : null;
  if (targetDraftId !== null) await checkTarget(targetDraftId);

  const wanted = new Set(segmentIds);
  const rows = (await segmentsForDraft(sourceDraftId)).filter((s) => wanted.has(s.id));
  const transcripts =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(clipTranscripts)
          .where(
            inArray(
              clipTranscripts.segmentId,
              rows.map((r) => r.id),
            ),
          );
  const newIds = new Map(rows.map((r) => [r.id, Crypto.randomUUID()]));
  // A file named after something else (a clip sharing another's original) gets a fresh name too:
  // the target may already hold an earlier copy of it under its old one.
  const otherStems = new Map<string, string>();
  const stemFor = (stem: string) => {
    const id = newIds.get(stem) ?? otherStems.get(stem) ?? Crypto.randomUUID();
    if (!newIds.has(stem)) otherStems.set(stem, id);
    return id;
  };
  // The target's paths, once it's known: a function target is called (and checked) just before
  // the first file is copied, so nothing to copy makes no draft.
  let remapInto: ((rel: string) => string) | null = null;
  const remap = (rel: string) => {
    if (!remapInto) throw new Error('copyClipsInto: no target yet');
    return remapInto(rel);
  };
  const resolveTarget = async () => {
    if (targetDraftId === null) {
      targetDraftId = await (target as () => Promise<string>)();
      await checkTarget(targetDraftId);
    }
    remapInto ??= clipFileRemap(targetDraftId, stemFor);
  };

  // Each file once (clips can share an original), and every copy written, for the clean-up. False
  // only when the source file is missing (that clip is skipped); a copy that fails (a full disk)
  // throws, its partial file removed, and ends the whole copy below.
  const copiedOk = new Map<string, boolean>();
  const written: string[] = [];
  const copy = async (rel: string): Promise<boolean> => {
    const known = copiedOk.get(rel);
    if (known !== undefined) return known;
    let ok = relFileExists(rel);
    if (ok) {
      await resolveTarget();
      const to = remap(rel);
      try {
        ok = await copyRelFile(rel, to);
      } catch (e) {
        deleteQuietly(absolutize(to));
        throw e;
      }
    }
    copiedOk.set(rel, ok);
    if (ok) written.push(remap(rel));
    return ok;
  };
  const deleteWritten = (keep: ReadonlySet<string> = new Set()) => {
    for (const rel of written) if (!keep.has(rel)) deleteQuietly(absolutize(rel));
  };

  const copies: NewSegment[] = [];
  const copiedFrom = new Set<string>();
  try {
    for (const [i, seg] of rows.entries()) {
      // The files the editor plays: the original, and a legacy baked edit's file.
      const videos = [seg.originalFilename, seg.editedFilename].filter((f): f is string => !!f);
      let ok = true;
      for (const rel of videos) ok = ok && (await copy(rel));
      if (ok) {
        // A missing cover leaves none (the clip shows its own first frame).
        const thumbnail =
          seg.thumbnail && (await copy(seg.thumbnail)) ? remap(seg.thumbnail) : null;
        const caption = parseCaptionEdit(seg.captionEdit);
        copies.push({
          id: newIds.get(seg.id)!,
          originalFilename: remap(seg.originalFilename),
          durationMs: seg.durationMs,
          thumbnail,
          editedFilename: seg.editedFilename ? remap(seg.editedFilename) : null,
          editedDurationMs: seg.editedDurationMs,
          editState: seg.editState,
          captionEdit: caption ? JSON.stringify({ ...caption, file: remap(caption.file) }) : null,
        });
        copiedFrom.add(seg.id);
      } else {
        console.warn('[drafts] copy clips: a clip’s video is missing; skipped', seg.id);
      }
      onProgress?.(i + 1, rows.length);
    }
  } catch (e) {
    deleteWritten();
    throw e;
  }
  // The files of clips skipped part-way (their cover, a first file) go now.
  const used = new Set(
    copies.flatMap((c) =>
      [c.originalFilename, c.editedFilename, c.thumbnail].filter((f): f is string => !!f),
    ),
  );
  deleteWritten(used);
  const skipped = wanted.size - copies.length;
  if (copies.length === 0 || targetDraftId === null) {
    return { draftId: targetDraftId, segmentIds: [], skipped };
  }

  try {
    const added = await insertSegments(
      targetDraftId,
      anchor,
      copies,
      transcripts
        .filter((t) => copiedFrom.has(t.segmentId))
        .map((t) => ({ ...t, segmentId: newIds.get(t.segmentId)!, file: remap(t.file) })),
    );
    return { draftId: targetDraftId, segmentIds: added, skipped };
  } catch (e) {
    deleteWritten();
    throw e;
  }
}

/** Delete a draft (segments cascade), its on-disk directory (clips + export) and its saved link. */
export async function deleteDraft(draftId: string): Promise<void> {
  // No `assertEditable`: a library a newer Pulse migrated still deletes (AD34). The job goes
  // first, through the outbox, so the host releases its target and the TUS uploads are deleted
  // (the FK cascade would drop the row without either).
  await takeOutForChange(draftId, 'deleted');
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

/**
 * Drafts marked `uploading` — at launch, the uploads a killed app never finished. Never one with
 * an outbox job: that upload is the embed's, and its own launch rule resumes it (AD33).
 */
export async function getUploadingDraftIds(): Promise<string[]> {
  const rows = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.uploadStatus, 'uploading'),
        sql`not exists (select 1 from ${uploadJobs} where ${uploadJobs.draftId} = ${drafts.id})`,
      ),
    );
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
  assertEditable();
  db.transaction((tx) => {
    tx.insert(drafts).values(draft).run();
    if (segmentRows.length > 0) tx.insert(segments).values(segmentRows).run();
  });
}

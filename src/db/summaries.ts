import { asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import { deleteDraftDir } from '@/utils/file-store';
import { db } from './client';
import { prepareClipsCopy, type PreparedClips } from './drafts';
import { assertEditable } from './host-context';
import { clipTranscripts, drafts, segments } from './schema';
import { adoptMergedCaptionEdit } from './transcripts';

/** Each source beat's own addition date, never its project's creation or most recent edit. */
export type SummaryBeat = {
  projectId: string;
  projectName: string | null;
  contextServer: string | null;
  contextRef: string | null;
  segmentId: string;
  addedAt: number;
  order: number;
  durationMs: number;
};

/** Grouped by project, then in its existing beat order. Summary copies never become sources. */
export const summaryBeatsQuery = db
  .select({
    projectId: drafts.id,
    projectName: drafts.name,
    contextServer: drafts.contextServer,
    contextRef: drafts.contextRef,
    segmentId: segments.id,
    addedAt: segments.addedAt,
    order: segments.order,
    durationMs: sql<number>`coalesce(${segments.editedDurationMs}, ${segments.durationMs})`,
  })
  .from(drafts)
  .innerJoin(segments, eq(segments.draftId, drafts.id))
  .where(eq(drafts.isSummary, false))
  .orderBy(desc(drafts.lastModified), asc(drafts.id), asc(segments.order));

/** Only actual collections advance the window. A duplicate keeps the marker, not the cutoff. */
export const latestSummaryQuery = db
  .select({
    id: drafts.id,
    name: drafts.name,
    createdAt: drafts.createdAt,
    summaryCutoffAt: drafts.summaryCutoffAt,
  })
  .from(drafts)
  .where(isNotNull(drafts.summaryCutoffAt))
  .orderBy(desc(drafts.summaryCutoffAt), desc(drafts.createdAt), asc(drafts.id))
  .limit(1);

export type SummarySelection =
  | { mode: 'projects'; projectIds: readonly string[] }
  | { mode: 'range'; startAt: number; endAt: number }
  | { mode: 'since-last' };

type SummaryWindow = { cutoffAt: number; lastSummaryCutoffAt: number | null };

/**
 * Half-open windows keep beats added in the cutoff's millisecond for the NEXT collection:
 * [last cutoff, this cutoff). Date-range end is also exclusive (the day after the last date).
 */
export function selectSummaryBeats(
  beats: readonly SummaryBeat[],
  selection: SummarySelection,
  { cutoffAt, lastSummaryCutoffAt }: SummaryWindow,
): SummaryBeat[] {
  if (!Number.isFinite(cutoffAt)) return [];
  if (selection.mode === 'range') {
    if (
      !Number.isFinite(selection.startAt) ||
      !Number.isFinite(selection.endAt) ||
      selection.startAt >= selection.endAt
    )
      return [];
    return beats.filter(
      (beat) =>
        beat.addedAt >= selection.startAt &&
        beat.addedAt < selection.endAt &&
        beat.addedAt < cutoffAt,
    );
  }
  if (selection.mode === 'since-last') {
    if (lastSummaryCutoffAt == null) return [];
    return beats.filter((beat) => beat.addedAt >= lastSummaryCutoffAt && beat.addedAt < cutoffAt);
  }
  const selected = new Set(selection.projectIds);
  return beats.filter((beat) => selected.has(beat.projectId) && beat.addedAt < cutoffAt);
}

let collecting = false;

/**
 * Freeze the window before any async work, stage independent copies of EVERY selected beat,
 * then insert its draft, beats, captions/transcripts and checkpoint in one synchronous commit.
 * Missing clips fail the collection, so the next window never silently loses uncopied work.
 * A process kill while staging can leave orphan media, but no rows or advanced checkpoint.
 */
export async function createSummary({
  name,
  selection,
}: {
  name: string;
  selection: SummarySelection;
}): Promise<{ draftId: string; beatCount: number }> {
  assertEditable();
  if (collecting) throw new Error('A summary is already being created.');
  collecting = true;
  const cutoffAt = Date.now();
  const draftId = Crypto.randomUUID();
  const prepared: PreparedClips[] = [];
  try {
    const [latest] = await latestSummaryQuery;
    const selected = selectSummaryBeats(await summaryBeatsQuery, selection, {
      cutoffAt,
      lastSummaryCutoffAt: latest?.summaryCutoffAt ?? null,
    });
    if (selected.length === 0) throw new Error('Choose at least one beat for your summary.');
    const byProject = new Map<string, string[]>();
    for (const beat of selected) {
      const ids = byProject.get(beat.projectId) ?? [];
      ids.push(beat.segmentId);
      byProject.set(beat.projectId, ids);
    }
    for (const [projectId, ids] of byProject) {
      // Older caption edits lived on the merged video: move them onto source beats before the
      // same copy routine used by the recorder carries each beat's captions to the new project.
      await adoptMergedCaptionEdit(projectId);
      const staged = await prepareClipsCopy(async () => draftId, projectId, ids);
      prepared.push(staged);
      if (staged.skipped > 0 || staged.copies.length !== ids.length)
        throw new Error('A selected beat is missing its video. Restore it or choose other beats.');
    }
    const copies = prepared.flatMap((p) => p.copies);
    const transcripts = prepared.flatMap((p) => p.transcripts);
    db.transaction((tx) => {
      tx.insert(drafts)
        .values({
          id: draftId,
          name: name.trim() || 'Summary',
          isSummary: true,
          summaryCutoffAt: cutoffAt,
          lastClipNumber: copies.length,
          createdAt: cutoffAt,
          lastModified: cutoffAt,
        })
        .run();
      // Stay under SQLite's lowest common parameter limit while retaining one atomic commit.
      const rows = copies.map((copy, order) => ({
        ...copy,
        draftId,
        order,
        label: String(order + 1),
        addedAt: cutoffAt,
      }));
      for (let i = 0; i < rows.length; i += 50)
        tx.insert(segments)
          .values(rows.slice(i, i + 50))
          .run();
      for (let i = 0; i < transcripts.length; i += 100)
        tx.insert(clipTranscripts)
          .values(transcripts.slice(i, i + 100))
          .run();
    });
    return { draftId, beatCount: copies.length };
  } catch (e) {
    for (const staged of prepared) staged.cleanup();
    deleteDraftDir(draftId);
    throw e;
  } finally {
    collecting = false;
  }
}

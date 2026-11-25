import { asc, eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import { AI_CUT_MAX_DURATION_MS, type AiEditInterval } from '@/core/types/ai-edit';
import { absolutize, deleteDraftDir, deleteQuietly } from '@/utils/file-store';
import { clipRender, renderKey, type ParsedEdit } from '@/utils/segment-window';
import { parseCaptionEdit } from './captions';
import { db, expoDb } from './client';
import { getDraftForExport, prepareClipsCopy, type PreparedClips } from './drafts';
import { assertEditable } from './host-context';
import { clipTranscripts, drafts, segments, type Segment } from './schema';

export type { AiEditInterval };

/**
 * Newer developer builds can contain a separate narration track. This first experiment edits
 * source-clip speech only, so fail explicitly rather than silently dropping the saved mix.
 * Read schema presence because the experiment also runs on the older, pre-voiceover library.
 */
export function assertAiEditAudioSupported(draftId: string): void {
  const hasSourceMute = expoDb
    .getAllSync<{ name: string }>('PRAGMA table_info("drafts")')
    .some((column) => column.name === 'source_audio_muted');
  const sourceMuted =
    hasSourceMute &&
    expoDb.getFirstSync<{ source_audio_muted: number }>(
      'SELECT source_audio_muted FROM drafts WHERE id = ?',
      draftId,
    )?.source_audio_muted;
  const hasNarrationTable = expoDb.getFirstSync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'voiceover_takes'",
  );
  const hasNarration =
    hasNarrationTable &&
    expoDb.getFirstSync<{ id: string }>(
      'SELECT id FROM voiceover_takes WHERE draft_id = ? LIMIT 1',
      draftId,
    );
  if (sourceMuted || hasNarration)
    throw new Error(
      'Use a project without voiceover takes and with source audio unmuted for this AI preview.',
    );
}

function validateIntervals(source: readonly Segment[], intervals: readonly AiEditInterval[]) {
  if (intervals.length === 0) throw new Error('The AI edit has no passages.');
  const byId = new Map(source.map((segment, index) => [segment.id, { segment, index }]));
  let previousIndex = -1;
  let previousEnd = 0;
  let durationMs = 0;
  for (const interval of intervals) {
    const found = byId.get(interval.segmentId);
    if (!found) throw new Error('An AI edit source changed. Try the edit again.');
    const { segment, index } = found;
    const rendered = clipRender(segment);
    if (
      interval.file !== rendered.file ||
      interval.sourceKey !== renderKey(segment) ||
      !Number.isFinite(interval.startMs) ||
      !Number.isFinite(interval.endMs) ||
      interval.startMs < rendered.inMs ||
      interval.endMs > rendered.outMs ||
      interval.endMs <= interval.startMs ||
      rendered.muted ||
      index < previousIndex ||
      (index === previousIndex && interval.startMs < previousEnd)
    )
      throw new Error('An AI edit source or its timing changed. Try the edit again.');
    durationMs += (interval.endMs - interval.startMs) / rendered.speed;
    previousIndex = index;
    previousEnd = interval.endMs;
  }
  if (Math.ceil(durationMs) > AI_CUT_MAX_DURATION_MS)
    throw new Error('The AI edit exceeds its duration limit.');
  return Math.ceil(durationMs);
}

/** Capture before analysis so a later save cannot silently use a changed source timeline. */
export function aiEditSourceSignature(source: readonly Segment[]) {
  return JSON.stringify(
    source.map((segment) => [
      segment.id,
      renderKey(segment),
      segment.durationMs,
      segment.editedDurationMs,
      segment.captionEdit,
    ]),
  );
}

let creating = false;

/**
 * Stage independent media copies, then atomically create an editable excerpt project. Source
 * rows/files are never changed. A failed copy, cancellation or stale source leaves no partial draft.
 */
export async function createAiEdit({
  sourceDraftId,
  name,
  intervals: requested,
  expectedSourceSignature,
  signal,
}: {
  sourceDraftId: string;
  name: string;
  intervals: readonly AiEditInterval[];
  expectedSourceSignature?: string;
  signal?: AbortSignal;
}): Promise<{ draftId: string; clipCount: number; durationMs: number }> {
  assertEditable();
  if (creating) throw new Error('An AI edit is already being saved.');
  creating = true;
  const draftId = Crypto.randomUUID();
  let prepared: PreparedClips | undefined;
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error('AI edit cancelled.');
  };
  try {
    checkCancelled();
    assertAiEditAudioSupported(sourceDraftId);
    const original = await getDraftForExport(sourceDraftId);
    if (!original) throw new Error('The source project is no longer available.');
    const signature = aiEditSourceSignature(original.segments);
    if (expectedSourceSignature !== undefined && expectedSourceSignature !== signature)
      throw new Error('The source project changed during analysis. Try the AI edit again.');
    const intervals = requested.map((interval) => ({ ...interval }));
    const durationMs = validateIntervals(original.segments, intervals);
    const selectedIds = new Set(intervals.map((interval) => interval.segmentId));
    const sources = original.segments.filter((segment) => selectedIds.has(segment.id));
    prepared = await prepareClipsCopy(
      async () => draftId,
      sourceDraftId,
      [...selectedIds],
      () => {
        checkCancelled();
      },
    );
    checkCancelled();
    if (prepared.skipped || prepared.copies.length !== sources.length)
      throw new Error('An AI edit source video is missing. Restore it and try again.');
    const copies = new Map(sources.map((segment, i) => [segment.id, prepared!.copies[i]]));
    const now = Date.now();
    const rows = intervals.map((interval, order) => {
      const source = sources.find((segment) => segment.id === interval.segmentId)!;
      const copy = copies.get(source.id)!;
      const rendered = clipRender(source);
      const effectiveCopyFile = copy.editedFilename ?? copy.originalFilename;
      const caption = parseCaptionEdit(copy.captionEdit ?? null);
      const edit: ParsedEdit & { v: 1 } = {
        v: 1,
        startMs: interval.startMs,
        endMs: interval.endMs,
        baseWindow: { startMs: interval.startMs, endMs: interval.endMs },
        speed: rendered.speed,
        rotation: rendered.rotation,
        flipped: rendered.flipped,
        crop: rendered.crop,
        muted: false,
      };
      return {
        id: Crypto.randomUUID(),
        draftId,
        order,
        label: String(order + 1),
        addedAt: now,
        originalFilename: effectiveCopyFile,
        durationMs: source.editedFilename
          ? (source.editedDurationMs ?? source.durationMs)
          : source.durationMs,
        editedFilename: null,
        editedDurationMs: Math.round((interval.endMs - interval.startMs) / rendered.speed),
        editState: JSON.stringify(edit),
        captionEdit: caption?.file === effectiveCopyFile ? copy.captionEdit : null,
        thumbnail: null,
      };
    });
    const transcripts = rows.flatMap((row, index) => {
      const staged = copies.get(intervals[index].segmentId)!;
      return prepared!.transcripts
        .filter(
          (transcript) =>
            transcript.segmentId === staged.id && transcript.file === row.originalFilename,
        )
        .map((transcript) => ({ ...transcript, segmentId: row.id }));
    });
    db.transaction((tx) => {
      checkCancelled();
      assertAiEditAudioSupported(sourceDraftId);
      const stillExists = tx.select().from(drafts).where(eq(drafts.id, sourceDraftId)).get();
      const current = tx
        .select()
        .from(segments)
        .where(eq(segments.draftId, sourceDraftId))
        .orderBy(asc(segments.order))
        .all();
      if (!stillExists || aiEditSourceSignature(current) !== signature)
        throw new Error('The source project changed while saving. Try the AI edit again.');
      validateIntervals(current, intervals);
      tx.insert(drafts)
        .values({
          id: draftId,
          name: name.trim() || 'AI cut',
          captionY: original.draft.captionY,
          createdVia: original.draft.createdVia,
          lastClipNumber: rows.length,
          createdAt: now,
          lastModified: now,
        })
        .run();
      for (let i = 0; i < rows.length; i += 50)
        tx.insert(segments)
          .values(rows.slice(i, i + 50))
          .run();
      for (let i = 0; i < transcripts.length; i += 100)
        tx.insert(clipTranscripts)
          .values(transcripts.slice(i, i + 100))
          .run();
    });
    // Legacy clips stage both original and baked files. The new source is the effective file;
    // discard only this operation's unused copies and old covers, never the source project's media.
    const used = new Set(rows.map((row) => row.originalFilename));
    for (const copy of prepared.copies) {
      for (const file of [copy.originalFilename, copy.editedFilename, copy.thumbnail])
        if (file && !used.has(file)) deleteQuietly(absolutize(file));
    }
    return { draftId, clipCount: rows.length, durationMs };
  } catch (error) {
    prepared?.cleanup();
    deleteDraftDir(draftId);
    throw error;
  } finally {
    creating = false;
  }
}

import { eq, sql } from 'drizzle-orm';

import type { TranscriptLine } from '@/features/transcription/whisper';
import { db } from './client';
import { draftTranscripts } from './schema';

/** Live-queryable: the single merged transcript row for a draft (or none). */
export function draftTranscriptQuery(draftId: string) {
  return db
    .select({
      draftId: draftTranscripts.draftId,
      signature: draftTranscripts.signature,
      model: draftTranscripts.model,
      status: draftTranscripts.status,
      lines: draftTranscripts.lines,
      editedLines: draftTranscripts.editedLines,
      durationMs: draftTranscripts.durationMs,
    })
    .from(draftTranscripts)
    .where(eq(draftTranscripts.draftId, draftId));
}

/** Load a draft's merged transcript row (auto `lines`, `editedLines`, status, signature) for the editor/upload. */
export async function getDraftTranscriptRow(draftId: string) {
  const [row] = await db
    .select({
      signature: draftTranscripts.signature,
      lines: draftTranscripts.lines,
      editedLines: draftTranscripts.editedLines,
      status: draftTranscripts.status,
      durationMs: draftTranscripts.durationMs,
    })
    .from(draftTranscripts)
    .where(eq(draftTranscripts.draftId, draftId));
  return row ?? null;
}

/**
 * Store the draft's composed captions (compose.ts) for its current clips (`signature`) and model.
 * A new signature means the clips or their edits changed, so a hand-edit made against the old
 * timeline is stale and cleared; the same signature keeps it (only the auto lines are replaced,
 * e.g. after a model switch).
 */
export async function saveComposedTranscript(
  draftId: string,
  signature: string,
  model: string,
  lines: TranscriptLine[],
  durationMs: number,
): Promise<void> {
  const json = JSON.stringify(lines);
  await db
    .insert(draftTranscripts)
    .values({ draftId, signature, model, status: 'done', lines: json, durationMs })
    .onConflictDoUpdate({
      target: draftTranscripts.draftId,
      set: {
        signature,
        model,
        status: 'done',
        lines: json,
        durationMs,
        editedLines: sql`CASE WHEN ${draftTranscripts.signature} = ${signature} THEN ${draftTranscripts.editedLines} ELSE NULL END`,
      },
    });
}

/**
 * Persist the user's hand-edited captions for a draft's merged transcript. Stored alongside the
 * auto `lines` (which stay intact for "Reset to auto"); while `signature` still matches the current
 * segment set, `editedLines` is the effective transcript. Forces status to 'done' so the captions
 * render regardless of the prior auto state.
 *
 * Upserts: the merged video can be captioned before a row exists (edited from an export with no
 * model yet), and the edit must still stick. `signature` ties the row to the timeline the editor
 * showed — set on insert AND rewritten on conflict, so a hand-edit is never treated as stale
 * against its own video. The stored auto `lines` are left untouched so "Reset to auto" still works.
 */
export async function saveEditedTranscript(
  draftId: string,
  signature: string,
  lines: TranscriptLine[],
): Promise<void> {
  const editedLines = JSON.stringify(lines);
  await db
    .insert(draftTranscripts)
    .values({ draftId, signature, status: 'done', editedLines })
    .onConflictDoUpdate({
      target: draftTranscripts.draftId,
      // Rewrite `signature` too: the edit's cue timings match the merged video the editor showed,
      // which corresponds to THIS signature. If the stored row was still on an older signature,
      // binding the edit to the current one is what keeps it from being treated as stale (and
      // wiped) on the next export.
      set: { signature, status: 'done', editedLines },
    });
}

/**
 * Clear a draft's manual edit ("Reset to auto"). If the row has no auto `lines` to fall back on (it
 * was edited before transcription produced any), re-arm it to 'processing' so the next export
 * regenerates captions rather than leaving it stranded at an empty 'done'; otherwise keep the
 * stored auto lines + status so they reappear instantly.
 */
export async function clearEditedTranscript(draftId: string): Promise<void> {
  await db
    .update(draftTranscripts)
    .set({
      editedLines: null,
      status: sql`CASE WHEN ${draftTranscripts.lines} IS NULL THEN 'processing' ELSE ${draftTranscripts.status} END`,
    })
    .where(eq(draftTranscripts.draftId, draftId));
}

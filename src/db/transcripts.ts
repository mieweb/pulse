import { eq, sql } from 'drizzle-orm';

import type { TranscriptLine } from '@/features/transcription/whisper';
import { mergedSignature } from '@/features/export/merge-signature';
import { clipRender, effMs, segmentSignature } from '@/utils/segment-window';
import type { CaptionEdit } from './captions';
import { db } from './client';
import { segmentsForDraft } from './drafts';
import { drafts, draftTranscripts, segments } from './schema';

/**
 * Earlier versions kept a draft's captions as one transcript of its merged video
 * (`draft_transcripts`), hand-edited in the subtitle editor. Captions are composed from the clips
 * now, and edited per clip (`segments.caption_edit`). This moves a hand-edit still valid for the
 * draft's clips (same signature) onto those clips, words timed in each clip's file, and drops
 * the row: an edit against other clips was already stale, and the auto lines are composed now.
 */
export async function adoptMergedCaptionEdit(draftId: string): Promise<void> {
  const [row] = await db
    .select({ signature: draftTranscripts.signature, editedLines: draftTranscripts.editedLines })
    .from(draftTranscripts)
    .where(eq(draftTranscripts.draftId, draftId));
  if (!row) return;
  const clips = (await segmentsForDraft(draftId)).filter((s) => effMs(s) > 0);
  const edits = new Map<string, string>();
  // Written as the clips' signature by versions up to 2.2.4, and with the merge version in front
  // (mergedSignature) by builds of the pulse-editor migration: either means the same clips.
  const signature = segmentSignature(clips);
  if (
    row.editedLines &&
    (row.signature === signature || row.signature === mergedSignature(clips))
  ) {
    // Each edited line was a caption the person shaped (split, merged): its first word starts a
    // sentence, so the captions keep those boxes rather than being regrouped by length.
    const words = parseLines(row.editedLines).flatMap((l) =>
      (l.words?.length ? l.words : [{ text: l.text, t0: l.t0, t1: l.t1 }]).map((w, i) => ({
        ...w,
        start: i === 0,
      })),
    );
    let offsetCs = 0;
    for (const s of clips) {
      const r = clipRender(s);
      const endCs = offsetCs + effMs(s) / 10;
      // A muted clip had no captions to edit: it keeps the model's words for when it's unmuted.
      if (r.muted) {
        offsetCs = endCs;
        continue;
      }
      const toFile = (cs: number) => Math.round(r.inMs / 10 + (cs - offsetCs) * r.speed);
      const own = words
        .filter((w) => w.t0 >= offsetCs && w.t0 < endCs)
        .map((w) => ({
          text: w.text,
          t0: toFile(w.t0),
          t1: toFile(Math.min(w.t1, endCs)),
          ...(w.start ? { start: true } : {}),
        }));
      const edit: CaptionEdit = { file: r.file, words: own };
      edits.set(s.id, JSON.stringify(edit));
      offsetCs = endCs;
    }
  }
  // The clips' edits and the row's removal together (sync: drizzle's expo-sqlite transactions
  // don't wait for promises), so a crash can't adopt the edit again over newer ones.
  db.transaction((tx) => {
    for (const [id, value] of edits) {
      tx.update(segments).set({ captionEdit: value }).where(eq(segments.id, id)).run();
    }
    if (edits.size) {
      tx.update(drafts)
        .set({ lastModified: sql`(unixepoch('subsec') * 1000)` })
        .where(eq(drafts.id, draftId))
        .run();
    }
    tx.delete(draftTranscripts).where(eq(draftTranscripts.draftId, draftId)).run();
  });
}

function parseLines(json: string): TranscriptLine[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as TranscriptLine[]) : [];
  } catch {
    return [];
  }
}

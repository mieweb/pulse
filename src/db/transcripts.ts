import { eq } from 'drizzle-orm';

import type { TranscriptLine } from '@/features/transcription/whisper';
import { clipRender, effMs, segmentSignature } from '@/utils/segment-window';
import { setCaptionEdits, type CaptionEdit } from './captions';
import { db } from './client';
import { segmentsForDraft } from './drafts';
import { draftTranscripts } from './schema';

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
  if (row.editedLines && row.signature === segmentSignature(clips)) {
    const words = parseLines(row.editedLines).flatMap(
      (l) => l.words ?? [{ text: l.text, t0: l.t0, t1: l.t1 }],
    );
    const edits = new Map<string, string | null>();
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
        .map((w) => ({ text: w.text, t0: toFile(w.t0), t1: toFile(Math.min(w.t1, endCs)) }));
      const edit: CaptionEdit = { file: r.file, words: own };
      edits.set(s.id, JSON.stringify(edit));
      offsetCs = endCs;
    }
    await setCaptionEdits(edits);
  }
  await db.delete(draftTranscripts).where(eq(draftTranscripts.draftId, draftId));
}

function parseLines(json: string): TranscriptLine[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as TranscriptLine[]) : [];
  } catch {
    return [];
  }
}

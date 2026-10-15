import { and, eq, inArray } from 'drizzle-orm';

import type { TranscriptWord } from '@/features/transcription/whisper';
import { db } from './client';
import { clipTranscripts, segments } from './schema';

/** A clip's transcript for one model: the file it was made from and its words (file time, cs). */
export type ClipWords = { segmentId: string; file: string; words: TranscriptWord[] };

function parseWords(json: string | null): TranscriptWord[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as TranscriptWord[];
  } catch {
    return [];
  }
}

/** Live-queryable: every clip transcript of a draft's clips, for one model. */
export function draftClipTranscriptsQuery(draftId: string, model: string) {
  return db
    .select({
      segmentId: clipTranscripts.segmentId,
      file: clipTranscripts.file,
      status: clipTranscripts.status,
      words: clipTranscripts.words,
    })
    .from(clipTranscripts)
    .innerJoin(segments, eq(segments.id, clipTranscripts.segmentId))
    .where(and(eq(segments.draftId, draftId), eq(clipTranscripts.model, model)));
}

/** Rows from `draftClipTranscriptsQuery` (or `getClipTranscripts`) as finished clip words. */
export function clipWordsOf(
  rows: { segmentId: string; file: string; status: string; words: string | null }[],
): Map<string, ClipWords> {
  const out = new Map<string, ClipWords>();
  for (const r of rows) {
    if (r.status !== 'done') continue;
    out.set(r.segmentId, { segmentId: r.segmentId, file: r.file, words: parseWords(r.words) });
  }
  return out;
}

/** The finished clip transcripts among `segmentIds`, for one model. */
export async function getClipTranscripts(
  segmentIds: string[],
  model: string,
): Promise<Map<string, ClipWords>> {
  if (segmentIds.length === 0) return new Map();
  const rows = await db
    .select({
      segmentId: clipTranscripts.segmentId,
      file: clipTranscripts.file,
      status: clipTranscripts.status,
      words: clipTranscripts.words,
    })
    .from(clipTranscripts)
    .where(and(inArray(clipTranscripts.segmentId, segmentIds), eq(clipTranscripts.model, model)));
  return clipWordsOf(rows);
}

/**
 * Store a clip's transcript for a model (replacing any earlier one for that model). A clip deleted
 * while it was transcribed has no row to point at: the insert fails its foreign key and nothing
 * is stored, which is what's wanted.
 */
export async function saveClipTranscript(
  segmentId: string,
  model: string,
  file: string,
  words: TranscriptWord[],
): Promise<void> {
  const json = JSON.stringify(words);
  await db
    .insert(clipTranscripts)
    .values({ segmentId, model, file, status: 'done', words: json })
    .onConflictDoUpdate({
      target: [clipTranscripts.segmentId, clipTranscripts.model],
      set: { file, status: 'done', words: json },
    });
}

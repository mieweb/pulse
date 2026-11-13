import { eq, inArray, sql } from 'drizzle-orm';

import type { TranscriptWord } from '@/features/transcription/whisper';
import { db } from './client';
import { drafts, segments } from './schema';

const now = sql`(unixepoch('subsec') * 1000)`;

/** A clip's edited captions: words timed in `file` (centiseconds), as `segments.caption_edit`. */
export type CaptionEdit = { file: string; words: TranscriptWord[] };

/** `segments.caption_edit` parsed; null when unset or unreadable. */
export function parseCaptionEdit(json: string | null | undefined): CaptionEdit | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as CaptionEdit;
    return typeof v?.file === 'string' && Array.isArray(v.words) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Store clips' edited captions (a value per clip id: the JSON, or null for the model's words
 * again), in one transaction, and touch their draft.
 */
export async function setCaptionEdits(values: ReadonlyMap<string, string | null>): Promise<void> {
  if (values.size === 0) return;
  const ids = [...values.keys()];
  const [first] = await db
    .select({ draftId: segments.draftId })
    .from(segments)
    .where(inArray(segments.id, ids))
    .limit(1);
  db.transaction((tx) => {
    for (const [id, value] of values) {
      tx.update(segments).set({ captionEdit: value }).where(eq(segments.id, id)).run();
    }
    if (first)
      tx.update(drafts).set({ lastModified: now }).where(eq(drafts.id, first.draftId)).run();
  });
}

/** Live-queryable: where the draft's captions sit (`drafts.caption_y`). */
export function captionYQuery(draftId: string) {
  return db.select({ captionY: drafts.captionY }).from(drafts).where(eq(drafts.id, draftId));
}

/** Where the draft's captions sit (null: the default place). */
export async function getCaptionY(draftId: string): Promise<number | null> {
  const [row] = await captionYQuery(draftId);
  return row?.captionY ?? null;
}

/** Move the draft's captions (`y`: the caption's centre, 0 top … 1 bottom of the picture). */
export async function setCaptionY(draftId: string, y: number | null): Promise<void> {
  await db.update(drafts).set({ captionY: y, lastModified: now }).where(eq(drafts.id, draftId));
}

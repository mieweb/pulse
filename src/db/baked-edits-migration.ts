import { and, eq, isNotNull } from 'drizzle-orm';

import { deleteSegmentFile } from '@/utils/file-store';
import { editTimelineMs } from '@/utils/segment-window';
import { db } from './client';
import type { DataMigration } from './data-migrations';
import { drafts, segments } from './schema';

type BakedRow = {
  id: string;
  editedFilename: string;
  editState: string;
  uploadStatus: string | null;
};

/**
 * Which clips can drop their baked file: edited before edits became settings-only, so they carry
 * both the baked `editedFilename` and the `editState` that produced it. The settings alone now
 * render the same clip (preview live, export in the merge). A draft mid-upload is deferred — its
 * export was merged from the baked files, and a clip mutation would break the resumed upload.
 */
export function planBakedEditDrops(rows: readonly BakedRow[]): {
  drops: { id: string; editedFilename: string; editedDurationMs: number }[];
  deferred: number;
} {
  const drops: { id: string; editedFilename: string; editedDurationMs: number }[] = [];
  let deferred = 0;
  for (const row of rows) {
    if (row.uploadStatus === 'uploading') {
      deferred++;
      continue;
    }
    // An unusable state can't reproduce the edit — keep the baked file (plays as legacy).
    const editedDurationMs = editTimelineMs(row.editState);
    if (editedDurationMs == null) continue;
    drops.push({ id: row.id, editedFilename: row.editedFilename, editedDurationMs });
  }
  return { drops, deferred };
}

/**
 * One-shot: clips edited while edits were still baked into files keep only their settings.
 * Idempotent — the row is cleared before its file is deleted, so a re-run after a crash finds
 * nothing left to do for it. Deferred (uploading) drafts make the task throw after the rest are
 * done, so it retries on the next launch.
 */
export const dropBakedEdits: DataMigration = {
  id: 'drop-baked-edits',
  async run() {
    const rows = await db
      .select({
        id: segments.id,
        editedFilename: segments.editedFilename,
        editState: segments.editState,
        uploadStatus: drafts.uploadStatus,
      })
      .from(segments)
      .innerJoin(drafts, eq(drafts.id, segments.draftId))
      .where(and(isNotNull(segments.editedFilename), isNotNull(segments.editState)));
    const { drops, deferred } = planBakedEditDrops(rows as BakedRow[]);
    for (const drop of drops) {
      await db
        .update(segments)
        .set({ editedFilename: null, editedDurationMs: drop.editedDurationMs })
        .where(eq(segments.id, drop.id));
      deleteSegmentFile(drop.editedFilename);
    }
    if (deferred > 0) {
      throw new Error(`${deferred} edited clip(s) are in a draft that is uploading`);
    }
  },
};

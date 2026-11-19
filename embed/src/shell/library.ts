import { count, eq } from 'drizzle-orm';
import { File } from 'expo-file-system';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db, expoDb } from '@/db/client';
import { deleteDraft } from '@/db/drafts';
import { buildProject } from '@/db/project';
import { drafts, segments } from '@/db/schema';
import { documentDir } from '@/utils/storage-root';

import type { DraftSeen } from './draft-sync';

/** What the shell reads and writes in the library; only once the library gate has passed. */

/** The draft as the library has it now, or null when there is no such draft. Synchronous. */
export function readDraft(draftId: string): DraftSeen | null {
  const row = db
    .select({
      lastModified: drafts.lastModified,
      mergedSignature: drafts.mergedSignature,
      clipCount: count(segments.id),
    })
    .from(drafts)
    .leftJoin(segments, eq(segments.draftId, drafts.id))
    .where(eq(drafts.id, draftId))
    .groupBy(drafts.id)
    .get();
  return row ? { draftId, ...row } : null;
}

/** Calls `onChange` after a write to the drafts or their clips. */
export function onDraftsChanged(onChange: () => void): () => void {
  const subscription = addDatabaseChangeListener((event) => {
    if (event.tableName === 'drafts' || event.tableName === 'segments') onChange();
  });
  return () => subscription.remove();
}

/** The draft's lossless project document (v2), for "Use this video" in 'file' mode. */
export function projectDocument(draftId: string): unknown {
  return buildProject(expoDb, {
    draftIds: [draftId],
    now: Date.now(),
    byteLength: (rel) => {
      const file = new File(documentDir(), ...rel.split('/'));
      return file.exists ? file.size : null;
    },
  });
}

/** Delete a draft the flow ended without (discarded, or left with no clip). */
export function removeDraft(draftId: string): Promise<void> {
  return deleteDraft(draftId);
}

import type { PulseContext } from '@mieweb/pulse-embed';
import { count, eq } from 'drizzle-orm';
import { File } from 'expo-file-system';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { db, expoDb } from '@/db/client';
import { deleteDraft, draftHostContext } from '@/db/drafts';
import { buildProject } from '@/db/project';
import { drafts, segments } from '@/db/schema';
import { documentDir } from '@/utils/storage-root';
import { hasRetainedUndo } from '@/features/editor/persistent-editor-history';

import type { DraftSeen } from './draft-sync';

/** What the shell reads and writes in the library; only once the library gate has passed. */

/** A draft as the library has it, with the host place it is for. */
export type DraftRead = DraftSeen & {
  /** The host's `PulseContext` the draft was recorded for or moved to; null without one. */
  context: PulseContext | null;
};

/** The draft as the library has it now, or null when there is no such draft. Synchronous. */
export function readDraft(draftId: string): DraftRead | null {
  const row = db
    .select({
      lastModified: drafts.lastModified,
      clipCount: count(segments.id),
      contextKey: drafts.contextKey,
      contextLabel: drafts.contextLabel,
      contextJson: drafts.contextJson,
      uploadTypeJson: drafts.uploadTypeJson,
    })
    .from(drafts)
    .leftJoin(segments, eq(segments.draftId, drafts.id))
    .where(eq(drafts.id, draftId))
    .groupBy(drafts.id)
    .get();
  if (!row) return null;
  const { contextKey, contextLabel, contextJson, uploadTypeJson, ...seen } = row;
  // Stored as the host handed it over and checked at birth (host-context.ts): its PulseContext.
  const context = draftHostContext({ contextKey, contextLabel, contextJson, uploadTypeJson });
  return {
    draftId,
    ...seen,
    retainedUndo: hasRetainedUndo(draftId),
    context: context as PulseContext | null,
  };
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

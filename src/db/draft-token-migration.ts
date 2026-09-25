import { db } from './client';
import type { DataMigration } from './data-migrations';
import { drafts } from './schema';
import { deleteDraftToken } from './secure-token';

/**
 * One-shot: drafts used to keep a copy of their upload link's token in secure-store, for resuming
 * and retrying. Neither exists any more — an upload carries its token in memory — so delete every
 * copy (on iOS the keychain outlives an uninstall). Idempotent: deleting a missing one is a no-op.
 */
export const dropDraftTokens: DataMigration = {
  id: 'drop-draft-tokens',
  async run() {
    const rows = await db.select({ id: drafts.id }).from(drafts);
    for (const { id } of rows) await deleteDraftToken(id);
  },
};

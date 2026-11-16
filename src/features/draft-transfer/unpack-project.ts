import { File, FileMode } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import { checkProject, commitCopy, planCopy, PROJECT_NAME } from '@/db/project';
import { ensureFreeSpace } from '@/utils/disk-space';
import { absolutize, deleteDraftDir } from '@/utils/file-store';
import { looksLikeLibraryBackup } from './library-backup';
import { extractEntry, readEntryText, readZipIndex } from './zip-stream';

/** What a picked `.pulse` file holds: drafts (v2 or a v1 bundle) or a whole-library backup. */
export type PulseFileKind = 'project' | 'library-backup' | 'draft-bundle';

export async function pulseFileKind(fileUri: string): Promise<PulseFileKind> {
  try {
    if (await looksLikeLibraryBackup(fileUri)) return 'library-backup';
    const handle = new File(fileUri).open(FileMode.ReadOnly);
    try {
      if (readZipIndex(handle).has(PROJECT_NAME)) return 'project';
    } finally {
      handle.close();
    }
  } catch {
    // Not one we can index: the v1 importer reports what's wrong with it.
  }
  return 'draft-bundle';
}

const DAMAGED = 'This .pulse file is damaged.';

/**
 * Import a v2 `.pulse` file's drafts as copies under fresh ids (see `planCopy`): its files are
 * streamed into place first, then the rows committed in one transaction; a failure removes the
 * copies' files. Returns the new draft ids.
 */
export function importProjectFile(
  conn: SQLiteDatabase,
  fileUri: string,
  freshId: () => string,
): string[] {
  const handle = new File(fileUri).open(FileMode.ReadOnly);
  try {
    const entries = readZipIndex(handle);
    const project = entries.get(PROJECT_NAME);
    if (!project) throw new Error(DAMAGED);
    const doc = checkProject(JSON.parse(readEntryText(handle, project)));
    for (const m of doc.media) {
      if (entries.get(`media/${m.path}`)?.size !== m.byteLength) throw new Error(DAMAGED);
    }
    const plan = planCopy(doc, freshId);
    if (plan.draftIds.length === 0) throw new Error('This .pulse file has no drafts.');
    ensureFreeSpace(doc.media.reduce((sum, m) => sum + m.byteLength, 0));
    const md5Of = new Map(doc.media.map((m) => [m.path, m.md5]));
    try {
      for (const [next, old] of plan.files) {
        const dest = new File(absolutize(next));
        extractEntry(handle, entries.get(`media/${old}`)!, dest, md5Of.get(old));
      }
      commitCopy(conn, plan);
    } catch (e) {
      for (const id of plan.draftIds) deleteDraftDir(id);
      throw e;
    }
    return plan.draftIds;
  } finally {
    handle.close();
  }
}

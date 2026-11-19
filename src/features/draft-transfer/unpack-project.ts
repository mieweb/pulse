import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { listContents, unzip } from 'react-native-zip-archive';

import { checkProject, commitCopy, planCopy, PROJECT_NAME } from '@/db/project';
import { ensureFreeSpace, nativeMd5 } from '@/utils/disk-space';
import { absolutize, deleteDraftDir } from '@/utils/file-store';
import { looksLikeLibraryBackup, RESTORE_PREFIX } from './library-backup';
import { plainPath, yieldToUi } from './native-zip';

/** What a picked `.pulse` file holds: drafts (v2 or a v1 bundle) or a whole-library backup. */
export type PulseFileKind = 'project' | 'library-backup' | 'draft-bundle';

export async function pulseFileKind(fileUri: string): Promise<PulseFileKind> {
  try {
    if (await looksLikeLibraryBackup(fileUri)) return 'library-backup';
    const names = (await listContents(plainPath(fileUri))).map((e) => e.path);
    if (names.includes(PROJECT_NAME)) return 'project';
  } catch {
    // Not one we can list: the v1 importer reports what's wrong with it.
  }
  return 'draft-bundle';
}

const DAMAGED = 'This .pulse file is damaged.';

/**
 * Import a v2 `.pulse` file's drafts as copies under fresh ids (see `planCopy`). It's unzipped
 * natively beside `drafts/` (any entry method: Android's zip deflates even at level 0), every
 * file is checked against its size and native MD5, then each moves into place (a rename) and the
 * rows are committed in one transaction; a failure removes the copies' files. The unzipped folder
 * is removed either way (and at the next launch, if a crash cut this short). Returns the new
 * draft ids.
 */
export async function importProjectFile(
  conn: SQLiteDatabase,
  fileUri: string,
  freshId: () => string,
  now = Date.now(),
): Promise<string[]> {
  const archive = plainPath(fileUri);
  const listed = await listContents(archive);
  if (!listed.some((e) => e.path === PROJECT_NAME)) throw new Error(DAMAGED);
  // The unzipped copy sits beside the library until each file is moved into place.
  ensureFreeSpace(listed.reduce((sum, e) => sum + (e.isDirectory ? 0 : e.size), 0));

  const stage = new Directory(Paths.document, `${RESTORE_PREFIX}import-${now}`);
  stage.create({ intermediates: true });
  try {
    await unzip(archive, plainPath(stage.uri));
    const doc = checkProject(JSON.parse(new File(stage, PROJECT_NAME).textSync()));
    // Each file's entry: its own name in the flat archive, or `media/<path>` in the first v2 files.
    const staged = new Map(
      doc.media.map((m) => [
        m.path,
        new File(stage, ...(m.entry !== undefined ? [m.entry] : ['media', ...m.path.split('/')])),
      ]),
    );
    for (const m of doc.media) {
      const file = staged.get(m.path)!;
      if (!file.exists || file.size !== m.byteLength) throw new Error(DAMAGED);
      if (m.md5 !== undefined && nativeMd5(file) !== m.md5) throw new Error(DAMAGED);
      await yieldToUi();
    }
    const plan = planCopy(doc, freshId);
    if (plan.draftIds.length === 0) throw new Error('This .pulse file has no drafts.');
    try {
      // A file two copies share (a duplicated draft keeps its source's original) moves to the
      // first and is copied from there to the rest.
      const placed = new Map<string, File>();
      for (const [next, old] of plan.files) {
        const dest = new File(absolutize(next));
        dest.parentDirectory.create({ intermediates: true, idempotent: true });
        const first = placed.get(old);
        if (first) first.copySync(dest);
        else staged.get(old)!.moveSync(dest);
        placed.set(old, first ?? dest);
      }
      commitCopy(conn, plan);
    } catch (e) {
      for (const id of plan.draftIds) deleteDraftDir(id);
      throw e;
    }
    return plan.draftIds;
  } finally {
    if (stage.exists) stage.delete();
  }
}

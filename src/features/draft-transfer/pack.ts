import { Directory, File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import { buildProject, PROJECT_NAME } from '@/db/project';
import { absolutize } from '@/utils/file-store';
import { zipFlat } from './native-zip';
import { MAX_ZIP_BYTES, TOO_BIG_TO_ZIP } from './zip-stream';
import { exportWorkspace } from './workspace';

/** Reduce a draft name to a filesystem-safe slug for the single-draft filename. */
function safeName(name: string | null): string {
  const slug = (name ?? '')
    .replace(/[^a-z0-9-_ ]+/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return slug || 'untitled';
}

/** A stored file's size, or null when it's gone. */
const byteLength = (rel: string) => {
  const file = new File(absolutize(rel));
  return file.exists ? (file.size ?? 0) : null;
};

/**
 * Pack the given drafts into a `.pulse` file in the cache and return its `file://` uri for
 * sharing: `project.json` (a `pulse-project` v2 document: every row and column of the drafts) and
 * their files, zipped natively and flat, each under the `entry` the document lists for it.
 *
 * `now` is supplied by the caller (the bundle timestamp + filename) so this stays pure of clocks.
 */
export async function exportDrafts(
  conn: SQLiteDatabase,
  draftIds: string[],
  now: number,
): Promise<string> {
  if (draftIds.length === 0) throw new Error('No drafts selected.');
  const doc = buildProject(conn, { draftIds, now, byteLength });
  const drafts = doc.tables.drafts;
  if (drafts.length === 0) throw new Error('The selected drafts are gone.');
  // Importing reads the file without ZIP64: refuse one it couldn't read back (headers add a few KB).
  if (doc.media.reduce((sum, m) => sum + m.byteLength, 1 << 20) > MAX_ZIP_BYTES) {
    throw new Error(TOO_BIG_TO_ZIP);
  }

  const dir = exportWorkspace('drafts', now); // its own folder: a backup may be running too
  const stage = new Directory(dir, 'stage');
  stage.create({ intermediates: true, idempotent: true });
  const fileName =
    drafts.length === 1
      ? `pulse-draft-${safeName(drafts[0].name as string | null)}-${now}.pulse`
      : `pulse-backup-${now}.pulse`;
  const out = new File(dir, fileName);
  let done = false;
  try {
    await zipFlat(
      doc.media.map((m) => ({ path: m.path, file: new File(absolutize(m.path)) })),
      stage,
      out,
      {
        names: [PROJECT_NAME],
        write: (files) => {
          doc.media = files.map((f) => ({
            path: f.path,
            byteLength: f.size,
            md5: f.md5,
            entry: f.entry,
          }));
          new File(stage, PROJECT_NAME).write(JSON.stringify(doc));
        },
      },
    );
    done = true;
    return out.uri;
  } finally {
    if (stage.exists) stage.delete();
    if (!done && dir.exists) dir.delete(); // a half-written file is no use to anyone
  }
}

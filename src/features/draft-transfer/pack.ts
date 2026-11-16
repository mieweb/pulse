import { File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import { buildProject, PROJECT_NAME } from '@/db/project';
import { ensureFreeSpace, nativeMd5 } from '@/utils/disk-space';
import { absolutize } from '@/utils/file-store';
import { exportWorkspace } from './workspace';
import { writeZip } from './zip-stream';

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
 * Pack the given drafts into a `.pulse` file in the cache — `project.json` (a `pulse-project`
 * v2 document: every row and column of the drafts) plus their files under `media/`, streamed —
 * and return its `file://` uri for sharing.
 *
 * `now` is supplied by the caller (the bundle timestamp + filename) so this stays pure of clocks.
 */
export function exportDrafts(conn: SQLiteDatabase, draftIds: string[], now: number): string {
  if (draftIds.length === 0) throw new Error('No drafts selected.');
  const doc = buildProject(conn, { draftIds, now, byteLength });
  const drafts = doc.tables.drafts;
  if (drafts.length === 0) throw new Error('The selected drafts are gone.');
  ensureFreeSpace(doc.media.reduce((sum, m) => sum + m.byteLength, 0));
  doc.media = doc.media.map((m) => ({ ...m, md5: nativeMd5(new File(absolutize(m.path))) }));

  const dir = exportWorkspace('drafts', now); // its own folder: a backup may be running too
  const fileName =
    drafts.length === 1
      ? `pulse-draft-${safeName(drafts[0].name as string | null)}-${now}.pulse`
      : `pulse-backup-${now}.pulse`;
  const out = new File(dir, fileName);
  writeZip(out, [
    { name: PROJECT_NAME, bytes: new TextEncoder().encode(JSON.stringify(doc)) },
    ...doc.media.map((m) => ({ name: `media/${m.path}`, file: new File(absolutize(m.path)) })),
  ]);
  return out.uri;
}

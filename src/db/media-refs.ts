import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import { editedThumbRelPath, exportRelPath, thumbRelPath } from '@/utils/media-paths';
import { clipTranscripts, drafts, segments } from './schema';

/** The `file` a `caption_edit` value is timed against, if it has one. */
function captionFile(json: string | null): string | null {
  try {
    const file = json ? (JSON.parse(json) as { file?: unknown }).file : null;
    return typeof file === 'string' ? file : null;
  } catch {
    return null;
  }
}

/**
 * Every file (relative to the documents folder) the library needs: what rows store and what is
 * derived from them. Stored: clip originals, legacy baked edits, covers. Derived: the pristine
 * thumb (kept for a reset, `thumbRelPath`), a baked edit's thumb (`editedThumbRelPath`), the
 * persisted export (`exportRelPath`, reused while its signature matches). Kept to be safe: the
 * file a clip transcript or a caption edit was timed against. Limited to `draftIds` when given.
 */
export function referencedMediaPaths(conn: SQLiteDatabase, draftIds?: string[]): Set<string> {
  const d = drizzle(conn);
  const inDrafts = draftIds ? inArray(segments.draftId, draftIds) : undefined;
  const paths = new Set<string>();
  const add = (p: string | null) => {
    if (p) paths.add(p);
  };
  const rows = d.select().from(segments).where(inDrafts).all();
  for (const s of rows) {
    add(s.originalFilename);
    add(s.editedFilename);
    if (s.editedFilename) add(editedThumbRelPath(s.editedFilename));
    add(s.thumbnail);
    add(thumbRelPath(s.draftId, s.id));
    add(captionFile(s.captionEdit));
  }
  const files = d
    .select({ file: clipTranscripts.file })
    .from(clipTranscripts)
    .innerJoin(segments, eq(segments.id, clipTranscripts.segmentId))
    .where(inDrafts)
    .all();
  for (const { file } of files) add(file);
  const ids = d
    .select({ id: drafts.id })
    .from(drafts)
    .where(draftIds ? inArray(drafts.id, draftIds) : undefined)
    .all();
  for (const { id } of ids) add(exportRelPath(id));
  return paths;
}

/**
 * The files under `drafts/` nothing references. Null — sweep nothing — when a referenced path
 * isn't a plain relative one: it could name one of these files some other way.
 */
export function unreferencedFiles(files: string[], referenced: Set<string>): string[] | null {
  for (const p of referenced) {
    if (
      p.startsWith('/') ||
      p.includes('://') ||
      p.split('/').some((s) => s === '' || s === '.' || s === '..')
    ) {
      return null;
    }
  }
  return files.filter((f) => !referenced.has(f));
}

/** Every file under `dir`, as paths relative to the documents folder (`prefix/...`). */
function listFiles(dir: Directory, prefix: string): string[] {
  if (!dir.exists) return [];
  return dir
    .list()
    .flatMap((e) =>
      e instanceof Directory ? listFiles(e, `${prefix}/${e.name}`) : [`${prefix}/${e.name}`],
    );
}

/** Set by a recovery or a restore: media left without rows may still be wanted, so keep it. */
export const sweepHold = () => new File(Paths.document, 'backups', 'sweep-hold');

/**
 * Delete the files under `drafts/` that nothing in the library references (left by a crash between
 * a file write and its row, or by older versions' leaks), then empty draft folders. Run at launch,
 * before anything can be recording or rendering into `drafts/`. Returns how many files went.
 */
export function sweepUnreferencedMedia(conn: SQLiteDatabase, now: number): number {
  const hold = sweepHold();
  if (hold.exists && Number(hold.textSync()) > now) return 0;
  const root = new Directory(Paths.document, 'drafts');
  const orphans = unreferencedFiles(listFiles(root, 'drafts'), referencedMediaPaths(conn));
  if (!orphans) return 0;
  for (const rel of orphans) new File(Paths.document, ...rel.split('/')).delete();
  if (root.exists) {
    for (const dir of root.list()) {
      if (dir instanceof Directory && listFiles(dir, '').length === 0) dir.delete();
    }
  }
  return orphans.length;
}

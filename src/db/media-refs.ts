import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
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

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A path a row may store: relative, under `drafts/`, with no empty, `.` or `..` segment. */
export function isSafeMediaPath(path: string): boolean {
  return (
    path.startsWith('drafts/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/**
 * Refuse a library (a restored backup's database) whose ids or paths could reach outside
 * `drafts/`: draft and segment ids name folders and files, so `..` in one would let deleting a
 * draft delete the documents folder. Plain SQL over the columns the file has, so a backup from an
 * older schema (before its migrations run) is checked too.
 */
export function assertSafeLibrary(conn: SQLiteDatabase): void {
  const has = (table: string) =>
    conn
      .getAllSync<{ name: string }>(`PRAGMA table_info("${table}")`)
      .reduce((set, c) => set.add(c.name), new Set<string>());
  const strings = (table: string, column: string) =>
    has(table).has(column)
      ? conn
          .getAllSync<Record<string, unknown>>(`SELECT "${column}" AS v FROM "${table}"`)
          .map((r) => r.v)
          .filter((v): v is string => typeof v === 'string')
      : [];
  const ids = [...strings('drafts', 'id'), ...strings('segments', 'id')];
  if (ids.some((id) => !SAFE_ID.test(id))) throw new Error('Unsafe draft or clip id.');
  if (strings('segments', 'draft_id').some((id) => !SAFE_ID.test(id))) {
    throw new Error('Unsafe draft or clip id.');
  }
  const paths = [
    ...strings('segments', 'original_filename'),
    ...strings('segments', 'edited_filename'),
    ...strings('segments', 'thumbnail'),
    ...strings('clip_transcripts', 'file'),
    ...strings('segments', 'caption_edit').map(captionFile),
  ];
  for (const path of paths) {
    if (path != null && !isSafeMediaPath(path)) throw new Error('Unsafe media path.');
  }
}

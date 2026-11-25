import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

import { historyMediaPaths, parsePersistedHistory } from '@/db/persisted-history';
import { editedThumbRelPath, exportRelPath, thumbRelPath } from '@/utils/media-paths';
import { clipTranscripts, drafts, segments, voiceoverTakes } from './schema';
import { assertLibraryHistoryOwnership } from './undo-history';

/** The `file` a `caption_edit` value is timed against, if it has one. */
function captionFile(json: string | null): string | null {
  try {
    const file = json ? (JSON.parse(json) as { file?: unknown }).file : null;
    return typeof file === 'string' ? file : null;
  } catch {
    return null;
  }
}

/** Live row references, without durable undo: used consistently for retention and transfer. */
export function liveSegmentMediaPaths(
  rows: readonly Record<string, unknown>[],
  transcriptFiles: readonly string[] = [],
): Set<string> {
  const paths = new Set<string>(transcriptFiles);
  const add = (path: unknown) => {
    if (typeof path === 'string' && path) paths.add(path);
  };
  for (const row of rows) {
    add(row.originalFilename);
    add(row.editedFilename);
    if (typeof row.editedFilename === 'string') add(editedThumbRelPath(row.editedFilename));
    add(row.thumbnail);
    if (typeof row.draftId === 'string' && typeof row.id === 'string')
      add(thumbRelPath(row.draftId, row.id));
    add(captionFile(typeof row.captionEdit === 'string' ? row.captionEdit : null));
  }
  return paths;
}

/** Current clips and transcript files for one draft, excluding history-only retained media. */
export function liveDraftMediaPaths(conn: SQLiteDatabase, draftId: string): Set<string> {
  const d = drizzle(conn);
  const rows = d.select().from(segments).where(eq(segments.draftId, draftId)).all();
  const files = d
    .select({ file: clipTranscripts.file })
    .from(clipTranscripts)
    .innerJoin(segments, eq(segments.id, clipTranscripts.segmentId))
    .where(eq(segments.draftId, draftId))
    .all();
  return liveSegmentMediaPaths(
    rows,
    files.map((r) => r.file),
  );
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
  const rows = d.select().from(segments).where(inDrafts).all();
  const files = d
    .select({ file: clipTranscripts.file })
    .from(clipTranscripts)
    .innerJoin(segments, eq(segments.id, clipTranscripts.segmentId))
    .where(inDrafts)
    .all();
  const paths = liveSegmentMediaPaths(
    rows,
    files.map((r) => r.file),
  );
  for (const take of d
    .select({ filename: voiceoverTakes.filename })
    .from(voiceoverTakes)
    .where(draftIds ? inArray(voiceoverTakes.draftId, draftIds) : undefined)
    .all()) {
    paths.add(take.filename);
  }
  const ids = d
    .select({ id: drafts.id, undoHistory: drafts.undoHistory })
    .from(drafts)
    .where(draftIds ? inArray(drafts.id, draftIds) : undefined)
    .all();
  for (const { id, undoHistory } of ids) {
    paths.add(exportRelPath(id));
    const history = parsePersistedHistory(undoHistory, id);
    if (history) for (const path of historyMediaPaths(history)) paths.add(path);
  }
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
  const ids = [
    ...strings('drafts', 'id'),
    ...strings('segments', 'id'),
    ...strings('voiceover_takes', 'id'),
  ];
  if (ids.some((id) => !SAFE_ID.test(id))) throw new Error('Unsafe draft or clip id.');
  if (
    [...strings('segments', 'draft_id'), ...strings('voiceover_takes', 'draft_id')].some(
      (id) => !SAFE_ID.test(id),
    )
  ) {
    throw new Error('Unsafe draft or clip id.');
  }
  const paths = [
    ...strings('segments', 'original_filename'),
    ...strings('segments', 'edited_filename'),
    ...strings('segments', 'thumbnail'),
    ...strings('clip_transcripts', 'file'),
    ...strings('segments', 'caption_edit').map(captionFile),
    ...strings('voiceover_takes', 'filename'),
  ];
  for (const path of paths) {
    if (path != null && !isSafeMediaPath(path)) throw new Error('Unsafe media path.');
  }
  if (has('drafts').has('undo_history')) {
    // Dormant rows claim IDs too. All nested references must belong to their owning draft before
    // a backup can replace the library; safe paths alone cannot establish that ownership.
    assertLibraryHistoryOwnership(conn);
  }
}

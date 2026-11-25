import { eq, getTableColumns, inArray, is, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SQLiteDatabase } from 'expo-sqlite';

import journal from '../../drizzle/meta/_journal.json';
import {
  historyClipIds,
  historyOwnedClipIds,
  assertHistoryOwnership,
  parsePersistedHistory,
  remapPersistedHistory,
  requiredHistoryMediaPaths,
  trimPersistedHistory,
} from '@/db/persisted-history';
import { exportRelPath } from '@/utils/media-paths';
import { liveSegmentMediaPaths, referencedMediaPaths } from './media-refs';
import * as schema from './schema';
import { checkpointForRows, historyCheckpoint, historyOwners } from './undo-history';

// The `pulse-project` document (v2): every row of the chosen drafts — or of the whole library —
// with every column, read from the Drizzle schema so a new column is carried without code here.
// Media is listed, not embedded; the archive around the document carries the files.

export const PROJECT_FORMAT = 'pulse-project';
export const PROJECT_VERSION = 2;
export const PROJECT_NAME = 'project.json';

type Row = Record<string, unknown>;
export type ProjectDocument = {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  scope: 'selection' | 'library';
  /** The newest migration applied to the source library (`when` in drizzle's journal). */
  schemaVersion: number | null;
  exportedAt: number;
  /** Rows by SQL table name, keyed by the schema's property names. */
  tables: Record<string, Row[]>;
  /**
   * Files (relative to the documents folder) the rows need, with their sizes and native MD5. In a
   * `.pulse` file, `entry` is the file's name in the (flat) archive; a file without one is at
   * `media/<path>`, as the first v2 files had it.
   */
  media: { path: string; byteLength: number; md5?: string; entry?: string }[];
};

/**
 * Every table in schema.ts, parents before children (the order rows go in with foreign keys on).
 * Sorted from the foreign keys: a module's exports come in name order, not declaration order.
 */
const TABLES: SQLiteTable[] = (() => {
  const all = Object.values(schema as Record<string, unknown>).filter((v): v is SQLiteTable =>
    is(v, SQLiteTable),
  );
  const sorted: SQLiteTable[] = [];
  const visit = (t: SQLiteTable) => {
    if (sorted.includes(t)) return;
    for (const fk of getTableConfig(t).foreignKeys) visit(fk.reference().foreignTable);
    sorted.push(t);
  };
  all.forEach(visit);
  return sorted;
})();
const tableName = (t: SQLiteTable) => getTableConfig(t).name;
/** Tables a selection carries (a draft and its rows); the others go only with the library. */
const DRAFT_TABLES = new Set([
  'drafts',
  'segments',
  'draft_transcripts',
  'clip_transcripts',
  'voiceover_takes',
]);
const LIBRARY_TABLES = new Set(['settings', 'upload_destinations']);
/**
 * Tables that never travel: the upload outbox, the receipts of sent drafts and this install's own
 * values. No document or library backup carries them, and a document naming one is refused. A
 * restore keeps this phone's receipts and values; the jobs go with the drafts it replaces.
 */
export const LOCAL_TABLES = new Set(['upload_jobs', 'upload_receipts', 'local_settings']);
const isLocal = (t: SQLiteTable) => LOCAL_TABLES.has(tableName(t));
/** The tables documents and restores carry, parents first. */
const CARRIED = TABLES.filter((t) => !isLocal(t));
/**
 * What a restore keeps of this phone's LOCAL rows: the receipts and its own values. A restore
 * replaces every draft, so each outbox job goes with its draft.
 */
const KEPT_BY_RESTORE = TABLES.filter((t) => isLocal(t) && t !== schema.uploadJobs);

/** The newest schema migration this build ships. */
export const APP_SCHEMA_VERSION = journal.entries[journal.entries.length - 1].when;
export const KNOWN_SCHEMA_VERSIONS = new Set(journal.entries.map((e) => e.when));

/** The newest migration applied to `conn` (drizzle records each in `__drizzle_migrations`). */
export function schemaVersion(conn: SQLiteDatabase): number | null {
  const table = conn.getFirstSync(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
  );
  if (!table) return null; // a new install, before its first migration
  const row = conn.getFirstSync<{ v: number | null }>(
    'SELECT max(created_at) AS v FROM __drizzle_migrations',
  );
  return row?.v == null ? null : Number(row.v);
}

/**
 * Whether a newer Pulse migrated `conn`: its newest migration is later than this build's newest and
 * not one this build ships.
 */
export function isNewerSchema(conn: SQLiteDatabase): boolean {
  const version = schemaVersion(conn);
  return version != null && version > APP_SCHEMA_VERSION && !KNOWN_SCHEMA_VERSIONS.has(version);
}

/**
 * Fail closed when the database and schema.ts disagree: a table or column only the database has
 * (a migration without its schema change) would be left out of every export.
 */
export function assertSchemaCoverage(conn: SQLiteDatabase): void {
  const live = conn
    .getAllSync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'",
    )
    .map((r) => r.name);
  const known = new Map(TABLES.map((t) => [tableName(t), t]));
  for (const name of live) {
    const table = known.get(name);
    if (!table) throw new Error(`Export coverage: table ${name} is not in schema.ts`);
    if (!DRAFT_TABLES.has(name) && !LIBRARY_TABLES.has(name) && !LOCAL_TABLES.has(name)) {
      throw new Error(`Export coverage: table ${name} has no export scope`);
    }
    const columns = new Set(Object.values(getTableColumns(table)).map((c) => c.name));
    for (const { name: column } of conn.getAllSync<{ name: string }>(
      `PRAGMA table_xinfo("${name}")`,
    )) {
      if (!columns.has(column)) {
        throw new Error(`Export coverage: column ${name}.${column} is not in schema.ts`);
      }
    }
  }
}

/**
 * Fail when a database lacks a table or column this build's schema has: a restored backup, after
 * its migrations, must be a complete library (a file holding only the migration log isn't one).
 */
export function assertCurrentSchema(conn: SQLiteDatabase): void {
  for (const t of TABLES) {
    const name = tableName(t);
    const have = new Set(
      conn.getAllSync<{ name: string }>(`PRAGMA table_xinfo("${name}")`).map((c) => c.name),
    );
    if (have.size === 0) throw new Error(`Schema check: table ${name} is missing`);
    for (const column of Object.values(getTableColumns(t))) {
      if (!have.has(column.name)) {
        throw new Error(`Schema check: column ${name}.${column.name} is missing`);
      }
    }
  }
}

/** A table's rows: all of them, or those of the given drafts. */
function selectRows(conn: SQLiteDatabase, t: SQLiteTable, draftIds?: string[]): Row[] {
  const d = drizzle(conn);
  if (!draftIds)
    return d
      .select()
      .from(t)
      .orderBy(sql`rowid`)
      .all();
  const { drafts, segments, draftTranscripts, clipTranscripts, voiceoverTakes } = schema;
  const where =
    t === drafts
      ? inArray(drafts.id, draftIds)
      : t === segments
        ? inArray(segments.draftId, draftIds)
        : t === draftTranscripts
          ? inArray(draftTranscripts.draftId, draftIds)
          : t === voiceoverTakes
            ? inArray(voiceoverTakes.draftId, draftIds)
            : inArray(
                clipTranscripts.segmentId,
                d
                  .select({ id: segments.id })
                  .from(segments)
                  .where(inArray(segments.draftId, draftIds)),
              );
  return d
    .select()
    .from(t)
    .where(where)
    .orderBy(sql`rowid`)
    .all();
}

/**
 * The document for the given drafts (`selection`, without their merged exports: those are
 * merged again) or, with no ids, the whole library — settings and upload destinations included,
 * the destinations' tokens not (they stay in the secure store). `byteLength` is null for a file
 * that's gone; it's left out of the media list.
 */
export function buildProject(
  conn: SQLiteDatabase,
  opts: { draftIds?: string[]; now: number; byteLength: (rel: string) => number | null },
): ProjectDocument {
  assertSchemaCoverage(conn);
  const { draftIds } = opts;
  const tables: Record<string, Row[]> = {};
  for (const t of CARRIED) {
    const name = tableName(t);
    if (draftIds && !DRAFT_TABLES.has(name)) continue;
    tables[name] = selectRows(conn, t, draftIds);
  }
  const owners = historyOwners(conn);
  for (const row of tables.drafts ?? []) {
    const history = parsePersistedHistory(row.undoHistory as string | null, row.id as string);
    if (history) assertHistoryOwnership(history, row.id as string, owners);
    // A kill between a row write and the next undo checkpoint cannot transfer an older stack
    // against newer live rows. The current draft remains recoverable without that stack.
    if (history && history.checkpoint !== historyCheckpoint(conn, row.id as string)) {
      row.undoHistory = null;
    }
  }
  const exports = new Set(draftIds?.map(exportRelPath));
  const media = [...referencedMediaPaths(conn, draftIds)]
    .filter((p) => !exports.has(p))
    .sort()
    .flatMap((path) => {
      const byteLength = opts.byteLength(path);
      return byteLength == null ? [] : [{ path, byteLength }];
    });
  assertHistoryMedia(tables, new Map(media.map((m) => [m.path, m.byteLength])));
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    scope: draftIds ? 'selection' : 'library',
    schemaVersion: schemaVersion(conn),
    exportedAt: opts.now,
    tables,
    media,
  };
}

const NEWER = 'This file was made by a newer version of Pulse. Update Pulse to open it.';

/** A flat archive entry name, not one already listed: no folders, no `.` or `..`. */
const isPlainEntry = (entry: unknown, taken: Set<string>) =>
  typeof entry === 'string' &&
  entry !== '' &&
  entry !== '.' &&
  entry !== '..' &&
  !/[/\\]/.test(entry) &&
  !taken.has(entry);
const DAMAGED_PROJECT = 'This .pulse file is damaged.';

/** A project's canonical live and dormant rows establish ownership before any IDs are copied. */
function projectHistoryOwners(tables: Record<string, Row[]>): Map<string, string> {
  const owners = new Map<string, string>();
  const claim = (id: string, draftId: string) => {
    const current = owners.get(id);
    owners.set(id, current !== undefined && current !== draftId ? '' : draftId);
  };
  for (const row of tables.segments ?? []) claim(row.id as string, row.draftId as string);
  for (const row of tables.drafts ?? []) {
    const draftId = row.id as string;
    const history = parsePersistedHistory(row.undoHistory as string | null | undefined, draftId);
    if (history) for (const id of historyOwnedClipIds(history)) claim(id, draftId);
  }
  return owners;
}

/** Redo rows without their videos must never be accepted as a recoverable history. */
function assertHistoryMedia(
  tables: Record<string, Row[]>,
  carried: ReadonlyMap<string, number>,
): void {
  for (const row of tables.drafts ?? []) {
    const history = parsePersistedHistory(
      row.undoHistory as string | null | undefined,
      row.id as string,
    );
    if (history && [...requiredHistoryMediaPaths(history)].some((path) => !carried.has(path))) {
      throw new Error('Undo history media is missing.');
    }
    if (!history) continue;
    const clips = (tables.segments ?? []).filter((clip) => clip.draftId === row.id);
    const clipIds = new Set(clips.map((clip) => clip.id));
    const live = liveSegmentMediaPaths(
      clips,
      (tables.clip_transcripts ?? [])
        .filter((transcript) => clipIds.has(transcript.segmentId))
        .map((transcript) => transcript.file as string),
    );
    const retained = trimPersistedHistory(history, (path) => carried.get(path) ?? null, live);
    if (
      retained.past.length !== history.past.length ||
      retained.future.length !== history.future.length
    ) {
      throw new Error('Undo history exceeds its retention limit.');
    }
  }
}

/** A parsed document checked against this build's schema: no table or column it doesn't know. */
export function checkProject(value: unknown): ProjectDocument {
  const doc = value as ProjectDocument;
  if (
    doc?.format !== PROJECT_FORMAT ||
    typeof doc.tables !== 'object' ||
    !Array.isArray(doc.media)
  ) {
    throw new Error('This file isn’t a Pulse project.');
  }
  if (doc.version > PROJECT_VERSION) throw new Error(NEWER);
  const known = new Map(
    TABLES.map((t) => [tableName(t), new Set(Object.keys(getTableColumns(t)))]),
  );
  for (const [name, rows] of Object.entries(doc.tables)) {
    // Never written into a document: one that carries them wasn't made by Pulse.
    if (LOCAL_TABLES.has(name)) throw new Error(DAMAGED_PROJECT);
    const columns = known.get(name);
    if (!columns || !Array.isArray(rows)) throw new Error(NEWER);
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) throw new Error(DAMAGED_PROJECT);
      if (Object.keys(row).some((k) => !columns.has(k))) throw new Error(NEWER);
    }
  }
  // Every child row's parent is in the file: a copy remaps ids through its parent, and an orphan
  // would land under `drafts/undefined/`.
  const t = doc.tables;
  const idsOf = (rows: Row[] | undefined) => new Set((rows ?? []).map((r) => r.id));
  const draftIds = idsOf(t.drafts);
  const segmentIds = idsOf(t.segments);
  const takeIds = idsOf(t.voiceover_takes);
  if (
    [...draftIds, ...segmentIds, ...takeIds].some((id) => typeof id !== 'string') ||
    (t.segments ?? []).some((r) => !draftIds.has(r.draftId)) ||
    (t.draft_transcripts ?? []).some((r) => !draftIds.has(r.draftId)) ||
    (t.clip_transcripts ?? []).some((r) => !segmentIds.has(r.segmentId)) ||
    (t.voiceover_takes ?? []).some((r) => !draftIds.has(r.draftId))
  ) {
    throw new Error(DAMAGED_PROJECT);
  }
  try {
    const owners = projectHistoryOwners(t);
    for (const row of t.drafts ?? []) {
      const history = parsePersistedHistory(
        row.undoHistory as string | null | undefined,
        row.id as string,
      );
      if (history) assertHistoryOwnership(history, row.id as string, owners);
      if (
        history &&
        history.checkpoint !==
          checkpointForRows(
            row.captionY,
            (t.segments ?? []).filter((clip) => clip.draftId === row.id),
          )
      )
        throw new Error(DAMAGED_PROJECT);
    }
    assertHistoryMedia(t, new Map(doc.media.map((m) => [m.path, m.byteLength])));
  } catch {
    throw new Error(DAMAGED_PROJECT);
  }
  const entries = new Set<string>([PROJECT_NAME]);
  for (const m of doc.media) {
    if (
      typeof m.path !== 'string' ||
      m.path.startsWith('/') ||
      m.path.split('/').includes('..') ||
      !Number.isSafeInteger(m.byteLength) ||
      m.byteLength < 0 ||
      (m.md5 !== undefined && !/^[0-9a-f]{32}$/.test(m.md5)) ||
      (m.entry !== undefined && !isPlainEntry(m.entry, entries))
    ) {
      throw new Error('This file isn’t a Pulse project.');
    }
    if (m.entry !== undefined) entries.add(m.entry);
  }
  return doc;
}

/**
 * Insert `rows` (by table name) in schema order, in batches under SQLite's variable limit. LOCAL
 * tables are never inserted from a document.
 */
function insertAll(
  tx: { insert: ReturnType<typeof drizzle>['insert'] },
  rows: Record<string, Row[]>,
) {
  const legacyBeatTimes = new Map(
    (rows.drafts ?? []).map((draft) => [draft.id, draft.lastModified ?? draft.createdAt ?? 0]),
  );
  for (const t of CARRIED) {
    const source = rows[tableName(t)] ?? [];
    const list =
      t === schema.segments
        ? source.map((row) => ({
            ...row,
            // Documents from before beat timestamps get the same approximation as migration 0021.
            addedAt: row.addedAt ?? legacyBeatTimes.get(row.draftId) ?? 0,
          }))
        : source;
    for (let i = 0; i < list.length; i += 100) {
      tx.insert(t)
        .values(list.slice(i, i + 100))
        .run();
    }
  }
}

/**
 * Exact restore: the library becomes the document's rows, in one transaction. The caller puts
 * the media back first (same paths) — rows never point at files that aren't there yet. This
 * phone's receipts and local settings stay as they were; the outbox jobs go with the drafts the
 * restore replaces (as the foreign key's cascade would delete them).
 */
export function restoreProject(conn: SQLiteDatabase, doc: ProjectDocument): void {
  if (doc.scope !== 'library') throw new Error('Only a library backup can replace the library.');
  drizzle(conn).transaction((tx) => {
    tx.delete(schema.uploadJobs).run();
    for (const t of [...CARRIED].reverse()) tx.delete(t).run();
    insertAll(tx, doc.tables);
  });
}

/** The LOCAL tables `conn` has (a library before migration 0020 has none). */
function localTablesIn(conn: SQLiteDatabase): SQLiteTable[] {
  return TABLES.filter(
    (t) =>
      isLocal(t) &&
      conn.getFirstSync(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        tableName(t),
      ) != null,
  );
}

/** Empty `conn`'s LOCAL tables: a library backup's copy of the database carries none of them. */
export function clearLocalTables(conn: SQLiteDatabase): void {
  const tables = localTablesIn(conn);
  drizzle(conn).transaction((tx) => {
    for (const t of tables) tx.delete(t).run();
  });
}

/**
 * Before a library backup's database (`to`) replaces this phone's (`from`), as `restoreProject`
 * does for a document: `to` gets this phone's receipts and local settings instead of any it has,
 * and no outbox jobs (the restore replaces every draft). A table `to` lacks (a backup from before
 * migration 0020) can't take rows: they're dropped, as on a fresh install. If the rows can't be
 * carried, `to` is left with none rather than another phone's.
 */
export function carryLocalTables(from: SQLiteDatabase, to: SQLiteDatabase): void {
  const target = localTablesIn(to);
  try {
    const source = new Set(localTablesIn(from));
    const read = drizzle(from);
    const rows = KEPT_BY_RESTORE.filter((t) => target.includes(t) && source.has(t)).map(
      (t) => [t, read.select().from(t).all() as Row[]] as const,
    );
    drizzle(to).transaction((tx) => {
      for (const t of target) tx.delete(t).run();
      for (const [t, list] of rows) {
        for (let i = 0; i < list.length; i += 100) {
          tx.insert(t)
            .values(list.slice(i, i + 100))
            .run();
        }
      }
    });
  } catch (e) {
    console.warn('[db] this phone’s local rows could not be carried into the restore', e);
    clearLocalTables(to);
  }
}

export type CopyPlan = {
  rows: Record<string, Row[]>;
  /** New relative path → the document's path, for every file the copy needs. */
  files: Map<string, string>;
  draftIds: string[];
};

/**
 * A copy of the document's drafts under fresh ids, every path moved under the new ids (as
 * `duplicateDraft` names them) and every reference to a path — signatures, caption edits, clip
 * transcripts — rewritten to match. Not carried, as for a duplicate: the upload pairing, the
 * place (a link's or a host's), and the merged export (merged again). Pure; `commitCopy` writes it.
 */
export function planCopy(doc: ProjectDocument, freshId: () => string): CopyPlan {
  const t = doc.tables;
  const draftIds = new Map((t.drafts ?? []).map((r) => [r.id as string, freshId()]));
  // Snapshot-only IDs (e.g. a deleted clip) and dormant redo rows also belong to this copy.
  // Maps are per draft: even a historical reference to another draft's old ID cannot link the
  // imported history to that draft, or to another draft imported in the same file.
  const segIds = new Map<string, Map<string, string>>(
    [...draftIds.keys()].map((id) => [id, new Map()]),
  );
  const clipId = (draft: string, id: string) => {
    const ids = segIds.get(draft)!;
    if (!ids.has(id)) ids.set(id, freshId());
    return ids.get(id)!;
  };
  for (const row of t.segments ?? []) clipId(row.draftId as string, row.id as string);
  const histories = new Map(
    (t.drafts ?? []).map((r) => [
      r.id as string,
      parsePersistedHistory(r.undoHistory as string | null | undefined, r.id as string),
    ]),
  );
  for (const [draft, history] of histories) {
    if (history) for (const id of historyClipIds(history)) clipId(draft, id);
  }
  const takeIds = new Map((t.voiceover_takes ?? []).map((r) => [r.id as string, freshId()]));
  const draftOfSeg = new Map((t.segments ?? []).map((r) => [r.id as string, r.draftId as string]));
  const paths = new Map<string, Map<string, string>>(
    [...draftIds.keys()].map((id) => [id, new Map()]),
  ); // owning draft → old path → new path
  const files = new Map<string, string>(); // new → old
  const reserved = new Map<string, string>(); // destination → source, including optional files
  let collision = 0;
  const carried = new Set(doc.media.map((m) => m.path));
  const remap = (old: string, oldDraft: string) => {
    const mapped = paths.get(oldDraft)!;
    if (mapped.has(old)) return mapped.get(old)!;
    const name = old.slice(old.lastIndexOf('/') + 1);
    const stem = name.split('.')[0];
    const directory = old.split('/')[2] === 'voiceovers' ? 'voiceovers' : 'segments';
    const mappedId =
      directory === 'voiceovers' ? takeIds.get(stem) : segIds.get(oldDraft)!.get(stem);
    const folder = `drafts/${draftIds.get(oldDraft)}/${directory}`;
    let next = `${folder}/${mappedId ?? stem}${name.slice(stem.length)}`;
    while (reserved.has(next) && reserved.get(next) !== old) {
      next = `${folder}/retained-${++collision}-${name}`;
    }
    reserved.set(next, old);
    mapped.set(old, next);
    if (carried.has(old)) files.set(next, old);
    return next;
  };
  const remapCaption = (json: unknown, oldDraft: string) => {
    try {
      const v = JSON.parse(json as string);
      return typeof v?.file === 'string'
        ? JSON.stringify({ ...v, file: remap(v.file, oldDraft) })
        : json;
    } catch {
      return json; // unreadable text is still the person's data: carried as is
    }
  };
  const segments = (t.segments ?? []).map((r) => {
    const draft = r.draftId as string;
    const p = (v: unknown) => (typeof v === 'string' ? remap(v, draft) : v);
    return {
      ...r,
      id: clipId(draft, r.id as string),
      draftId: draftIds.get(draft),
      originalFilename: p(r.originalFilename),
      editedFilename: p(r.editedFilename),
      thumbnail: p(r.thumbnail),
      captionEdit: r.captionEdit == null ? null : remapCaption(r.captionEdit, draft),
    };
  });
  const voiceovers = (t.voiceover_takes ?? []).map((r) => ({
    ...r,
    id: takeIds.get(r.id as string),
    draftId: draftIds.get(r.draftId as string),
    filename: remap(r.filename as string, r.draftId as string),
  }));
  // Derived files (pristine and baked-edit thumbs) that the document carried.
  for (const m of doc.media) {
    const draft = m.path.split('/')[1];
    if (draftIds.has(draft) && !paths.get(draft)!.has(m.path)) remap(m.path, draft);
  }
  const clips = (t.clip_transcripts ?? []).map((r) => {
    const draft = draftOfSeg.get(r.segmentId as string)!;
    return {
      ...r,
      segmentId: clipId(draft, r.segmentId as string),
      file: remap(r.file as string, draft),
    };
  });
  const copiedHistory = new Map(
    [...histories].map(([draft, history]) => [
      draft,
      history
        ? JSON.stringify(
            remapPersistedHistory(history, {
              draftId: draftIds.get(draft)!,
              mapId: (id) => clipId(draft, id),
              mapPath: (path) => remap(path, draft),
            }),
          )
        : null,
    ]),
  );
  // A signature joins file paths. Each owning draft gets its own mapping when drafts share a
  // source file; the copy's transcript must never retain a path into a sibling or source draft.
  const resign = (s: unknown, draft: string) => {
    const mapped = paths.get(draft)!;
    const known = [...mapped.keys()].sort((a, b) => b.length - a.length);
    const pattern = known.length
      ? new RegExp(known.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
      : null;
    return typeof s === 'string' && pattern ? s.replace(pattern, (m) => mapped.get(m)!) : s;
  };
  return {
    draftIds: [...draftIds.values()],
    files,
    rows: {
      drafts: (t.drafts ?? []).map((r) => ({
        ...r,
        id: draftIds.get(r.id as string),
        undoHistory: copiedHistory.get(r.id as string),
        uploadServer: null,
        uploadArtifactId: null,
        uploadStatus: null,
        contextServer: null,
        contextRef: null,
        // A copy isn't for the original's host place, nor sent or confirmed (its origin stays).
        contextKey: null,
        contextLabel: null,
        contextJson: null,
        uploadTypeJson: null,
        hostConfirmedAt: null,
        sentAt: null,
        mergedSignature: null,
        mergedDurationMs: null,
      })),
      segments,
      voiceover_takes: voiceovers,
      draft_transcripts: (t.draft_transcripts ?? []).map((r) => ({
        ...r,
        draftId: draftIds.get(r.draftId as string),
        signature: resign(r.signature, r.draftId as string),
      })),
      clip_transcripts: clips,
    },
  };
}

/** Commit a copy's rows in one transaction, once its files are in place. */
export function commitCopy(conn: SQLiteDatabase, plan: CopyPlan): void {
  drizzle(conn).transaction((tx) => {
    insertAll(tx, plan.rows);
    // Copying changes IDs and paths, so the source checkpoint cannot describe the new rows.
    // Stamp it in the same transaction as the rows, after all children have been inserted.
    for (const row of plan.rows.drafts ?? []) {
      const id = row.id as string;
      const history = parsePersistedHistory(row.undoHistory as string | null | undefined, id);
      if (!history) continue;
      const saved = JSON.stringify({ ...history, checkpoint: historyCheckpoint(conn, id) });
      // Longer copied IDs/paths can enlarge an otherwise valid source envelope. Refuse the
      // whole copy transaction rather than importing history that cannot hydrate on reopening.
      parsePersistedHistory(saved, id);
      tx.update(schema.drafts)
        .set({
          undoHistory: saved,
        })
        .where(eq(schema.drafts.id, id))
        .run();
    }
  });
}

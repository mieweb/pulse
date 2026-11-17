import { getTableColumns, inArray, is, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SQLiteDatabase } from 'expo-sqlite';

import journal from '../../drizzle/meta/_journal.json';
import { exportRelPath } from '@/utils/media-paths';
import { referencedMediaPaths } from './media-refs';
import * as schema from './schema';

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
const DRAFT_TABLES = new Set(['drafts', 'segments', 'draft_transcripts', 'clip_transcripts']);
const LIBRARY_TABLES = new Set(['settings', 'upload_destinations']);

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
    if (!DRAFT_TABLES.has(name) && !LIBRARY_TABLES.has(name)) {
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
  const { drafts, segments, draftTranscripts, clipTranscripts } = schema;
  const where =
    t === drafts
      ? inArray(drafts.id, draftIds)
      : t === segments
        ? inArray(segments.draftId, draftIds)
        : t === draftTranscripts
          ? inArray(draftTranscripts.draftId, draftIds)
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
  for (const t of TABLES) {
    const name = tableName(t);
    if (draftIds && !DRAFT_TABLES.has(name)) continue;
    tables[name] = selectRows(conn, t, draftIds);
  }
  const exports = new Set(draftIds?.map(exportRelPath));
  const media = [...referencedMediaPaths(conn, draftIds)]
    .filter((p) => !exports.has(p))
    .sort()
    .flatMap((path) => {
      const byteLength = opts.byteLength(path);
      return byteLength == null ? [] : [{ path, byteLength }];
    });
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
  if (
    [...draftIds, ...segmentIds].some((id) => typeof id !== 'string') ||
    (t.segments ?? []).some((r) => !draftIds.has(r.draftId)) ||
    (t.draft_transcripts ?? []).some((r) => !draftIds.has(r.draftId)) ||
    (t.clip_transcripts ?? []).some((r) => !segmentIds.has(r.segmentId))
  ) {
    throw new Error(DAMAGED_PROJECT);
  }
  const entries = new Set<string>([PROJECT_NAME]);
  for (const m of doc.media) {
    if (
      typeof m.path !== 'string' ||
      m.path.startsWith('/') ||
      m.path.split('/').includes('..') ||
      (m.md5 !== undefined && !/^[0-9a-f]{32}$/.test(m.md5)) ||
      (m.entry !== undefined && !isPlainEntry(m.entry, entries))
    ) {
      throw new Error('This file isn’t a Pulse project.');
    }
    if (m.entry !== undefined) entries.add(m.entry);
  }
  return doc;
}

/** Insert `rows` (by table name) in schema order, in batches under SQLite's variable limit. */
function insertAll(
  tx: { insert: ReturnType<typeof drizzle>['insert'] },
  rows: Record<string, Row[]>,
) {
  for (const t of TABLES) {
    const list = rows[tableName(t)] ?? [];
    for (let i = 0; i < list.length; i += 100) {
      tx.insert(t)
        .values(list.slice(i, i + 100))
        .run();
    }
  }
}

/**
 * Exact restore: the library becomes the document's rows, in one transaction. The caller puts
 * the media back first (same paths) — rows never point at files that aren't there yet.
 */
export function restoreProject(conn: SQLiteDatabase, doc: ProjectDocument): void {
  if (doc.scope !== 'library') throw new Error('Only a library backup can replace the library.');
  drizzle(conn).transaction((tx) => {
    for (const t of [...TABLES].reverse()) tx.delete(t).run();
    insertAll(tx, doc.tables);
  });
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
 * place, and the merged export (merged again). Pure; `commitCopy` writes it.
 */
export function planCopy(doc: ProjectDocument, freshId: () => string): CopyPlan {
  const t = doc.tables;
  const draftIds = new Map((t.drafts ?? []).map((r) => [r.id as string, freshId()]));
  const segIds = new Map((t.segments ?? []).map((r) => [r.id as string, freshId()]));
  const draftOfSeg = new Map((t.segments ?? []).map((r) => [r.id as string, r.draftId as string]));
  const paths = new Map<string, string>(); // old → new
  const files = new Map<string, string>(); // new → old
  const carried = new Set(doc.media.map((m) => m.path));
  const remap = (old: string, oldDraft: string) => {
    const name = old.slice(old.lastIndexOf('/') + 1);
    const stem = name.split('.')[0];
    const next = `drafts/${draftIds.get(oldDraft)}/segments/${segIds.get(stem) ?? stem}${name.slice(stem.length)}`;
    paths.set(old, next);
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
      id: segIds.get(r.id as string),
      draftId: draftIds.get(draft),
      originalFilename: p(r.originalFilename),
      editedFilename: p(r.editedFilename),
      thumbnail: p(r.thumbnail),
      captionEdit: r.captionEdit == null ? null : remapCaption(r.captionEdit, draft),
    };
  });
  // Derived files (pristine and baked-edit thumbs) that the document carried.
  for (const m of doc.media) {
    const draft = m.path.split('/')[1];
    if (!paths.has(m.path) && draftIds.has(draft)) remap(m.path, draft);
  }
  const clips = (t.clip_transcripts ?? []).map((r) => {
    const draft = draftOfSeg.get(r.segmentId as string)!;
    return {
      ...r,
      segmentId: segIds.get(r.segmentId as string),
      file: remap(r.file as string, draft),
    };
  });
  // A signature joins the clips' file paths: rewrite each known path, longest first, in one pass.
  const known = [...paths.keys()].sort((a, b) => b.length - a.length);
  const pattern = known.length
    ? new RegExp(known.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : null;
  const resign = (s: unknown) =>
    typeof s === 'string' && pattern ? s.replace(pattern, (m) => paths.get(m)!) : s;
  return {
    draftIds: [...draftIds.values()],
    files,
    rows: {
      drafts: (t.drafts ?? []).map((r) => ({
        ...r,
        id: draftIds.get(r.id as string),
        uploadServer: null,
        uploadArtifactId: null,
        uploadStatus: null,
        contextServer: null,
        contextRef: null,
        mergedSignature: null,
        mergedDurationMs: null,
      })),
      segments,
      draft_transcripts: (t.draft_transcripts ?? []).map((r) => ({
        ...r,
        draftId: draftIds.get(r.draftId as string),
        signature: resign(r.signature),
      })),
      clip_transcripts: clips,
    },
  };
}

/** Commit a copy's rows in one transaction, once its files are in place. */
export function commitCopy(conn: SQLiteDatabase, plan: CopyPlan): void {
  drizzle(conn).transaction((tx) => insertAll(tx, plan.rows));
}

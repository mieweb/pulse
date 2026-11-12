import {
  validatePulseDocument,
  validatePulseState,
  type PulseDocument,
  type PulseState,
} from './document';

type PulseSqlValue = string | number | null;

/** Structural subset shared by Expo SQLite and the native-free test adapter. */
export interface PulseSqliteDatabase {
  getAllSync<T>(sql: string, ...params: PulseSqlValue[]): T[];
  runSync(sql: string, params: PulseSqlValue[]): unknown;
  execSync(sql: string): void;
}

type StateKey = keyof PulseState;
type StateMappings = {
  [K in StateKey]: {
    table: string;
    columns: { [P in keyof PulseState[K][number]]: string };
    orderBy: readonly string[];
  };
};

// Explicit aliases keep the portable format independent of a platform ORM. The mapped
// type checks every portable field; assertPulseSchemaCoverage checks the actual database.
const mappings = {
  drafts: {
    table: 'drafts',
    columns: {
      id: 'id',
      name: 'name',
      uploadServer: 'upload_server',
      uploadArtifactId: 'upload_artifact_id',
      uploadStatus: 'upload_status',
      contextServer: 'context_server',
      contextRef: 'context_ref',
      mergedSignature: 'merged_signature',
      mergedDurationMs: 'merged_duration_ms',
      captionY: 'caption_y',
      lastClipNumber: 'last_clip_number',
      createdAt: 'created_at',
      lastModified: 'last_modified',
    },
    orderBy: ['id'],
  },
  segments: {
    table: 'segments',
    columns: {
      id: 'id',
      draftId: 'draft_id',
      order: 'sort_order',
      label: 'label',
      originalFilename: 'original_filename',
      durationMs: 'duration_ms',
      editedFilename: 'edited_filename',
      editedDurationMs: 'edited_duration_ms',
      editState: 'edit_state',
      thumbnail: 'thumbnail',
      captionEdit: 'caption_edit',
    },
    orderBy: ['draft_id', 'sort_order', 'id'],
  },
  draftTranscripts: {
    table: 'draft_transcripts',
    columns: {
      draftId: 'draft_id',
      signature: 'signature',
      model: 'model',
      status: 'status',
      lines: 'lines',
      editedLines: 'edited_lines',
      durationMs: 'duration_ms',
      createdAt: 'created_at',
    },
    orderBy: ['draft_id'],
  },
  clipTranscripts: {
    table: 'clip_transcripts',
    columns: {
      segmentId: 'segment_id',
      model: 'model',
      file: 'file',
      status: 'status',
      words: 'words',
      createdAt: 'created_at',
    },
    orderBy: ['segment_id', 'model'],
  },
  settings: {
    table: 'settings',
    columns: { key: 'key', value: 'value' },
    orderBy: ['key'],
  },
  uploadDestinations: {
    table: 'upload_destinations',
    columns: {
      id: 'id',
      server: 'server',
      artifactId: 'artifact_id',
      ref: 'ref',
      label: 'label',
      app: 'app',
      returnUrl: 'return_url',
      createdAt: 'created_at',
    },
    orderBy: ['id'],
  },
} as const satisfies StateMappings;

const stateKeys = Object.keys(mappings) as StateKey[];
const headerTable = '__pulse_document';
const headerTableSql = `CREATE TABLE IF NOT EXISTS ${headerTable} (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  header_json TEXT NOT NULL
)`;
let savepointNumber = 0;

function identifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** SAVEPOINT also works when the caller already owns a SQLite transaction. */
function inSavepoint<T>(db: PulseSqliteDatabase, work: () => T): T {
  const name = identifier(`pulse_state_${++savepointNumber}`);
  db.execSync(`SAVEPOINT ${name}`);
  try {
    const result = work();
    db.execSync(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      db.execSync(`ROLLBACK TO SAVEPOINT ${name}`);
    } catch (rollbackError) {
      failures.push(rollbackError);
    }
    try {
      db.execSync(`RELEASE SAVEPOINT ${name}`);
    } catch (releaseError) {
      failures.push(releaseError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Pulse state operation and savepoint recovery failed');
    }
    throw error;
  }
}

/** Fail closed when a schema change has not been added to the lossless document mapping. */
export function assertPulseSchemaCoverage(db: PulseSqliteDatabase): void {
  const expectedTables = new Set<string>(stateKeys.map((key) => mappings[key].table));
  const schema = db.getAllSync<{ name: string; sql: string }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
  );
  const tables = schema
    .map((row) => row.name)
    .filter((name) => name !== '__drizzle_migrations' && !name.startsWith('sqlite_'));

  for (const table of tables) {
    if (table === headerTable) {
      const columns = db.getAllSync<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
        hidden: number;
      }>(`PRAGMA table_xinfo(${identifier(headerTable)})`);
      const [id, header] = columns;
      if (
        columns.length !== 2 ||
        id.name !== 'id' ||
        id.type.toUpperCase() !== 'INTEGER' ||
        id.pk !== 1 ||
        id.notnull !== 0 ||
        id.dflt_value !== null ||
        id.hidden !== 0 ||
        header.name !== 'header_json' ||
        header.type.toUpperCase() !== 'TEXT' ||
        header.pk !== 0 ||
        header.notnull !== 1 ||
        header.dflt_value !== null ||
        header.hidden !== 0 ||
        !/CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(schema.find((row) => row.name === table)?.sql ?? '')
      ) {
        throw new Error('Pulse schema coverage: invalid __pulse_document projection schema');
      }
      continue;
    }
    if (!expectedTables.has(table)) {
      throw new Error(`Pulse schema coverage: unmapped table ${table}`);
    }
  }
  for (const key of stateKeys) {
    const { table, columns } = mappings[key];
    if (!tables.includes(table)) throw new Error(`Pulse schema coverage: missing table ${table}`);
    const expectedColumns = new Set<string>(Object.values(columns));
    // table_xinfo includes generated/hidden columns, which must not escape coverage checks.
    const actualColumns = db
      .getAllSync<{ name: string }>(`PRAGMA table_xinfo(${identifier(table)})`)
      .map((row) => row.name);
    for (const column of actualColumns) {
      if (!expectedColumns.has(column)) {
        throw new Error(`Pulse schema coverage: unmapped column ${table}.${column}`);
      }
    }
    for (const column of expectedColumns) {
      if (!actualColumns.includes(column)) {
        throw new Error(`Pulse schema coverage: missing column ${table}.${column}`);
      }
    }
  }
}

function readTable<K extends StateKey>(db: PulseSqliteDatabase, key: K): PulseState[K] {
  const { table, columns, orderBy } = mappings[key];
  const aliases = Object.entries(columns).map(
    ([property, column]) => `${identifier(column)} AS ${identifier(property)}`,
  );
  return db.getAllSync<PulseState[K][number]>(
    `SELECT ${aliases.join(', ')} FROM ${identifier(table)} ORDER BY ${orderBy.map(identifier).join(', ')}`,
  ) as PulseState[K];
}

/** Read all 48 application columns in one consistent, deterministically ordered snapshot. */
export function readPulseState(db: PulseSqliteDatabase): PulseState {
  return inSavepoint(db, () => {
    assertPulseSchemaCoverage(db);
    const state: PulseState = {
      drafts: readTable(db, 'drafts'),
      segments: readTable(db, 'segments'),
      draftTranscripts: readTable(db, 'draftTranscripts'),
      clipTranscripts: readTable(db, 'clipTranscripts'),
      settings: readTable(db, 'settings'),
      uploadDestinations: readTable(db, 'uploadDestinations'),
    };
    validatePulseState(state);
    return state;
  });
}

/**
 * Replace only the projection. The caller validates media/canonical authority and gates
 * jobs/cleanup before calling this; this function performs no media or credential work.
 */
export function replacePulseState(db: PulseSqliteDatabase, state: PulseState): void {
  validatePulseState(state);
  inSavepoint(db, () => {
    assertPulseSchemaCoverage(db);
    // Children first even when foreign_keys is enabled; never disable referential checks.
    for (const key of [
      'clipTranscripts',
      'draftTranscripts',
      'segments',
      'drafts',
      'settings',
      'uploadDestinations',
    ] as const) {
      db.execSync(`DELETE FROM ${identifier(mappings[key].table)}`);
    }
    for (const key of stateKeys) {
      const { table, columns } = mappings[key];
      const entries = Object.entries(columns);
      const sql = `INSERT INTO ${identifier(table)} (${entries.map(([, column]) => identifier(column)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`;
      for (const row of state[key]) {
        const cells = row as unknown as Record<string, PulseSqlValue>;
        db.runSync(
          sql,
          entries.map(([property]) => cells[property]),
        );
      }
    }
    if (db.getAllSync('PRAGMA foreign_key_check').length > 0) {
      throw new Error('Pulse state restore failed foreign-key validation');
    }
  });
}

/** Stage canonical document metadata in the same disposable SQL transaction as its rows. */
export function writePulseDocumentHeader(db: PulseSqliteDatabase, document: PulseDocument): void {
  validatePulseDocument(document);
  const { state, ...documentHeader } = document;
  const collectionOrder = Object.fromEntries(
    stateKeys.map((key) => [key, state[key].map((row) => rowIdentity(key, row))]),
  );
  inSavepoint(db, () => {
    assertPulseSchemaCoverage(db);
    db.execSync(headerTableSql);
    db.runSync(
      `INSERT INTO ${headerTable} (id, header_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET header_json = excluded.header_json`,
      [JSON.stringify({ documentHeader, collectionOrder })],
    );
  });
}

/** Reconstruct the complete canonical-shaped object, including revision/scope/assets. */
export function readPulseDocumentFromDatabase(db: PulseSqliteDatabase): PulseDocument {
  return inSavepoint(db, () => {
    assertPulseSchemaCoverage(db);
    const present = db.getAllSync(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      headerTable,
    );
    if (present.length !== 1) throw new Error('The Pulse projection has no document header.');
    const rows = db.getAllSync<{ id: number; header_json: string }>(
      `SELECT id, header_json FROM ${headerTable}`,
    );
    if (rows.length !== 1 || rows[0].id !== 1) {
      throw new Error('The Pulse projection document header is missing or invalid.');
    }
    const projection: unknown = JSON.parse(rows[0].header_json);
    if (
      !isRecord(projection) ||
      Object.keys(projection).sort().join(',') !== 'collectionOrder,documentHeader'
    ) {
      throw new Error('The Pulse projection document header is invalid.');
    }
    const { documentHeader, collectionOrder } = projection;
    if (
      !isRecord(documentHeader) ||
      'state' in documentHeader ||
      !isRecord(collectionOrder) ||
      Object.keys(collectionOrder).sort().join(',') !== [...stateKeys].sort().join(',')
    ) {
      throw new Error('The Pulse projection document header is invalid.');
    }
    const state = readPulseState(db);
    for (const key of stateKeys) restoreCollectionOrder(state, key, collectionOrder[key]);
    const document = { ...documentHeader, state };
    validatePulseDocument(document);
    return document;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rowIdentity(key: StateKey, row: PulseState[StateKey][number]): string {
  const fields = row as unknown as Record<string, PulseSqlValue>;
  if (key === 'draftTranscripts') return fields.draftId as string;
  if (key === 'clipTranscripts') return JSON.stringify([fields.segmentId, fields.model]);
  if (key === 'settings') return fields.key as string;
  return fields.id as string;
}

function restoreCollectionOrder<K extends StateKey>(
  state: PulseState,
  key: K,
  order: unknown,
): void {
  if (!Array.isArray(order) || !order.every((id): id is string => typeof id === 'string')) {
    throw new Error(`Invalid Pulse projection collection order: ${key}`);
  }
  const rows = new Map(state[key].map((row) => [rowIdentity(key, row), row]));
  if (
    order.length !== rows.size ||
    new Set(order).size !== order.length ||
    order.some((id) => !rows.has(id))
  ) {
    throw new Error(`Pulse projection collection order does not match its rows: ${key}`);
  }
  state[key] = order.map((id) => rows.get(id)!) as PulseState[K];
}

/** Restore the entire disposable projection atomically, never promoting its header to authority. */
export function replacePulseDocument(db: PulseSqliteDatabase, document: PulseDocument): void {
  validatePulseDocument(document);
  inSavepoint(db, () => {
    replacePulseState(db, document.state);
    writePulseDocumentHeader(db, document);
  });
}

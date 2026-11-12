import { parseDocument, stringify } from 'yaml';

/** Versioned, platform-neutral representation of every application SQLite column. */
export type PulseDraft = {
  id: string;
  name: string | null;
  uploadServer: string | null;
  uploadArtifactId: string | null;
  uploadStatus: 'uploading' | 'uploaded' | null;
  contextServer: string | null;
  contextRef: string | null;
  mergedSignature: string | null;
  mergedDurationMs: number | null;
  captionY: number | null;
  lastClipNumber: number;
  createdAt: number;
  lastModified: number;
};

export type PulseSegment = {
  id: string;
  draftId: string;
  order: number;
  label: string | null;
  originalFilename: string;
  durationMs: number;
  editedFilename: string | null;
  editedDurationMs: number | null;
  /** Opaque persisted text: even malformed legacy settings must survive a restore. */
  editState: string | null;
  thumbnail: string | null;
  captionEdit: string | null;
};

export type PulseDraftTranscript = {
  draftId: string;
  signature: string;
  model: string | null;
  status: 'processing' | 'done' | 'error';
  lines: string | null;
  editedLines: string | null;
  durationMs: number | null;
  createdAt: number;
};

export type PulseClipTranscript = {
  segmentId: string;
  model: string;
  file: string;
  status: 'done' | 'error';
  words: string | null;
  createdAt: number;
};

export type PulseSetting = { key: string; value: string | null };

export type PulseUploadDestination = {
  id: string;
  server: string;
  artifactId: string;
  ref: string | null;
  label: string | null;
  app: string | null;
  returnUrl: string | null;
  createdAt: number;
};

export type PulseState = {
  drafts: PulseDraft[];
  segments: PulseSegment[];
  draftTranscripts: PulseDraftTranscript[];
  clipTranscripts: PulseClipTranscript[];
  settings: PulseSetting[];
  uploadDestinations: PulseUploadDestination[];
};

export type PulseAsset = {
  /** Document-directory-relative source path; never an absolute URI. */
  path: string;
  /** ZIP member name, under assets/. May differ from the source path. */
  archivePath: string;
  byteLength: number;
  sha256: string;
};

export type PulseDocument = {
  format: 'pulse-document';
  version: 2;
  scope: 'library' | 'selection';
  revision: number;
  state: PulseState;
  assets: PulseAsset[];
};

export function emptyPulseState(): PulseState {
  return {
    drafts: [],
    segments: [],
    draftTranscripts: [],
    clipTranscripts: [],
    settings: [],
    uploadDestinations: [],
  };
}

type Cell = 'string' | 'number' | 'string?' | 'number?';
const columns = {
  drafts: {
    id: 'string',
    name: 'string?',
    uploadServer: 'string?',
    uploadArtifactId: 'string?',
    uploadStatus: 'string?',
    contextServer: 'string?',
    contextRef: 'string?',
    mergedSignature: 'string?',
    mergedDurationMs: 'number?',
    captionY: 'number?',
    lastClipNumber: 'number',
    createdAt: 'number',
    lastModified: 'number',
  },
  segments: {
    id: 'string',
    draftId: 'string',
    order: 'number',
    label: 'string?',
    originalFilename: 'string',
    durationMs: 'number',
    editedFilename: 'string?',
    editedDurationMs: 'number?',
    editState: 'string?',
    thumbnail: 'string?',
    captionEdit: 'string?',
  },
  draftTranscripts: {
    draftId: 'string',
    signature: 'string',
    model: 'string?',
    status: 'string',
    lines: 'string?',
    editedLines: 'string?',
    durationMs: 'number?',
    createdAt: 'number',
  },
  clipTranscripts: {
    segmentId: 'string',
    model: 'string',
    file: 'string',
    status: 'string',
    words: 'string?',
    createdAt: 'number',
  },
  settings: { key: 'string', value: 'string?' },
  uploadDestinations: {
    id: 'string',
    server: 'string',
    artifactId: 'string',
    ref: 'string?',
    label: 'string?',
    app: 'string?',
    returnUrl: 'string?',
    createdAt: 'number',
  },
} as const satisfies Record<keyof PulseState, Record<string, Cell>>;

function fail(where: string, message: string): never {
  throw new Error(`Invalid Pulse document at ${where}: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(where, 'expected a mapping');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(where, 'expected a plain mapping');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], where: string) {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!expected.includes(key)) fail(where, `unknown field ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) fail(where, `missing field ${key}`);
  }
}

function cell(value: unknown, kind: Cell, where: string) {
  if (kind.endsWith('?') && value === null) return;
  const type = kind.replace('?', '');
  if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) {
    fail(where, `expected ${kind}`);
  }
}

function unique(values: string[], where: string) {
  if (new Set(values).size !== values.length) fail(where, 'duplicate key');
}

/** Safe physical-relative paths; callers must still resolve beneath their own root. */
export function isSafePulsePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\\\u0000-\u001f\u007f:]/.test(value) &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

export function validatePulseState(value: unknown): asserts value is PulseState {
  const state = record(value, 'state');
  exactKeys(state, Object.keys(columns), 'state');
  for (const [table, fields] of Object.entries(columns)) {
    const rows = state[table];
    if (!Array.isArray(rows)) fail(`state.${table}`, 'expected an array');
    rows.forEach((raw, i) => {
      const where = `state.${table}[${i}]`;
      const row = record(raw, where);
      exactKeys(row, Object.keys(fields), where);
      for (const [key, kind] of Object.entries(fields)) cell(row[key], kind, `${where}.${key}`);
    });
  }
  const s = value as PulseState;
  unique(
    s.drafts.map((r) => r.id),
    'state.drafts',
  );
  unique(
    s.segments.map((r) => r.id),
    'state.segments',
  );
  unique(
    s.draftTranscripts.map((r) => r.draftId),
    'state.draftTranscripts',
  );
  unique(
    s.clipTranscripts.map((r) => JSON.stringify([r.segmentId, r.model])),
    'state.clipTranscripts',
  );
  unique(
    s.settings.map((r) => r.key),
    'state.settings',
  );
  unique(
    s.uploadDestinations.map((r) => r.id),
    'state.uploadDestinations',
  );
  unique(
    s.segments.map((r) => JSON.stringify([r.draftId, r.order])),
    'state.segments.order',
  );
  unique(
    s.uploadDestinations
      .filter((r) => r.ref !== null)
      .map((r) => JSON.stringify([r.server, r.ref])),
    'state.uploadDestinations.ref',
  );
  const drafts = new Set(s.drafts.map((r) => r.id));
  const segments = new Set(s.segments.map((r) => r.id));
  for (const row of s.drafts) {
    if (row.uploadStatus !== null && !['uploading', 'uploaded'].includes(row.uploadStatus)) {
      fail('state.drafts.uploadStatus', 'unknown status');
    }
  }
  for (const row of s.segments) {
    if (!drafts.has(row.draftId)) fail('state.segments.draftId', 'missing draft');
    for (const path of [row.originalFilename, row.editedFilename, row.thumbnail]) {
      if (path !== null && !isSafePulsePath(path)) fail('state.segments', 'unsafe media path');
    }
  }
  for (const row of s.draftTranscripts) {
    if (!drafts.has(row.draftId)) fail('state.draftTranscripts.draftId', 'missing draft');
    if (!['processing', 'done', 'error'].includes(row.status))
      fail('state.draftTranscripts.status', 'unknown status');
  }
  for (const row of s.clipTranscripts) {
    if (!segments.has(row.segmentId)) fail('state.clipTranscripts.segmentId', 'missing segment');
    if (!['done', 'error'].includes(row.status))
      fail('state.clipTranscripts.status', 'unknown status');
  }
}

/** Required source media. Thumbnails/exports are optional caches; transcript paths may be stale. */
export function referencedPulseAssetPaths(state: PulseState): string[] {
  return [
    ...new Set(
      state.segments.flatMap((row) =>
        [row.originalFilename, row.editedFilename].filter((p): p is string => p !== null),
      ),
    ),
  ];
}

/** Reject unsupported/unknown fields rather than accepting and silently discarding them. */
export function validatePulseDocument(value: unknown): asserts value is PulseDocument {
  const doc = record(value, 'root');
  exactKeys(doc, ['format', 'version', 'scope', 'revision', 'state', 'assets'], 'root');
  if (doc.format !== 'pulse-document') fail('format', 'unrecognized format');
  if (doc.version !== 2) fail('version', `unsupported version ${String(doc.version)}`);
  if (doc.scope !== 'library' && doc.scope !== 'selection') fail('scope', 'unknown scope');
  if (!Number.isSafeInteger(doc.revision) || (doc.revision as number) < 0)
    fail('revision', 'expected a nonnegative safe integer');
  validatePulseState(doc.state);
  if (!Array.isArray(doc.assets)) fail('assets', 'expected an array');
  doc.assets.forEach((raw, i) => {
    const where = `assets[${i}]`;
    const asset = record(raw, where);
    exactKeys(asset, ['path', 'archivePath', 'byteLength', 'sha256'], where);
    if (!isSafePulsePath(asset.path)) fail(`${where}.path`, 'unsafe relative path');
    if (!isSafePulsePath(asset.archivePath) || !asset.archivePath.startsWith('assets/')) {
      fail(`${where}.archivePath`, 'expected a safe path under assets/');
    }
    if (!Number.isSafeInteger(asset.byteLength) || (asset.byteLength as number) < 0)
      fail(`${where}.byteLength`, 'expected a nonnegative byte length');
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256))
      fail(`${where}.sha256`, 'expected lowercase SHA-256');
  });
  const assets = doc.assets as PulseAsset[];
  unique(
    assets.map((a) => a.path),
    'assets.path',
  );
  const archived = new Map<string, PulseAsset>();
  for (const asset of assets) {
    const previous = archived.get(asset.archivePath);
    if (
      previous &&
      (previous.sha256 !== asset.sha256 || previous.byteLength !== asset.byteLength)
    ) {
      fail('assets.archivePath', 'one archive entry describes different content');
    }
    archived.set(asset.archivePath, asset);
  }
  const paths = new Set(assets.map((a) => a.path));
  for (const path of referencedPulseAssetPaths(doc.state)) {
    if (!paths.has(path)) fail('assets', `missing referenced media ${path}`);
  }
}

export function parsePulseYaml(source: string): PulseDocument {
  const parsed = parseDocument(source, { strict: true, uniqueKeys: true, version: '1.2' });
  if (parsed.errors.length || parsed.warnings.length) {
    throw new Error(
      `Invalid Pulse YAML: ${[...parsed.errors, ...parsed.warnings].map((e) => e.message).join('; ')}`,
    );
  }
  const value: unknown = parsed.toJS({ maxAliasCount: 0 });
  validatePulseDocument(value);
  return value;
}

export function stringifyPulseYaml(document: PulseDocument): string {
  validatePulseDocument(document);
  return stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 });
}

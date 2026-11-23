import { File } from 'expo-file-system';
import { addDatabaseChangeListener } from 'expo-sqlite';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { readCatalogRows } from '@/db/catalog-queries';
import { expoDb, library } from '@/db/client';
import { libraryNewerSchema } from '@/db/host-context';
import { installationId } from '@/db/local-settings';
import { schemaVersion } from '@/db/project';
import { selectedModelQuery } from '@/db/settings';
import { exportAudio } from '@/features/export/editor-merge';
import { getRecorderFormat } from '@/features/recorder/recorder-format';
import { resolveSelectedModel } from '@/features/transcription/models';
import { exportRelPath } from '@/utils/media-paths';
import { customDocumentsPath, documentDir } from '@/utils/storage-root';

import { projectCatalog, type CatalogFile } from './catalog';
import { CATALOG_FILE, CATALOG_PART, parseCatalog } from './catalog-filter';

// Writes the embed's catalog.json (native-bridge.md §6.1) under the namespace's documents root, so
// PulseKit can answer listDrafts, getDraft and countDrafts without starting Pulse. Only the embedded
// runtime starts it (useCatalogWriter): the Pulse app writes no catalog.
//
// It is rewritten at boot and after every change to the tables it is projected from: once per burst
// of changes (one JS task), after any write already running. No timer: on Android, React Native
// pauses timers while no Pulse screen is resumed, so a catalog waiting on one kept a sent draft
// "queued" after its upload finished. Each write goes to `catalog.json.part` and is then moved over
// `catalog.json`, so a write killed midway leaves the previous catalog. expo-file-system has no
// rename-over call: its move with `overwrite` deletes `catalog.json` and then moves the `.part` in
// (results.ts says more). In that gap, and after a kill inside it, the finished `.part` is the only
// catalog, so the reader reads it whenever `catalog.json` is missing (readCatalogFile), and the next
// write puts such a `.part` back in place before it starts its own.

/**
 * The tables the catalog is projected from (pulse-schema.md §5's four, plus what decides
 * `hasCaptions` and `ready`: clip transcripts, and the settings holding the captions model and the
 * recorder's audio layout). A change to any other table doesn't move it.
 */
const WATCHED = new Set([
  'drafts',
  'segments',
  'upload_jobs',
  'upload_receipts',
  'clip_transcripts',
  'settings',
]);

type Writer = {
  namespace: string;
  online: () => boolean;
  unsubscribe: () => void;
};

let writer: Writer | null = null;
let scheduled = false;
/** Writes run one after another; `queued` keeps it to one waiting behind the running one. */
let chain: Promise<void> = Promise.resolve();
let queued = false;

/** The documents root as a plain path: the embed's, or null in the Pulse app. */
const rootPath = () => customDocumentsPath();

/** The catalog as the library has it now. */
export async function buildCatalog(opts: {
  namespace: string;
  online: boolean;
  now: number;
}): Promise<CatalogFile> {
  const root = rootPath();
  if (root == null) throw new Error('The catalog is written only inside a host app.');
  const audio = exportAudio(await getRecorderFormat());
  const [selected] = await selectedModelQuery;
  const captionModel = resolveSelectedModel(selected?.value ?? null, Platform.OS)?.id ?? null;
  const install = installationId();
  const rows = readCatalogRows(opts.now, captionModel);
  const exportBytes = new Map<string, number>();
  for (const d of rows.drafts) {
    if (d.mergedSignature == null) continue; // no export on record: not current, whatever is on disk
    const file = new File(documentDir(), ...exportRelPath(d.id).split('/'));
    if (file.exists) exportBytes.set(d.id, file.size);
  }
  const projected = projectCatalog(
    { rows, installationId: install, audio, root, exportBytes, captionModel },
    opts.now,
  );
  return {
    format: 'pulse-catalog',
    version: 1,
    namespace: opts.namespace,
    writtenAt: opts.now,
    dbSchema: schemaVersion(expoDb),
    readOnly: libraryNewerSchema(),
    online: opts.online,
    drafts: projected.drafts,
    receipts: projected.receipts,
  };
}

/** Write `text` as the namespace's catalog.json: `.part` first, then moved over it. */
export function writeCatalogText(text: string): void {
  if (rootPath() == null) throw new Error('The catalog is written only inside a host app.');
  const dest = new File(documentDir(), CATALOG_FILE);
  const part = new File(documentDir(), CATALOG_PART);
  if (part.exists) {
    // With no catalog.json beside it, a whole `.part` is the catalog a kill (or a failed move) caught
    // between deleting catalog.json and moving it in: finish that move first, so readers have a
    // catalog.json while this write runs. Any other `.part` is a write killed midway.
    if (!dest.exists && parseCatalog(part.textSync()) != null) part.moveSync(dest);
    else part.delete();
  }
  const next = new File(documentDir(), CATALOG_PART);
  try {
    next.write(text);
    next.moveSync(dest, { overwrite: true });
  } catch (e) {
    // When the move deleted catalog.json and then failed, the `.part` is the only catalog: keep it.
    if (dest.exists) discard(next);
    throw e;
  }
}

function discard(part: File): void {
  try {
    if (part.exists) part.delete();
  } catch {
    // The next write clears it.
  }
}

async function writeNow(): Promise<void> {
  const w = writer;
  if (!w) return;
  const catalog = await buildCatalog({
    namespace: w.namespace,
    online: w.online(),
    now: Date.now(),
  });
  writeCatalogText(JSON.stringify(catalog));
}

/** Write the catalog after whatever write is running; a second ask while one waits joins it. */
function flush(): Promise<void> {
  if (queued) return chain;
  queued = true;
  chain = chain
    .then(() => {
      queued = false;
      return writeNow();
    })
    .catch((e: unknown) => console.warn('[catalog] could not write the catalog', e));
  return chain;
}

/**
 * Rewrite the catalog once the current burst of changes is done (a microtask, so a merge's rows make
 * one catalog), after any write already running; changes during a write make one more.
 */
export function scheduleCatalogWrite(): void {
  if (!writer || scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (writer) void flush();
  });
}

/**
 * Start keeping catalog.json in step with the library, and write it now (the boot write). Once per
 * runtime: a later start (the next presentation) only writes it again, which also leaves out
 * receipts that expired meanwhile. Does nothing in the Pulse app, or when the library couldn't be opened.
 * `online` is what the catalog reports for the network (until the job loop knows: online).
 */
export function startCatalogWriter(opts: {
  namespace: string;
  online?: () => boolean;
}): Promise<void> {
  if (rootPath() == null || library.failed) return Promise.resolve();
  if (!writer) {
    const subscription = addDatabaseChangeListener((event) => {
      if (WATCHED.has(event.tableName)) scheduleCatalogWrite();
    });
    writer = {
      namespace: opts.namespace,
      online: opts.online ?? (() => true),
      unsubscribe: () => subscription.remove(),
    };
  }
  return flush();
}

/** Stop writing the catalog (the library is being released); a write already running finishes. */
export function stopCatalogWriter(): Promise<void> {
  writer?.unsubscribe();
  writer = null;
  scheduled = false;
  return chain;
}

/**
 * The embedded runtime's catalog: started once the library gate has passed (mount it under
 * PulseCore), for the namespace the facade booted Pulse on.
 */
export function useCatalogWriter(namespace: string | undefined): void {
  useEffect(() => {
    if (namespace) void startCatalogWriter({ namespace });
  }, [namespace]);
}

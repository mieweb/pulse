import { Directory, File, Paths } from 'expo-file-system';

import { pulseAssetSha256 } from './archive';
import type { PulseDocument, PulseState } from './document';
import { NativePulseStorage } from './file-storage';
import { hydratePulseIndex } from './recovery';
import { PulseRepository } from './repository';
import { installCanonicalCommitGuard } from './sqlite-guard';
import { preservePulseCollectionOrder } from './state-order';
import {
  readPulseState,
  replacePulseDocument,
  writePulseDocumentHeader,
  type PulseSqliteDatabase,
} from './sqlite-state';

type Guard = ReturnType<typeof installCanonicalCommitGuard>;
type PersistenceStatus = { ready: boolean; error: unknown | null };

let storage: NativePulseStorage;
let repository: PulseRepository;
let database: PulseSqliteDatabase;
let guard: Guard;
let prepared = false;
let initialized = false;
let status: PersistenceStatus = { ready: false, error: null };
const listeners = new Set<() => void>();

function changed(next: PersistenceStatus) {
  status = next;
  for (const listener of listeners) listener();
}

export const getPulsePersistenceStatus = () => status;
export function subscribePulsePersistence(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function recordPulsePersistenceFailure(error: unknown): void {
  changed({ ready: false, error });
}

/** Validate canonical files before opening/resetting a disposable SQLite projection. */
export function preparePulsePersistence(): boolean {
  if (prepared) return repository !== undefined && repository.getDocument() !== null;
  prepared = true;
  try {
    storage = new NativePulseStorage(new Directory(Paths.document, 'library.pulse'));
    repository = new PulseRepository(storage);
    return repository.load() !== null;
  } catch (error) {
    recordPulsePersistenceFailure(error);
    return false;
  }
}

export function attachPulseProjection(drizzleDatabase: object, sqlite: PulseSqliteDatabase): void {
  database = sqlite;
  guard = installCanonicalCommitGuard(drizzleDatabase, {
    isReady: () => status.ready,
    beforeCommit: () => {
      const state = readPulseState(database);
      const previous = repository.getDocument();
      const ordered = previous ? preservePulseCollectionOrder(state, previous.state) : state;
      repository.commit(ordered, (document) => {
        writePulseDocumentHeader(database, document);
      });
    },
    onProjectionFailure: recordPulsePersistenceFailure,
  });
  // Schema migrations/hydration run before application providers mount.
  guard.setEnabled(false);
}

export function initializePulsePersistence(): void {
  if (status.error) throw status.error;
  if (initialized) return;
  hydratePulseIndex(repository, database);
  initialized = true;
  changed({ ready: true, error: null });
  guard.setEnabled(true);
}

export function getPulseDocument(): PulseDocument {
  if (!status.ready) throw status.error ?? new Error('Pulse storage is not ready.');
  const document = repository.getDocument();
  if (!document) throw new Error('No canonical Pulse revision is available.');
  return document;
}

export function getPulsePublicationGeneration(): number {
  getPulseDocument();
  return repository.getPublicationGeneration();
}

export function readCanonicalPulseAsset(path: string): Uint8Array {
  const asset = getPulseDocument().assets.find((candidate) => candidate.path === path);
  if (!asset) throw new Error(`Pulse asset is not in the saved document: ${path}`);
  const bytes = new File(storage.directory, ...asset.archivePath.split('/')).bytesSync();
  if (bytes.byteLength !== asset.byteLength || pulseAssetSha256(bytes) !== asset.sha256) {
    throw new Error(`Canonical Pulse asset is damaged: ${path}`);
  }
  return bytes;
}

/** Full-document import/restore commits files first, then replaces only their SQL projection. */
export function commitPulseState(state: PulseState, expectedGeneration?: number): PulseDocument {
  getPulseDocument(); // Readiness/failure gate.
  const document = repository.commit(state, undefined, expectedGeneration);
  updateProjection(document);
  return document;
}

function updateProjection(document: PulseDocument, materialize = false): void {
  guard.setEnabled(false);
  try {
    if (materialize) repository.materialize();
    replacePulseDocument(database, document);
    guard.clearPoison();
  } catch (error) {
    // The document is already durably published. Do not throw an "unsaved" error that causes
    // an importer's cleanup handler to delete media; enter recovery and rebuild next launch.
    recordPulsePersistenceFailure(error);
  } finally {
    guard.setEnabled(true);
  }
}

export function restorePulseDocument(
  document: PulseDocument,
  expectedGeneration?: number,
  incoming?: ReadonlyMap<string, Uint8Array>,
): PulseDocument {
  getPulseDocument();
  const restored = repository.restore(document, expectedGeneration, incoming);
  updateProjection(restored, true);
  return restored;
}

import { Directory, Paths } from 'expo-file-system';

/**
 * Where Pulse keeps its files. The app uses its own Documents and Caches folders. Embedded in
 * another app (embed/), Pulse runs in that app's sandbox, so the embedding passes folders of its
 * own here and everything Pulse writes (the library database, drafts, models, logs, caches) stays
 * inside them.
 *
 * Every file Pulse writes goes through these functions (and `@/db/database-dir` for the library
 * database); nothing reads `Paths.document`, `Paths.cache` or `defaultDatabaseDirectory` directly.
 */
type Roots = { documents: string; caches: string };

let roots: Roots | null = null;
let read = false;

const plain = (path: string) => path.replace(/^file:\/\//, '').replace(/\/+$/, '');

/**
 * Use `documents` and `caches` (absolute paths or `file://` URIs) instead of the app's own
 * folders. Call it once, before anything opens the library (`@/db/client` opens it on import).
 * The same roots again are a no-op; different roots, or roots set after a read, throw: the open
 * library and its files can't move.
 */
export function setStorageRoots(next: Roots): void {
  const wanted = { documents: plain(next.documents), caches: plain(next.caches) };
  if (!wanted.documents.startsWith('/') || !wanted.caches.startsWith('/')) {
    throw new Error('Storage roots must be absolute paths.');
  }
  // expo-sqlite reads its folder as a URL: a space, %, # or ? in it would put the database
  // somewhere other than the rest of the library.
  if (/[\s%#?]/.test(wanted.documents + wanted.caches)) {
    throw new Error('Storage roots can’t contain spaces, %, # or ?.');
  }
  if (roots) {
    if (roots.documents === wanted.documents && roots.caches === wanted.caches) return;
    throw new Error('Pulse already opened its library in another folder.');
  }
  if (read) throw new Error('Set the storage roots before Pulse opens its library.');
  for (const path of [wanted.documents, wanted.caches]) {
    new Directory(`file://${path}`).create({ intermediates: true, idempotent: true });
  }
  roots = wanted;
}

/** The documents folder: the library's drafts, models and logs. */
export function documentDir(): Directory {
  read = true;
  return roots ? new Directory(`file://${roots.documents}`) : Paths.document;
}

/** The caches folder: files Pulse can rebuild (waveforms, filmstrips, exports, upload chunks). */
export function cacheDir(): Directory {
  read = true;
  return roots ? new Directory(`file://${roots.caches}`) : Paths.cache;
}

/** The embedding's documents folder as a plain path, or null in the Pulse app itself. */
export function customDocumentsPath(): string | null {
  read = true;
  return roots?.documents ?? null;
}

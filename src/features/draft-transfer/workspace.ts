import { Directory } from 'expo-file-system';
import { cacheDir } from '@/utils/storage-root';

/** Where `.pulse` files are built before the share sheet takes them. */
const ROOT = 'pulse-exports';
/** Long after any share sheet has read its file: older workspaces are cleared. */
const STALE_MS = 6 * 60 * 60 * 1000;

/** The time a workspace or older export file was made: the number after the last `-`. */
const madeAt = (name: string) => Number(name.slice(name.lastIndexOf('-') + 1).split('.')[0]);

/**
 * A folder of its own for one export (`<kind>-<now>`), so a draft export and a library backup
 * running at once never clear each other's files. Workspaces older than a few hours (and files
 * from before workspaces) are removed here, so the cache doesn't grow.
 */
export function exportWorkspace(kind: string, now: number): Directory {
  const root = new Directory(cacheDir(), ROOT);
  root.create({ intermediates: true, idempotent: true });
  for (const entry of root.list()) {
    const at = madeAt(entry.name);
    if (!Number.isFinite(at) || now - at > STALE_MS) {
      try {
        entry.delete();
      } catch {}
    }
  }
  const dir = new Directory(root, `${kind}-${now}`);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

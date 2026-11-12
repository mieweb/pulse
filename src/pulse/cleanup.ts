import { Directory, File, Paths } from 'expo-file-system';

import type { PulseDocument } from './document';

const RNVT_FILE_PREFIX = 'trimmedVideo';

/** Remove obsolete native-editor outputs, preserving every canonical asset, including extras. */
export function sweepRnvtOutputs(document: PulseDocument): number {
  const protectedUris = new Set(
    document.assets.map((asset) => new File(Paths.document, ...asset.path.split('/')).uri),
  );
  let removed = 0;
  for (const directory of [Paths.document, Paths.cache]) {
    try {
      for (const entry of new Directory(directory).list()) {
        if (
          entry instanceof File &&
          entry.name.startsWith(RNVT_FILE_PREFIX) &&
          !protectedUris.has(entry.uri)
        ) {
          try {
            entry.delete();
            removed++;
          } catch {
            // Best-effort removal of unreferenced derived outputs only.
          }
        }
      }
    } catch {
      // Missing/unreadable cache directories do not change canonical state.
    }
  }
  return removed;
}

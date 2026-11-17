import { Directory, File } from 'expo-file-system';
import { zip } from 'react-native-zip-archive';

import { ensureFreeSpace, nativeMd5 } from '@/utils/disk-space';

/** A file:// URI as the plain path native code (expo-sqlite's `directory`, zip) takes. */
export const plainPath = (uri: string) =>
  decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/$/, '');

/** Let a frame through between native calls that each take a moment (hashing a clip). */
export const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A file to archive: its library path (`drafts/…`, or the database's name) and where it is now. */
export type ArchiveSource = { path: string; file: File };

/** An archived file: its library path, its entry name in the archive, size and native MD5. */
export type ArchivedFile = { path: string; entry: string; size: number; md5: string };

/**
 * Zip `sources` and `extra` (files already in `stage`, such as a manifest written after this
 * returns its list) into `out`, natively and without compression (media is already compressed).
 *
 * Native zip names every entry after its file and keeps no folders, so the archive is flat: each
 * source goes in under its base name, and a later one whose name is taken (or `reserved`) goes in
 * as a copy in `stage` under `<index>-<name>`. Room for the archive and those copies is checked
 * before anything is written. `writeExtra` runs after every file is hashed, with the list, to
 * write the files named in `extra` into `stage`.
 */
export async function zipFlat(
  sources: ArchiveSource[],
  stage: Directory,
  out: File,
  extra: { names: string[]; write: (files: ArchivedFile[]) => void },
): Promise<ArchivedFile[]> {
  const taken = new Set(extra.names);
  const copies = new Set<number>();
  const entries = sources.map(({ path }, i) => {
    let entry = path.slice(path.lastIndexOf('/') + 1);
    if (taken.has(entry)) {
      while (taken.has(entry)) entry = `${i}-${entry}`;
      copies.add(i);
    }
    taken.add(entry);
    return entry;
  });
  const size = (i: number) => sources[i].file.size ?? 0;
  ensureFreeSpace(
    sources.reduce((sum, _, i) => sum + size(i), 0) +
      [...copies].reduce((sum, i) => sum + size(i), 0),
  );
  const files = sources.map((s) => s.file);
  for (const i of copies) {
    files[i].copySync(new File(stage, entries[i]));
    files[i] = new File(stage, entries[i]);
  }
  const archived: ArchivedFile[] = [];
  for (const [i, file] of files.entries()) {
    archived.push({
      path: sources[i].path,
      entry: entries[i],
      size: file.size ?? 0,
      md5: nativeMd5(file),
    });
    await yieldToUi();
  }
  extra.write(archived);
  await zip(
    [...files, ...extra.names.map((n) => new File(stage, n))].map((f) => plainPath(f.uri)),
    plainPath(out.uri),
    { compressionLevel: 0 },
  );
  return archived;
}

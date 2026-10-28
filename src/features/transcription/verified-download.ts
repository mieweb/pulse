import { File } from 'expo-file-system';

// Model files are downloaded whole or not at all. The download goes to `<name>.part` (on Android
// expo-file-system writes into its destination as bytes arrive, so a file at the real path could
// be half a model, or what a dropped connection left), is checked against the size the server
// sent, and only then moved into place, with `<name>.ok` recording the size that was verified.

const partOf = (file: File) => new File(file.parentDirectory, `${file.name}.part`);
const markerOf = (file: File) => new File(file.parentDirectory, `${file.name}.ok`);

// Each marker's size as read (null: no marker), by file URI: readiness is asked on every render.
const markers = new Map<string, number | null>();

function markedSize(file: File): number | null {
  const known = markers.get(file.uri);
  if (known !== undefined) return known;
  const marker = markerOf(file);
  let size: number | null = null;
  if (marker.exists) {
    try {
      size = Number(marker.textSync());
    } catch {
      size = NaN; // unreadable: not a size anything matches
    }
  }
  markers.set(file.uri, size);
  return size;
}

/**
 * Whether `file` is a whole download: the size this app verified when it downloaded it, or, for
 * a file a build before verified downloads left (no marker), exactly `knownBytes`.
 */
export function isWholeFile(file: File, knownBytes: number): boolean {
  if (!file.exists) return false;
  const size = file.size ?? 0;
  const marked = markedSize(file);
  return marked !== null ? size > 0 && marked === size : size === knownBytes;
}

/** Remove `file` with its marker and any partial download of it. */
export function deleteDownload(file: File): void {
  markers.delete(file.uri);
  for (const f of [file, markerOf(file), partOf(file)]) if (f.exists) f.delete();
}

/**
 * Download `url` to `file`, whole or not at all (see above). Size check: the server's own total
 * when it sent one, else `knownBytes`. Rejects (leaving nothing at `file`) on a failed, cancelled
 * or short download.
 */
export function downloadWhole(
  url: string,
  file: File,
  knownBytes: number,
  onProgress?: (p: { bytesWritten: number; totalBytes: number }) => void,
): { task: { cancel: () => void }; promise: Promise<string> } {
  deleteDownload(file);
  const part = partOf(file);
  let totalBytes = 0;
  const task = File.createDownloadTask(url, part, {
    onProgress: (p) => {
      if (p.totalBytes > 0) totalBytes = p.totalBytes;
      onProgress?.(p);
    },
  });
  const promise = (async () => {
    try {
      await task.downloadAsync();
      const size = part.exists ? (part.size ?? 0) : 0;
      if (size <= 0 || size !== (totalBytes > 0 ? totalBytes : knownBytes)) {
        throw new Error(`Download incomplete (${size} of ${totalBytes || knownBytes} bytes)`);
      }
      await part.move(file);
      const marker = markerOf(file);
      marker.create({ overwrite: true });
      marker.write(String(size));
      markers.set(file.uri, size);
      return file.uri;
    } catch (e) {
      deleteDownload(file);
      throw e;
    }
  })();
  return { task, promise };
}

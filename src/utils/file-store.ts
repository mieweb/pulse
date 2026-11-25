import { Directory, File } from 'expo-file-system';

import { editedSegmentRelPath, exportRelPath, segmentRelPath } from './media-paths';
import { documentDir } from '@/utils/storage-root';
import { heldMediaPaths, isMediaHeld } from '@/core/media-holds';

export {
  editCoverRelPath,
  editedSegmentRelPath,
  editedThumbRelPath,
  exportRelPath,
  segmentRelPath,
  thumbRelPath,
} from './media-paths';

// Clips live under the document directory (safe from system eviction). The DB stores
// relative paths only; we absolutize at runtime so the sandbox container can change
// between launches without invalidating references (§2.2).
//   drafts/{draftId}/segments/{segmentId}.mp4               — pristine original
//   drafts/{draftId}/segments/{segmentId}.edited.{rev}.mp4  — re-encoded editor output

/**
 * Normalize a bare filesystem path to a `file://` URI. `merge()` / `thumbnail()` / the camera hand
 * back bare paths, but expo's `File`, expo-video, whisper, sharing, etc. all want a URI. A value
 * that already has a scheme is returned unchanged.
 */
export const toFileUri = (path: string): string => (path.startsWith('/') ? `file://${path}` : path);

/** Delete a file if it's there; never throws (a clean-up must not fail its caller). */
export function deleteQuietly(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {}
}

export function absolutize(relPath: string): string {
  return new File(documentDir(), ...relPath.split('/')).uri;
}

/** The draft's segments dir, creating it (and any missing parents) if needed. */
function segmentsDir(draftId: string): Directory {
  const dir = new Directory(documentDir(), 'drafts', draftId, 'segments');
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** The on-disk pristine segment file for a draft, creating the segments dir if needed. */
function segmentDest(draftId: string, segmentId: string): File {
  return new File(segmentsDir(draftId), `${segmentId}.mp4`);
}

/** The on-disk edited segment file for a draft, creating the segments dir if needed. */
function editedSegmentDest(draftId: string, segmentId: string, rev: number): File {
  return new File(segmentsDir(draftId), `${segmentId}.edited.${rev}.mp4`);
}

/** Move a recorded clip out of the cache into the draft's segments dir; returns its relative path. */
export async function persistRecording(
  cacheUri: string,
  draftId: string,
  segmentId: string,
): Promise<string> {
  await new File(cacheUri).move(segmentDest(draftId, segmentId));
  return segmentRelPath(draftId, segmentId);
}

/**
 * Copy an external file (e.g. a bundled `expo-asset` clip) into the draft's segments dir,
 * leaving the source untouched; returns its relative path. Used by the dev seed (§1.0b).
 */
export async function copyIntoSegments(
  srcUri: string,
  draftId: string,
  segmentId: string,
): Promise<string> {
  const dest = segmentDest(draftId, segmentId);
  if (dest.exists) dest.delete();
  await new File(srcUri).copy(dest);
  return segmentRelPath(draftId, segmentId);
}

/**
 * Where older installs' segment uploads wrote a clip's conformed copy (final extension — any
 * case, `.mov`/`.m4v` legacy included — replaced with `.upload.mp4`). Nothing writes these any
 * more; kept only so `deleteSegmentFile` still sweeps copies left on upgraded devices.
 */
function uploadCopyRelPath(relPath: string): string {
  return relPath.replace(/\.[^./]+$/, '') + '.upload.mp4';
}

/** The explicitly removed file and its legacy conformed upload copy, when it has one. */
export function segmentFileDeletionPaths(relPath: string): readonly string[] {
  return relPath.endsWith('.upload.mp4') ? [relPath] : [relPath, uploadCopyRelPath(relPath)];
}

/** Remove only unprotected candidates; a legacy sibling can be another clip's actual source. */
export function deleteSegmentFile(
  relPath: string,
  protectedPaths: ReadonlySet<string> = new Set(),
): void {
  for (const path of segmentFileDeletionPaths(relPath)) {
    if (protectedPaths.has(path) || isMediaHeld(path)) continue;
    const file = new File(absolutize(path));
    if (file.exists) file.delete();
  }
}

/** Whether the draft's persisted export file is on disk. */
export function exportFileExists(draftId: string): boolean {
  return new File(absolutize(exportRelPath(draftId))).exists;
}

/**
 * Move a finished merge output (in the merge's cache folder) into place as the draft's
 * persisted export, replacing any previous one; returns its absolute URI. The merge itself wrote elsewhere, so
 * the only window where `export.mp4` is missing is between the delete and the move.
 */
export async function persistExportFile(draftId: string, mergeOutputPath: string): Promise<string> {
  const dest = new File(absolutize(exportRelPath(draftId)));
  if (dest.exists) dest.delete();
  await new File(toFileUri(mergeOutputPath)).move(dest);
  return dest.uri;
}

/**
 * Delete unprotected files in the draft's folder (`drafts/{draftId}`), returning whether the
 * folder is completely gone. Callers supply live/durable references; active media holds always
 * apply. Refuses an id that isn't one
 * plain path segment: `..`, `.`, an empty id or one with a separator would name a folder above or
 * beside the draft's (`drafts/..` is the whole documents folder), and so would a percent-encoded
 * one (`%2e%2e`) wherever the path is decoded as a file URI.
 */
export function deleteDraftDir(
  draftId: string,
  protectedPaths: ReadonlySet<string> = new Set(),
): boolean {
  if (!isPathSegment(draftId))
    throw new Error(`Refusing to delete the folder of draft "${draftId}"`);
  const dir = new Directory(documentDir(), 'drafts', draftId);
  if (!dir.exists) return true;
  const prefix = `drafts/${draftId}/`;
  const kept = new Set(
    [...protectedPaths, ...heldMediaPaths()].filter((path) => path.startsWith(prefix)),
  );
  if (kept.size === 0) {
    dir.delete();
    return true;
  }
  const remove = (folder: Directory, rel: string): void => {
    for (const child of folder.list()) {
      const path = `${rel}/${child.name}`;
      if (child instanceof Directory) remove(child, path);
      else if (!kept.has(path)) child.delete();
    }
    if (folder.list().length === 0) folder.delete();
  };
  remove(dir, `drafts/${draftId}`);
  return !dir.exists;
}

/** One file or folder name: not empty, not `.` or `..`, and no `/`, backslash, NUL or `%`. */
function isPathSegment(name: string): boolean {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\\0%]/.test(name)
  );
}

// Draft transfer (.pulse export/import) ----------------------------------------------------

/** Read a relative clip path's raw bytes, or null if the file is missing on disk. */
export async function readRelBytes(relPath: string): Promise<Uint8Array | null> {
  const file = new File(absolutize(relPath));
  if (!file.exists) return null;
  return file.bytes();
}

/** Whether a relative stored path names a file on disk. */
export function relFileExists(relPath: string): boolean {
  return new File(absolutize(relPath)).exists;
}

/**
 * Copy a stored file to another relative path, creating its folder; false when the source is
 * missing.
 */
export async function copyRelFile(fromRel: string, toRel: string): Promise<boolean> {
  const src = new File(absolutize(fromRel));
  if (!src.exists) return false;
  const dest = new File(absolutize(toRel));
  dest.parentDirectory.create({ intermediates: true, idempotent: true });
  if (dest.exists) dest.delete();
  await src.copy(dest);
  return true;
}

/** Write an imported clip's bytes as the draft's pristine original; returns its relative path. */
export function writeOriginalBytes(draftId: string, segmentId: string, bytes: Uint8Array): string {
  segmentDest(draftId, segmentId).write(bytes);
  return segmentRelPath(draftId, segmentId);
}

/** Write an imported clip's edited (re-encoded) bytes alongside its original; returns its rel path. */
export function writeEditedBytes(draftId: string, segmentId: string, bytes: Uint8Array): string {
  const rev = Date.now();
  editedSegmentDest(draftId, segmentId, rev).write(bytes);
  return editedSegmentRelPath(draftId, segmentId, rev);
}

import type { EntryName, Failed, FileRef, FlowResult, PulseErrorInfo } from '@mieweb/pulse-embed';
import { Directory, File } from 'expo-file-system';

import { toFileUri } from '@/utils/file-store';
import { documentDir } from '@/utils/storage-root';

/**
 * The durable inbox (native-bridge.md §6.2, AD15): `results/<requestId>.json` holds the flow's
 * FlowResult, written before Pulse tells the facade (`pulse.result`), so a lost message or a
 * killed process can't lose a take: the facade and `pendingResults` read the file either way. In
 * 'file' mode the export and the draft's project document sit next to it as
 * `<requestId>.mp4` and `<requestId>.project.json`. The facade's `acknowledge` deletes all three.
 *
 * Every write goes to `<name>.part` first, then moves to `<name>`, so a reader never sees half a
 * file. The move is atomic only when no `<name>` exists yet, which is every write but one: the
 * facade's own fallback result for a forced close can be there before JS writes. expo-file-system
 * (57) has no rename-over call: its move with `overwrite` deletes `<name>` and then moves, on iOS
 * (FileSystemPath.move) and Android (CopyMoveStrategy.LocalFile) alike. A crash between the two
 * leaves only `<name>.part`.
 */
export const RESULTS_DIR = 'results';

function resultsDir(): Directory {
  const dir = new Directory(documentDir(), RESULTS_DIR);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** A file URI as the plain absolute path native code and FileRef use. */
const plainPath = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));

/** A fresh `results/<name>.part`, the place a write goes before it is moved over `<name>`. */
function partFor(name: string): File {
  const part = new File(resultsDir(), `${name}.part`);
  if (part.exists) part.delete(); // left by a crash mid-write
  return part;
}

/** Move a finished `.part` over `results/<name>`. */
function commit(part: File, name: string): File {
  const dest = new File(resultsDir(), name);
  // Over an existing file this deletes it first, then moves (see above): not atomic then.
  part.moveSync(dest, { overwrite: true });
  return dest;
}

function discard(part: File): void {
  try {
    if (part.exists) part.delete();
  } catch {
    // The next write of this name clears it.
  }
}

/** Write `text` to `results/<name>` atomically. */
export function writeResultFile(name: string, text: string): File {
  const part = partFor(name);
  try {
    part.write(text);
    return commit(part, name);
  } catch (e) {
    discard(part);
    throw e;
  }
}

function fileRef(file: File): FileRef {
  return {
    rel: `${RESULTS_DIR}/${file.name}`,
    path: plainPath(file.uri),
    webUrl: '',
    bytes: file.size,
  };
}

/** Write the flow's result as `results/<requestId>.json`; call before `pulse.result`. */
export function writeFlowResult(result: FlowResult): FileRef {
  return fileRef(writeResultFile(`${result.requestId}.json`, JSON.stringify(result)));
}

/**
 * "Use this video" in 'file' mode: a copy of the export the host owns until it acknowledges the
 * request, and the draft's lossless project document beside it (v2, media paths relative to the
 * documents root). `project` builds that document; it is called after the copy.
 */
export async function saveExportForHost(opts: {
  requestId: string;
  /** The merged export, an absolute path or a file URI. */
  exportPath: string;
  project: () => unknown;
}): Promise<{ export: FileRef; project: FileRef }> {
  const { requestId } = opts;
  const name = `${requestId}.mp4`;
  const part = partFor(name);
  let video: File;
  try {
    await new File(toFileUri(opts.exportPath)).copy(part);
    video = commit(part, name);
  } catch (e) {
    discard(part);
    throw e;
  }
  const project = writeResultFile(`${requestId}.project.json`, JSON.stringify(opts.project()));
  return { export: fileRef(video), project: fileRef(project) };
}

/**
 * The result of a request that was refused (`invalid_options`, `unsupported`): it never became a
 * flow, so it ran for no context. A flow that ends before its first screen (its draft missing,
 * its library unusable) ends through the flow store, which carries the request's context.
 */
export function startupFailure(opts: {
  requestId: string;
  entry: EntryName;
  error: PulseErrorInfo;
  endedAt: number;
}): Failed {
  return {
    requestId: opts.requestId,
    entry: opts.entry,
    endedOn: null,
    stage: 'none',
    context: null,
    endedAt: Math.round(opts.endedAt),
    status: 'failed',
    error: Object.fromEntries(
      Object.entries(opts.error).filter(([, v]) => v !== undefined),
    ) as PulseErrorInfo,
  };
}

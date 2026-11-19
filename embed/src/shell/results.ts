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
 * Every write is atomic: `<name>.part` first, then a move over `<name>`, so a crash leaves the old
 * file or the new one, never half of one.
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
  // One native call replaces it: deleting first would lose the old file if the move then failed.
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
 * The result of a request that never showed a screen: refused (`invalid_options`, `unsupported`),
 * its draft missing (`not_found`), or its library unusable before the flow could start.
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

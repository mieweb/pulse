import { Directory, File } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import { expoDb } from '@/db/client';
import { buildProject } from '@/db/project';
import { toFileUri } from '@/utils/file-store';
import { documentDir } from '@/utils/storage-root';

/**
 * Embedded Pulse's link to the app it runs in (embed/). One request at a time: the host opens
 * Pulse for a request, and Pulse ends it with exactly one result — completed, canceled or failed.
 * In the Pulse app itself no session is ever started and nothing here shows.
 *
 * A result is written to `results/<requestId>.json` before the host is told, so a lost message
 * or a killed process can't lose a take: the host reads the file either way.
 */
export type EmbedEntry = 'full' | 'record';

export type EmbedOutput = {
  /** The exported video, a copy the host owns until it acknowledges the request. */
  mp4Path: string;
  durationMs: number;
  draftId: string;
  /** The draft's lossless project document (v2), media paths relative to `mediaDir`. */
  project: { formatVersion: number; path: string };
  mediaDir: string;
};

export type EmbedResult =
  | { status: 'completed'; requestId: string; output: EmbedOutput }
  | { status: 'canceled'; requestId: string; reason: 'user' }
  | { status: 'failed'; requestId: string; error: { code: string; message: string } };

type Session = { requestId: string; entry: EmbedEntry; notify: (requestId: string) => void };

let session: Session | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Start the host's request; `notify` tells the host its result file is ready. */
export function beginEmbedSession(next: Session): void {
  console.log(`[embed] session ${next.requestId} (${next.entry})`);
  session = next;
  changed();
}

/** The open request, or null (always null in the Pulse app). */
export const embedSession = (): Session | null => session;

/** Whether Pulse is running inside another app with a request open. */
export function useEmbedded(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => session != null,
  );
}

const plainPath = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));

function resultsDir(): Directory {
  const dir = new Directory(documentDir(), 'results');
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Write `name` in the results folder atomically: a crash leaves the old file or the new one. */
function writeResultFile(name: string, text: string): File {
  const dir = resultsDir();
  const part = new File(dir, `${name}.part`);
  if (part.exists) part.delete();
  part.write(text);
  const dest = new File(dir, name);
  if (dest.exists) dest.delete();
  part.moveSync(dest);
  return dest;
}

function deliver(result: EmbedResult): void {
  const s = session;
  if (!s || s.requestId !== result.requestId) return;
  writeResultFile(`${s.requestId}.json`, JSON.stringify(result));
  console.log(`[embed] result ${result.status} for ${s.requestId}`);
  session = null;
  changed();
  s.notify(s.requestId);
}

/** End the request with the draft's exported video and its project document. */
export async function finishWithVideo(draftId: string, outputPath: string, durationMs: number) {
  const s = session;
  if (!s) return;
  try {
    const dir = resultsDir();
    const video = new File(dir, `${s.requestId}.mp4`);
    if (video.exists) video.delete();
    await new File(toFileUri(outputPath)).copy(video);
    const doc = buildProject(expoDb, {
      draftIds: [draftId],
      now: Date.now(),
      byteLength: (rel) => {
        const f = new File(documentDir(), ...rel.split('/'));
        return f.exists ? f.size : null;
      },
    });
    const project = writeResultFile(`${s.requestId}.project.json`, JSON.stringify(doc));
    deliver({
      status: 'completed',
      requestId: s.requestId,
      output: {
        mp4Path: plainPath(video.uri),
        durationMs,
        draftId,
        project: { formatVersion: doc.version, path: plainPath(project.uri) },
        mediaDir: plainPath(documentDir().uri),
      },
    });
  } catch (e) {
    deliver({
      status: 'failed',
      requestId: s.requestId,
      error: { code: 'export.failed', message: e instanceof Error ? e.message : String(e) },
    });
  }
}

/** End the request without a video: the person closed Pulse. */
export function cancelEmbedSession(): void {
  const s = session;
  if (s) deliver({ status: 'canceled', requestId: s.requestId, reason: 'user' });
}

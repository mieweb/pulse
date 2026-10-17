import { getClipTranscripts, saveClipTranscript } from '@/db/clip-transcripts';
import type { Segment } from '@/db/schema';
import { absolutize } from '@/utils/file-store';
import { clipRender, effMs } from '@/utils/segment-window';

import { isModelReady } from './model';
import type { WhisperModel } from './models';
import { setTranscriptionStatus } from './transcription-status';
import { transcribeWords } from './whisper';

// Each clip is transcribed once, on its own, from the file it plays from (the untouched original
// for edits stored as settings), and its words are kept in that file's time — so trims, speed,
// mutes and reorders never re-run the model: the draft's captions are composed from the clips
// (compose.ts). On the speech bench (.devrun/whisper) this matched transcribing the whole draft on
// an unedited draft and did better on an edited one (sped-up and muted clips), with no re-run per
// edit.
//
// One clip at a time, in the order asked for. Paused while the recorder records (the model would
// compete with the capture); a job running then is stopped and goes back to the front. Only runs
// with a model already downloaded: a download is the user's call (the export screen asks).

type Job = { segmentId: string; file: string; model: WhisperModel };

const pending: Job[] = [];
let running: { job: Job; abort: AbortController } | null = null;
let paused = false;

const keyOf = (j: { segmentId: string; model: WhisperModel }) => `${j.segmentId}|${j.model.id}`;

/**
 * Transcribe whichever of `segments` (one draft's clips) have no transcript of the file they play
 * from with `model`. No-op until the model is downloaded; muted and zero-length clips still get
 * one (a later unmute or trim shouldn't wait for it).
 */
export async function requestClipTranscripts(
  segments: Segment[],
  model: WhisperModel,
): Promise<void> {
  if (!isModelReady(model)) return;
  const done = await getClipTranscripts(
    segments.map((s) => s.id),
    model.id,
  );
  for (const s of segments) {
    if (s.durationMs <= 0 && effMs(s) <= 0) continue;
    const file = clipRender(s).file;
    if (done.get(s.id)?.file === file) continue;
    const job = { segmentId: s.id, file, model };
    const key = keyOf(job);
    if (running && keyOf(running.job) === key && running.job.file === file) continue;
    const at = pending.findIndex((j) => keyOf(j) === key);
    if (at >= 0) pending.splice(at, 1);
    pending.push(job);
  }
  void pump();
}

/** Pause (while recording) or resume the queue. Pausing stops the clip being transcribed. */
export function setClipQueuePaused(on: boolean): void {
  if (paused === on) return;
  paused = on;
  if (on && running) {
    pending.unshift(running.job);
    running.abort.abort();
  }
  if (!on) void pump();
}

/** Drop every waiting and running job (a model switch, or on-device AI turned off). */
export function clearClipQueue(): void {
  pending.length = 0;
  running?.abort.abort();
}

async function pump(): Promise<void> {
  if (running || paused) return;
  const job = pending.shift();
  if (!job) return;
  const abort = new AbortController();
  running = { job, abort };
  setTranscriptionStatus({ kind: 'transcribing' });
  try {
    const words = await transcribeWords(absolutize(job.file), job.model, { signal: abort.signal });
    if (!abort.signal.aborted) await saveClipTranscript(job.segmentId, job.model.id, job.file, words);
  } catch (e) {
    // Stopped (paused, model switched) or failed (the clip deleted mid-run, an unreadable file):
    // nothing is stored, and the next request asks again.
    if (!abort.signal.aborted) console.warn(`[captions] clip ${job.segmentId} failed`, e);
  } finally {
    running = null;
    if (pending.length === 0 || paused) setTranscriptionStatus({ kind: 'idle' });
    void pump();
  }
}

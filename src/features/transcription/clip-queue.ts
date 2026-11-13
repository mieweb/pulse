import {
  getClipTranscripts,
  saveClipTranscript,
  saveClipTranscriptFailure,
} from '@/db/clip-transcripts';
import type { Segment } from '@/db/schema';
import { absolutize } from '@/utils/file-store';
import { clipRender, effMs } from '@/utils/segment-window';

import { isModelReady } from './model';
import type { WhisperModel } from './models';
import { clearTranscriptionStatus, setTranscriptionStatus } from './transcription-status';
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
// with a model already downloaded: a download is the user's call (the editor's Captions tool).
// A clip the model can't transcribe is stored as failed, so the captions can say so and retry.

type Job = { segmentId: string; file: string; model: WhisperModel };

const pending: Job[] = [];
let running: { job: Job; abort: AbortController; done: Promise<void> } | null = null;
let paused = false;

const keyOf = (j: { segmentId: string; model: WhisperModel }) => `${j.segmentId}|${j.model.id}`;

/**
 * Queue whichever of `segments` (one draft's clips) may still need a transcript of the file they
 * play from with `model`; a clip that already has one is skipped when its turn comes (checked
 * then, not here, so nothing awaited here can outlive a `clearClipQueue`). No-op until the model
 * is downloaded; muted and zero-length clips still get one (a later unmute or trim shouldn't
 * wait for it).
 */
export function requestClipTranscripts(segments: readonly Segment[], model: WhisperModel): void {
  if (!isModelReady(model)) return;
  for (const s of segments) {
    if (s.durationMs <= 0 && effMs(s) <= 0) continue;
    const job = { segmentId: s.id, file: clipRender(s).file, model };
    const key = keyOf(job);
    if (running && keyOf(running.job) === key && running.job.file === job.file) continue;
    const at = pending.findIndex((j) => keyOf(j) === key);
    if (at >= 0) pending.splice(at, 1);
    pending.push(job);
  }
  pump();
}

/** Pause (while recording) or resume the queue. Pausing stops the clip being transcribed. */
export function setClipQueuePaused(on: boolean): void {
  if (paused === on) return;
  paused = on;
  if (on && running) {
    pending.unshift(running.job);
    running.abort.abort();
  }
  if (!on) pump();
}

/**
 * Drop every waiting and running job (a model switch, or on-device AI turned off). Resolves once
 * the running one has stopped, so its model can be released after it, not under it.
 */
export function clearClipQueue(): Promise<void> {
  pending.length = 0;
  running?.abort.abort();
  return running?.done ?? Promise.resolve();
}

function pump(): void {
  if (running || paused) return;
  const job = pending.shift();
  if (!job) return;
  const abort = new AbortController();
  const done = run(job, abort.signal).finally(() => {
    running = null;
    if (pending.length === 0 || paused) clearTranscriptionStatus('transcribing');
    pump();
  });
  running = { job, abort, done };
}

async function run(job: Job, signal: AbortSignal): Promise<void> {
  try {
    const have = (await getClipTranscripts([job.segmentId], job.model.id)).get(job.segmentId);
    if (signal.aborted || have?.file === job.file) return;
    setTranscriptionStatus({ kind: 'transcribing' });
    const words = await transcribeWords(absolutize(job.file), job.model, { signal });
    if (!signal.aborted) await saveClipTranscript(job.segmentId, job.model.id, job.file, words);
  } catch (e) {
    // Stopped (paused, model switched): nothing is stored, and the next request asks again.
    if (signal.aborted) return;
    console.warn(`[captions] clip ${job.segmentId} failed`, e);
    // Failed (an unreadable file, the model wouldn't load): stored as failed, for Retry. A clip
    // deleted mid-run has no row to point at, so this fails too and nothing is stored.
    await saveClipTranscriptFailure(job.segmentId, job.model.id, job.file).catch(() => {});
  }
}

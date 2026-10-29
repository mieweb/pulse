import { AppState } from 'react-native';

import {
  getClipTranscripts,
  saveClipTranscript,
  saveClipTranscriptFailure,
} from '@/db/clip-transcripts';
import { segmentExists } from '@/db/drafts';
import type { Segment } from '@/db/schema';
import { absolutize } from '@/utils/file-store';
import { clipRender, effMs } from '@/utils/segment-window';

import { isModelReady } from './model';
import type { WhisperModel } from './models';
import { clearTranscriptionStatus, setTranscriptionStatus } from './transcription-status';
import { releaseWhisper, transcribeWords } from './whisper';

// Each clip is transcribed once, on its own, from the file it plays from (the untouched original
// for edits stored as settings), and its words are kept in that file's time — so trims, speed,
// mutes and reorders never re-run the model: the draft's captions are composed from the clips
// (compose.ts). On the speech bench (.devrun/whisper) this matched transcribing the whole draft on
// an unedited draft and did better on an edited one (sped-up and muted clips), with no re-run per
// edit.
//
// One clip at a time, in the order asked for. Paused while the recorder records (the model would
// compete with the capture) and while the app is in the background (iOS doesn't let a background
// app use the GPU, and a GPU context that failed there stays broken); a job running then is
// stopped and goes back to the front. Only runs with a model already downloaded: a download is the
// user's call (the editor's Captions tool). A clip the model can't transcribe twice (the second
// time on a fresh context) is stored as failed, so the captions can say so and retry.

type Job = { segmentId: string; draftId: string; file: string; model: WhisperModel };

const pending: Job[] = [];
let running: { job: Job; abort: AbortController; done: Promise<void> } | null = null;
/** Why the queue is paused: the recorder is recording, the app is in the background. */
const pausedFor = new Set<'recording' | 'background'>();

if (AppState.currentState === 'background') pausedFor.add('background');
AppState.addEventListener('change', (state) => setPaused('background', state === 'background'));

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
    const job = { segmentId: s.id, draftId: s.draftId, file: clipRender(s).file, model };
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
  setPaused('recording', on);
}

function setPaused(reason: 'recording' | 'background', on: boolean): void {
  const was = pausedFor.size > 0;
  if (on) pausedFor.add(reason);
  else pausedFor.delete(reason);
  const now = pausedFor.size > 0;
  if (was === now) return;
  if (now && running) {
    pending.unshift(running.job);
    running.abort.abort();
  }
  if (!now) pump();
}

/**
 * Drop the jobs of deleted clips (or of a deleted draft), stopping the one running: their files
 * are going, and their transcripts would have no row to go to.
 */
export function dropClipJobs(gone: { segmentIds?: readonly string[]; draftId?: string }): void {
  const dropped = (j: Job) =>
    (gone.draftId !== undefined && j.draftId === gone.draftId) ||
    (gone.segmentIds?.includes(j.segmentId) ?? false);
  for (let i = pending.length - 1; i >= 0; i--) if (dropped(pending[i])) pending.splice(i, 1);
  if (running && dropped(running.job)) running.abort.abort();
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
  if (running || pausedFor.size > 0) return;
  const job = pending.shift();
  if (!job) return;
  const abort = new AbortController();
  const done = run(job, abort.signal).finally(() => {
    running = null;
    if (pending.length === 0 || pausedFor.size > 0) clearTranscriptionStatus('transcribing');
    pump();
  });
  running = { job, abort, done };
}

async function run(job: Job, signal: AbortSignal): Promise<void> {
  try {
    // Gone since it was asked for: a clip (or draft) deleted, or the model switched away (only
    // the selected model is kept on disk). Nothing to do and nothing to store; no model download.
    if (!isModelReady(job.model) || !(await segmentExists(job.segmentId))) return;
    const have = (await getClipTranscripts([job.segmentId], job.model.id)).get(job.segmentId);
    if (signal.aborted || have?.file === job.file) return;
  } catch (e) {
    // A read that failed: dropped, asked for again the next time the clip's captions are wanted.
    console.warn(`[captions] clip ${job.segmentId} skipped`, e);
    return;
  }
  setTranscriptionStatus({ kind: 'transcribing' });
  for (let attempt = 1; ; attempt++) {
    try {
      const words = await transcribeWords(absolutize(job.file), job.model, { signal });
      if (!signal.aborted) await saveClipTranscript(job.segmentId, job.model.id, job.file, words);
      return;
    } catch (e) {
      // Stopped (paused, model switched, clip deleted): nothing is stored; asked again later.
      if (signal.aborted) return;
      console.warn(`[captions] clip ${job.segmentId} failed (attempt ${attempt})`, e);
      if (attempt === 1) {
        // Once more on a fresh context: one that failed (a GPU error) can keep failing until
        // it's rebuilt.
        await releaseWhisper().catch(() => {});
        if (signal.aborted) return;
        continue;
      }
      // Failed twice (an unreadable file, a model that won't load): stored as failed, for Retry.
      await saveClipTranscriptFailure(job.segmentId, job.model.id, job.file).catch(() => {});
      return;
    }
  }
}

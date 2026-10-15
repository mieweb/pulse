import { extractAudio } from '@mieweb/pulse-editor';
import {
  initParakeet,
  initWhisper,
  type ParakeetContext,
  type WhisperContext,
} from 'whisper.rn';

import { wholeWords } from './group-lines';
import { ensureModel, modelFileUri } from './model';
import type { WhisperModel } from './models';
import { hasSpeech } from './vad';

/**
 * One word of a transcript. `t0`/`t1` are whisper.cpp timestamps in **centiseconds** (1/100s)
 * relative to the clip's audio start. Words drive word-level (karaoke) caption highlighting.
 */
export type TranscriptWord = { text: string; t0: number; t1: number };

/**
 * One transcribed line (caption cue). `t0`/`t1` are **centiseconds** relative to the clip's
 * audio start — divide by 100 for seconds when rendering. `words` (when present) carries the
 * per-word timing within the line; older stored rows may omit it and render line-level only.
 */
export type TranscriptLine = { text: string; t0: number; t1: number; words?: TranscriptWord[] };

/** Parse a persisted `lines`/`editedLines` JSON column to `TranscriptLine[]`; `[]` on null/malformed. */
export function parseTranscriptLines(json: string | null | undefined): TranscriptLine[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as TranscriptLine[];
  } catch {
    return [];
  }
}

/**
 * Whether the clip has no speech worth transcribing. Runs the VAD pre-gate; if the VAD itself is
 * unavailable (e.g. its model hasn't downloaded yet offline) we fail **open** — assume speech and
 * let Whisper run — so a VAD hiccup never silently drops real captions.
 */
async function isSilent(pcm: ArrayBuffer): Promise<boolean> {
  try {
    return !(await hasSpeech(pcm));
  } catch {
    return false;
  }
}

// A model context is expensive to create (loads the weights into memory) and is reusable across
// clips, so we hold a single instance, tagged with the model it was built from. Switching models
// releases the old context before loading the new one.
type Context = WhisperContext | ParakeetContext;
let current: { id: string; ctx: Context } | null = null;
let loadPromise: Promise<Context> | null = null;

// Whisper: `maxLen: 1` makes it emit one segment per token, each with its own t0/t1 — the only
// way whisper.rn surfaces word-level timing (its result exposes segments, not tokens); the pieces
// of a word are joined (group-lines.ts). Parakeet: one segment per word, timed from its tokens
// (patches/whisper.rn+0.7.4.patch).
const WORD_PER_SEGMENT = 1;

/**
 * Build a context on the GPU (Metal on iOS; Whisper with Flash Attention). whisper.rn already runs
 * on the CPU when Metal isn't usable (simulators, GPUs older than Apple7), and Android has no GPU
 * backend in whisper.rn (the flag is ignored there), so Android always runs on the CPU. If the GPU
 * context still fails to load, retry on the CPU rather than failing transcription outright;
 * `useGpu` defaults to true in whisper.rn, so the fallback has to turn it off explicitly.
 */
async function initContext(model: WhisperModel, filePath: string): Promise<Context> {
  if (model.engine === 'parakeet') {
    try {
      return await initParakeet({ filePath, useGpu: true });
    } catch {
      return initParakeet({ filePath, useGpu: false });
    }
  }
  try {
    return await initWhisper({ filePath, useGpu: true, useFlashAttn: true });
  } catch {
    return initWhisper({ filePath, useGpu: false });
  }
}

/** Free the active model context (e.g. on model switch / delete). Re-loads lazily on next use. */
export async function releaseWhisper(): Promise<void> {
  loadPromise = null;
  const ctx = current?.ctx ?? null;
  current = null;
  await ctx?.release();
}

/**
 * Get a context for `model`, loading (and downloading, if needed) on first use and swapping the
 * context when the selected model changes. Idempotent for the already-loaded model.
 */
async function loadContext(model: WhisperModel): Promise<Context> {
  if (current?.id === model.id) return current.ctx;
  if (loadPromise) await loadPromise.catch(() => {});
  if (current?.id === model.id) return current.ctx;

  loadPromise = (async () => {
    await releaseWhisper();
    await ensureModel(model); // no-op if already on disk
    const ctx = await initContext(model, modelFileUri(model));
    current = { id: model.id, ctx };
    return ctx;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

/**
 * The words spoken in one clip's audio, on-device with the given model: whole words, each timed in
 * centiseconds from the start of the file. `[]` for a file with no sound or no speech.
 *
 * Pipeline: pulse-editor decodes the audio track in memory to what both engines take — 16 kHz
 * mono 16-bit PCM, downmixed and band-limited resampled natively — and the VAD gate and the model
 * both read that one buffer: no temp file, no second decode. The model is expected to be
 * downloaded already (the queue only runs with a downloaded model); if not, it's fetched here.
 *
 * @param fileUri absolute file URI of the clip's media (the file it plays from).
 */
export async function transcribeWords(
  fileUri: string,
  model: WhisperModel,
  options?: { signal?: AbortSignal },
): Promise<TranscriptWord[]> {
  const { signal } = options ?? {};
  // Cancelled during a step before inference (the clip deleted, the recorder started recording,
  // the model switched): stop there, so no inference starts for nobody.
  const stopIfCancelled = () => {
    if (signal?.aborted) throw new Error('Transcription cancelled');
  };
  const { data: pcm } = await extractAudio(fileUri);
  stopIfCancelled();
  // No audio track: nothing to caption.
  if (pcm.byteLength === 0) return [];
  // Pre-gate on voice activity: silent/noise-only clips make Whisper hallucinate (the
  // multilingual model emits Chinese on noise, or canned subtitle credits on silence). Skip the
  // model entirely: an empty transcript settles the clip instead of re-running.
  if (await isSilent(pcm)) return [];
  stopIfCancelled();

  const ctx = await loadContext(model);
  stopIfCancelled();
  // Whisper: `language` honors the model ('en' for the English-only one, 'auto' for the
  // multilingual one); `maxThreads` 6 (whisper.rn defaults to 2–4; modern iPhones have 6 cores and
  // whisper.cpp clamps to what's there); greedy, single-candidate decoding (`bestOf: 1`, and no
  // `beamSize`: whisper.rn switches to beam search for any beamSize, even 1), the same transcripts
  // on our test clips, 8–15% faster. Parakeet detects the language itself and decodes greedily.
  const { stop, promise } =
    model.engine === 'parakeet'
      ? (ctx as ParakeetContext).transcribeData(pcm, { maxThreads: 6 })
      : (ctx as WhisperContext).transcribeData(pcm, {
          language: model.lang,
          maxLen: WORD_PER_SEGMENT,
          tokenTimestamps: true,
          maxThreads: 6,
          bestOf: 1,
        });
  // Cancellation once inference runs (the checks above cover the steps before it, with no await
  // between the last one and here): stop the native inference so it stops contending with a new
  // recording and so a later `releaseWhisper()` (model switch/delete) can't free the context out
  // from under a live call.
  const onAbort = () => void stop().catch(() => {});
  signal?.addEventListener('abort', onAbort);
  try {
    const result = await promise;
    return wholeWords(result.segments);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

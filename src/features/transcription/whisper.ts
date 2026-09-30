import { extractAudio } from '@mieweb/pulse-editor';
import { initWhisper, type WhisperContext } from 'whisper.rn';

import { groupWordsIntoLines } from './group-lines';
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

export type TranscriptResult = {
  language: string;
  text: string;
  lines: TranscriptLine[];
};

/** Parse a persisted `lines`/`editedLines` JSON column to `TranscriptLine[]`; `[]` on null/malformed. */
export function parseTranscriptLines(json: string | null | undefined): TranscriptLine[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as TranscriptLine[];
  } catch {
    return [];
  }
}

/** A clip with no detected speech: a settled, empty transcript (no captions, never re-run). */
const EMPTY_TRANSCRIPT: TranscriptResult = { language: '', text: '', lines: [] };

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

// A Whisper context is expensive to create (loads the weights into memory) and is reusable across
// clips, so we hold a single instance, tagged with the model it was built from. Switching models
// releases the old context before loading the new one.
let current: { id: string; ctx: WhisperContext } | null = null;
let loadPromise: Promise<WhisperContext> | null = null;

// `maxLen: 1` makes whisper emit one segment per word, each with its own t0/t1 — the only way
// whisper.rn surfaces word-level timing (its result exposes segments, not tokens). We then fold
// those words back into caption-sized lines ourselves (see group-lines.ts), which gives both
// word-level timing (for karaoke highlighting) and readable, standards-sized cues.
const WORD_PER_SEGMENT = 1;

/**
 * Build a Whisper context on the Metal GPU with Flash Attention (iOS). whisper.rn already runs on
 * the CPU when Metal isn't usable (simulators, GPUs older than Apple7), and Android has no GPU
 * backend in whisper.rn (the flag is ignored there), so Android always runs on the CPU. If the GPU
 * context still fails to load, retry on the CPU rather than failing transcription outright;
 * `useGpu` defaults to true in whisper.rn, so the fallback has to turn it off explicitly.
 */
async function initContext(filePath: string): Promise<WhisperContext> {
  try {
    return await initWhisper({ filePath, useGpu: true, useFlashAttn: true });
  } catch {
    return initWhisper({ filePath, useGpu: false });
  }
}

/** Free the active Whisper context (e.g. on model switch / delete). Re-loads lazily on next use. */
export async function releaseWhisper(): Promise<void> {
  loadPromise = null;
  const ctx = current?.ctx ?? null;
  current = null;
  await ctx?.release();
}

/**
 * Get a Whisper context for `model`, loading (and downloading, if needed) on first use and
 * swapping the context when the selected model changes. Idempotent for the already-loaded model.
 */
async function loadContext(model: WhisperModel): Promise<WhisperContext> {
  if (current?.id === model.id) return current.ctx;
  if (loadPromise) await loadPromise.catch(() => {});
  if (current?.id === model.id) return current.ctx;

  loadPromise = (async () => {
    await releaseWhisper();
    await ensureModel(model); // no-op if already on disk
    const ctx = await initContext(modelFileUri(model));
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
 * Transcribe a single video clip's audio on-device with the given model.
 *
 * Pipeline: pulse-editor decodes the audio track in memory to what whisper.cpp takes — 16 kHz mono
 * 16-bit PCM, downmixed and band-limited resampled natively — and the VAD gate and Whisper both
 * read that one buffer (`detectSpeechData` / `transcribeData`): no temp file, no second decode.
 * The model is expected to be downloaded already (the manager handles the download phase); if
 * not, it is fetched here as a fallback.
 *
 * @param videoUri absolute file URI to the clip (the effective edited-or-original file).
 */
export async function transcribeVideo(
  videoUri: string,
  model: WhisperModel,
  options?: { onProgress?: (progress: number) => void; signal?: AbortSignal },
): Promise<TranscriptResult> {
  const { onProgress, signal } = options ?? {};
  const { data: pcm } = await extractAudio(videoUri);
  // No audio track: nothing to caption.
  if (pcm.byteLength === 0) return EMPTY_TRANSCRIPT;
  // Pre-gate on voice activity: silent/noise-only clips make Whisper hallucinate (the
  // multilingual model emits Chinese on noise, or canned subtitle credits on silence). Skip
  // Whisper entirely and store an empty transcript so the clip settles instead of re-running.
  if (await isSilent(pcm)) return EMPTY_TRANSCRIPT;

  const ctx = await loadContext(model);
  // `tokenTimestamps` is what lets `maxLen` split output by token; with `maxLen: 1` we get one
  // word per segment (with per-word t0/t1), then regroup into caption lines ourselves.
  // `language` honors the model: 'en' for the English-only models, 'auto' for the multilingual one.
  //
  // Speed knobs for the on-device hot path (captions, not subtitling a film):
  // - `maxThreads`: whisper.rn defaults to 2–4; modern iPhones have 6 cores, so let inference use
  //   them. whisper.cpp clamps to what's actually available, so over-asking on a 4-core device is
  //   safe.
  // - Greedy, single-candidate decoding (`bestOf: 1`, and no `beamSize`: whisper.rn switches to
  //   beam search for any beamSize, even 1). Same transcripts on our test clips, 8–15% faster.
  const { stop, promise } = ctx.transcribeData(pcm, {
    language: model.lang,
    maxLen: WORD_PER_SEGMENT,
    tokenTimestamps: true,
    maxThreads: 6,
    bestOf: 1,
    onProgress,
  });
  // Cancellation (export screen left, or the run superseded by a clip change): stop the native
  // inference so it stops contending with a new recording/transcription AND so a later
  // `releaseWhisper()` (model switch/delete) can't free the context out from under a live call.
  const onAbort = () => void stop().catch(() => {});
  signal?.addEventListener('abort', onAbort);
  try {
    const result = await promise;
    return {
      language: result.language,
      text: result.result.trim(),
      lines: groupWordsIntoLines(result.segments),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

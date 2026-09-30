import { Directory, File, Paths } from 'expo-file-system';
import { initWhisperVad, type WhisperVadContext } from 'whisper.rn';

/**
 * Voice-activity-detection pre-gate for transcription.
 *
 * Whisper hallucinates on clips with no real speech: the multilingual model especially emits
 * Chinese on noise (auto language-detection falls back to its training prior) or canned subtitle
 * credits on silence ("Thank you for watching", "Gracias por ver"). whisper.rn (0.7.4) doesn't
 * expose the whisper.cpp no-speech / logprob / entropy thresholds that would suppress this, so we
 * run a Silero VAD pass first and skip Whisper entirely on clips with no detected speech.
 *
 * The VAD model is a tiny (~865 KB) Silero GGML build hosted in the `ggml-org/whisper-vad` repo
 * (the speech models live in `ggerganov/whisper.cpp` — silero is no longer mirrored there). It
 * lives under `vad/` — NOT `models/` — so the single-speech-model-on-disk cleanup
 * (`deleteModelsExcept`) never wipes it on a model switch.
 */
const VAD_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin';
const VAD_FILENAME = 'ggml-silero-v6.2.0.bin';
// Completeness floor for a partial/interrupted download (the real file is ~865 KB).
const VAD_MIN_BYTES = 512 * 1024;

function vadDir(): Directory {
  return new Directory(Paths.document, 'vad');
}

function vadFile(): File {
  return new File(Paths.document, 'vad', VAD_FILENAME);
}

function isVadModelReady(): boolean {
  const file = vadFile();
  return file.exists && (file.size ?? 0) >= VAD_MIN_BYTES;
}

/** Ensure the Silero VAD model is on disk, downloading it on first use. Returns its file URI. */
async function ensureVadModel(): Promise<string> {
  const file = vadFile();
  if (isVadModelReady()) return file.uri;

  if (file.exists) file.delete(); // clear a partial/corrupt prior attempt
  vadDir().create({ intermediates: true, idempotent: true });

  const task = File.createDownloadTask(VAD_URL, file);
  await task.downloadAsync();
  if (!isVadModelReady()) {
    if (file.exists) file.delete();
    throw new Error('VAD model download failed or is incomplete');
  }
  return file.uri;
}

// The VAD context is independent of which speech model is selected, so we hold a single instance
// across model switches (it's cheap and tiny) and only release it when on-device AI is turned off.
let ctx: WhisperVadContext | null = null;
let loadPromise: Promise<WhisperVadContext> | null = null;
// Sticky flag set when VAD init fails — the device genuinely can't run the
// VAD, so we stop re-attempting it on every clip (callers fail open and let Whisper run). A model
// download failure (offline) is NOT cached here: it's transient and retried on the next clip.
// Cleared by releaseVad so a later toggle can try again.
let unavailable = false;

/**
 * Build a VAD context on the CPU. whisper.rn 0.7.4 runs VAD on the CPU on both platforms whatever
 * `useGpu` says; it defaults to true, so it's set to false here to say what actually happens.
 */
function initVadContext(filePath: string): Promise<WhisperVadContext> {
  return initWhisperVad({ filePath, useGpu: false });
}

async function loadVad(): Promise<WhisperVadContext> {
  if (ctx) return ctx;
  if (unavailable) throw new Error('VAD unavailable on this device');
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await ensureVadModel(); // transient (offline) failures throw here and are intentionally not cached
    let vadCtx: WhisperVadContext;
    try {
      vadCtx = await initVadContext(vadFile().uri);
    } catch (error) {
      unavailable = true; // the device can't run it — don't retry this on every clip
      throw error;
    }
    ctx = vadCtx;
    return vadCtx;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

/** Free the VAD context (e.g. when the model is cleared). Re-loads lazily on next use. */
export async function releaseVad(): Promise<void> {
  loadPromise = null;
  unavailable = false; // allow a fresh attempt after a model toggle
  const prevCtx = ctx;
  ctx = null;
  await prevCtx?.release();
}

/**
 * Whether `pcm` (16 kHz mono 16-bit PCM, as pulse-editor's `extractAudio` returns it) contains
 * any detected speech. Throws if the VAD model isn't yet available (e.g. offline before its first
 * download) — callers should treat that as "unknown" and fail open (transcribe anyway) rather
 * than dropping captions.
 *
 * NOTE: `detectSpeechData` segments' `t0`/`t1` are in **centiseconds**, like Whisper's transcript
 * lines (a 12 s clip's speech reads 99–1203). We only count segments here.
 */
export async function hasSpeech(pcm: ArrayBuffer): Promise<boolean> {
  const vadCtx = await loadVad();
  const segments = await vadCtx.detectSpeechData(pcm);
  return segments.length > 0;
}

// Catalog of on-device speech models the user can choose between, picked for how the app
// transcribes (each clip on its own, see clip-queue.ts) on the speech benches (.devrun/whisper;
// docs/captions-engines.md): Parakeet TDT for English (the most accurate there, with the best word
// timing), and a multilingual Whisper for every other language — Parakeet v3 as whisper.cpp runs
// it gives English only (a Spanish clip came back translated into English). The multilingual one
// is per platform: Large Turbo on iOS (the GPU runs it at 5x realtime, and it was the more accurate
// in Spanish, Mandarin and Arabic), Small on Android (whisper.rn runs on the CPU there).
// `approxBytes` is only for an initial progress estimate / a completeness floor — the real content
// length comes from the download task.
const WHISPER_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const PARAKEET_URL = 'https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/';

export type WhisperModel = {
  id: string;
  /** Which whisper.rn engine runs it: Whisper, or NVIDIA Parakeet TDT. */
  engine: 'whisper' | 'parakeet';
  /** Where it's offered (`Platform.OS`). */
  platforms: readonly ('ios' | 'android')[];
  label: string;
  /**
   * The underlying Whisper checkpoint name (e.g. `base.en`, `large-v3-turbo`), shown muted in the
   * picker so it's transparent which actual model — and quantization — the friendly label maps to.
   */
  name: string;
  filename: string;
  /** Approximate on-disk size, for the size label and progress before the server says. */
  approxBytes: number;
  /** The file's exact size (as served, 2026-10-28): a model file left by a build that didn't
   * record a verified download counts as complete only at this size. */
  bytes: number;
  /** Short tradeoff note shown in the picker. */
  note: string;
  /**
   * Decode language passed to Whisper. The `.en` models are English-only, so we pin `'en'`;
   * the multilingual models use `'auto'` so they actually detect the spoken language instead of
   * being silently forced to English (Parakeet always detects it).
   */
  lang: 'en' | 'auto';
};

export const MODELS: WhisperModel[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-q4_0',
    engine: 'parakeet',
    platforms: ['ios', 'android'],
    label: 'Parakeet',
    name: 'parakeet-tdt-0.6b-v3 · q4_0',
    filename: 'ggml-parakeet-tdt-0.6b-v3-q4_0.bin',
    approxBytes: 339 * 1024 * 1024,
    bytes: 355_615_679,
    note: 'Most accurate · English only',
    lang: 'en',
  },
  {
    id: 'large-v3-turbo-q5_0',
    engine: 'whisper',
    platforms: ['ios'],
    label: 'Large Turbo',
    name: 'large-v3-turbo · q5_0',
    filename: 'ggml-large-v3-turbo-q5_0.bin',
    approxBytes: 574 * 1024 * 1024,
    bytes: 574_041_195,
    note: 'Any language · best quality',
    lang: 'auto',
  },
  {
    id: 'small-q5_1',
    engine: 'whisper',
    platforms: ['android'],
    label: 'Small (Multilingual)',
    name: 'small · q5_1',
    filename: 'ggml-small-q5_1.bin',
    approxBytes: 181 * 1024 * 1024,
    bytes: 190_085_487,
    note: 'Any language',
    lang: 'auto',
  },
];

/** Models at/above this on-disk size prompt for confirmation before downloading (cellular/data). */
export const LARGE_MODEL_BYTES = 300 * 1024 * 1024;

/**
 * Device RAM floor for the large models (`LARGE_MODEL_BYTES` and up): the runtime working set is a
 * multiple of the weights — on phones under this floor (budget Androids, older iPhones) inference
 * is memory-starved: heavy swapping at best, an OOM kill at worst.
 */
export const LARGE_MODEL_MIN_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * The device signals the caveat logic needs. Kept as a plain data shape (not read from
 * expo-device here) so this module stays pure-Node loadable for jest; the UI layer feeds it
 * from `currentDeviceProfile()` (device-profile.ts).
 */
export type DeviceProfile = {
  /** `Platform.OS` — 'ios' | 'android' (other values behave like iOS: no Android caveat). */
  os: string;
  /** `Device.totalMemory` — physical RAM in bytes, or null when unknown (e.g. web/tests). */
  totalMemoryBytes: number | null;
};

/**
 * Device-specific warning for a model, appended to its base `note` in the picker — or null when
 * the model runs well on this device. Two independent signals, worst first:
 *  - low RAM (`LARGE_MODEL_MIN_MEMORY_BYTES`): the large model's working set doesn't fit —
 *    warn regardless of platform.
 *  - Android: whisper.rn has no GPU backend there (CPU-only inference, no Metal), so a large
 *    model is slower than on iOS even with plenty of RAM (not yet measured for Parakeet).
 */
export function modelCaveat(model: WhisperModel, profile: DeviceProfile): string | null {
  if (model.approxBytes < LARGE_MODEL_BYTES) return null;
  if (profile.totalMemoryBytes != null && profile.totalMemoryBytes < LARGE_MODEL_MIN_MEMORY_BYTES) {
    return 'may be unstable on this device';
  }
  if (profile.os === 'android') return 'slow on Android';
  return null;
}

export const getModel = (id: string | null | undefined): WhisperModel | null =>
  MODELS.find((m) => m.id === id) ?? null;

/**
 * Ids of models retired from the catalog, mapped to the id users should migrate to (`null` to just
 * clear the selection). Add an entry here whenever a model is removed from MODELS. A stored retired
 * selection is resolved to its replacement wherever the persisted selection is read
 * (`resolveSelectedModel`); the replacement's weights are then downloaded from the editor's
 * Captions tool.
 */
export const RETIRED_MODELS: Record<string, string | null> = {
  // English: Parakeet, which on the speech bench (per clip) was at least as accurate as these
  // English Whispers, with far better word timing.
  'tiny.en': 'parakeet-tdt-0.6b-v3-q4_0',
  'base.en': 'parakeet-tdt-0.6b-v3-q4_0',
  'small.en-q5_1': 'parakeet-tdt-0.6b-v3-q4_0',
};

/**
 * Where a stored id that no longer resolves should migrate: a retired id's designated replacement,
 * or `null` (clear the selection) for anything unknown/corrupt.
 */
export const migrateStaleModelId = (id: string): WhisperModel | null =>
  getModel(RETIRED_MODELS[id]);

/**
 * Resolve a persisted (possibly retired) selected-model id to a live model. Use this — not bare
 * `getModel` — everywhere the *stored* selection is read, so a user whose selected model was
 * renamed/retired keeps a working selection instead of silently falling back to "no model".
 */
export function resolveSelectedModel(
  id: string | null | undefined,
  os: string,
): WhisperModel | null {
  const model = getModel(id) ?? (id ? migrateStaleModelId(id) : null);
  if (!model || offeredOn(model, os)) return model;
  // Chosen on the other platform (a restored backup, a draft moved over): its counterpart here.
  return getModel(OTHER_PLATFORM[model.id]);
}

/** The models offered on `os` (`Platform.OS`; anything else is treated as iOS). */
export const modelsFor = (os: string): WhisperModel[] => MODELS.filter((m) => offeredOn(m, os));

const offeredOn = (m: WhisperModel, os: string) =>
  m.platforms.includes(os === 'android' ? 'android' : 'ios');

/** A model only one platform offers, mapped to the one the other platform offers instead. */
const OTHER_PLATFORM: Record<string, string> = {
  'large-v3-turbo-q5_0': 'small-q5_1',
  'small-q5_1': 'large-v3-turbo-q5_0',
};

export const modelUrl = (m: WhisperModel): string =>
  (m.engine === 'parakeet' ? PARAKEET_URL : WHISPER_URL) + m.filename;

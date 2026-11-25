import type { TranscriptWord } from '@/core/types/transcription';

export type SourceRange = { startMs: number; endMs: number };

/** A proposal in one immutable source file's clock; the editor adds clip/source identity. */
export type CleanupCandidate = SourceRange & {
  id: string;
  kind: 'filler' | 'silence';
  label: string;
  wordIndexes?: number[];
  /** No audible frame was found in this source; never preselect automatic deletion. */
  requiresReview?: boolean;
};

/** Meaning-bearing words such as “like”, “so” and “well” require an explicit custom choice. */
export const DEFAULT_FILLER_WORDS = ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hm', 'hmm'] as const;

export type QuietPauseOptions = {
  /** Only propose quiet spans at least this long before retaining their edges. */
  minPauseMs?: number;
  /** Quiet audio retained at each side of a pause, protecting nearby word boundaries. */
  keepMs?: number;
  /** RMS amplitude ceiling in dBFS; quiet speech can also fall below it. */
  thresholdDb?: number;
  /** Peak ceiling prevents an isolated audible transient from counting as quiet. */
  peakDb?: number;
  window?: SourceRange;
};

export const DEFAULT_QUIET_PAUSE_OPTIONS = {
  minPauseMs: 700,
  keepMs: 120,
  thresholdDb: -45,
  peakDb: -35,
} as const;

const FRAME_MS = 20;
const MAX_PHRASE_GAP_MS = 500;

/** Case and surrounding punctuation do not change a spoken filler word. */
export function normalizeFillerText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

/** Restrict proposals to the played source window, without changing their baseline identities. */
export function candidatesInWindow(
  candidates: readonly CleanupCandidate[],
  window?: SourceRange,
): CleanupCandidate[] {
  if (!window) return candidates.map((candidate) => ({ ...candidate }));
  if (
    !Number.isFinite(window.startMs) ||
    !Number.isFinite(window.endMs) ||
    window.startMs < 0 ||
    window.endMs <= window.startMs
  )
    return [];
  return candidates.flatMap((candidate) => {
    const startMs = Math.max(candidate.startMs, window.startMs);
    const endMs = Math.min(candidate.endMs, window.endMs);
    return endMs > startMs ? [{ ...candidate, startMs, endMs }] : [];
  });
}

/**
 * Propose only fillers actually represented in the supplied transcript. Some ASR models omit
 * “ums”; an absent token cannot be recovered by a text match. Custom phrases are supported, but
 * cannot bridge long pauses or invalid/overlapping word timings. Longer matches win.
 */
export function findFillerCandidates(
  words: readonly TranscriptWord[],
  fillers: readonly string[] = DEFAULT_FILLER_WORDS,
  window?: SourceRange,
): CleanupCandidate[] {
  const patterns = [...new Set(fillers.map(normalizeFillerText).filter(Boolean))]
    .map((phrase) => ({ phrase, parts: phrase.split(' ') }))
    .sort((a, b) => b.parts.length - a.parts.length);
  const normalized = words.map((word) => normalizeFillerText(word.text));
  const valid = (word: TranscriptWord | undefined): word is TranscriptWord =>
    !!word &&
    Number.isFinite(word.t0) &&
    Number.isFinite(word.t1) &&
    word.t0 >= 0 &&
    word.t1 > word.t0;
  const out: CleanupCandidate[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!valid(words[i])) continue;
    const pattern = patterns.find(({ parts }) =>
      parts.every((part, k) => {
        const word = words[i + k];
        const previous = words[i + k - 1];
        return (
          valid(word) &&
          normalized[i + k] === part &&
          (k === 0 || (word.t0 >= previous.t1 && (word.t0 - previous.t1) * 10 <= MAX_PHRASE_GAP_MS))
        );
      }),
    );
    if (!pattern) continue;
    const last = i + pattern.parts.length - 1;
    const range = { startMs: words[i].t0 * 10, endMs: words[last].t1 * 10 };
    // A phrase whose first/last word was already trimmed away should not match its remainder.
    if (
      window &&
      pattern.parts.length > 1 &&
      (range.startMs < window.startMs || range.endMs > window.endMs)
    )
      continue;
    out.push({
      ...range,
      id: `filler:${i}:${last}`,
      kind: 'filler',
      label: words
        .slice(i, last + 1)
        .map((word) => word.text)
        .join(' '),
      wordIndexes: Array.from({ length: pattern.parts.length }, (_, k) => i + k),
    });
    i = last;
  }
  return candidatesInWindow(out, window);
}

/**
 * Find quiet pauses in signed 16-bit little-endian mono PCM, independently of ASR timestamps.
 * This measures audio energy, not semantic speech: background music can hide pauses and very
 * quiet speech can resemble silence. Proposals need preview/review before applying media cuts.
 */
export function findQuietPauseCandidates(
  pcm: ArrayBuffer,
  sampleRate = 16000,
  options: QuietPauseOptions = {},
): CleanupCandidate[] {
  const {
    minPauseMs = DEFAULT_QUIET_PAUSE_OPTIONS.minPauseMs,
    keepMs = DEFAULT_QUIET_PAUSE_OPTIONS.keepMs,
    thresholdDb = DEFAULT_QUIET_PAUSE_OPTIONS.thresholdDb,
    peakDb = DEFAULT_QUIET_PAUSE_OPTIONS.peakDb,
  } = options;
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0 ||
    ![minPauseMs, keepMs, thresholdDb, peakDb].every(Number.isFinite) ||
    minPauseMs < 0 ||
    keepMs < 0 ||
    thresholdDb > 0 ||
    peakDb > 0 ||
    peakDb < thresholdDb ||
    pcm.byteLength % 2 !== 0
  )
    throw new Error('Invalid quiet-pause audio or settings.');
  if (pcm.byteLength === 0) return [];
  const samples = new DataView(pcm);
  const length = pcm.byteLength / 2;
  const frameSamples = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const rmsSquared = (32768 * 10 ** (thresholdDb / 20)) ** 2;
  const peakLimit = 32768 * 10 ** (peakDb / 20);
  const out: CleanupCandidate[] = [];
  let quietStart = -1;
  const flush = (end: number) => {
    if (quietStart < 0) return;
    const rawStartMs = (quietStart / sampleRate) * 1000;
    const rawEndMs = (end / sampleRate) * 1000;
    if (rawEndMs - rawStartMs >= minPauseMs) {
      const startMs = rawStartMs + keepMs;
      const endMs = rawEndMs - keepMs;
      if (endMs > startMs)
        out.push({
          id: `silence:${quietStart}:${end}`,
          kind: 'silence',
          label:
            quietStart === 0 && end === length
              ? 'Quiet source — review before removing'
              : 'Quiet pause',
          startMs,
          endMs,
          ...(quietStart === 0 && end === length && { requiresReview: true }),
        });
    }
    quietStart = -1;
  };
  for (let start = 0; start < length; start += frameSamples) {
    const end = Math.min(length, start + frameSamples);
    let sum = 0;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const sample = samples.getInt16(i * 2, true);
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const quiet = sum / (end - start) <= rmsSquared && peak <= peakLimit;
    if (quiet && quietStart < 0) quietStart = start;
    if (!quiet) flush(start);
  }
  flush(length);
  return candidatesInWindow(out, options.window);
}

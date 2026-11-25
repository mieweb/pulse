import type { TranscriptWord } from '@/core/types/transcription';

export type SourceRange = { startMs: number; endMs: number };

/** A proposal in one immutable source file's clock; the editor adds clip/source identity. */
export type CleanupCandidate = SourceRange & {
  id: string;
  kind: 'filler' | 'silence';
  label: string;
  wordIndexes?: number[];
  /** No audible frame was found in the played window; never preselect automatic deletion. */
  requiresReview?: boolean;
};

/** Meaning-bearing words such as “like”, “so” and “well” require an explicit custom choice. */
export const DEFAULT_FILLER_WORDS = ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hm', 'hmm'] as const;

export type QuietPauseOptions = {
  /** Only propose played quiet spans at least this long before retaining their edges. */
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

/** Raw quiet spans can be reused by split beats without retaining the decoded PCM. */
export type QuietAudioScan = {
  durationMs: number;
  spans: (SourceRange & { id: string })[];
};

/** Measure signed 16-bit little-endian mono PCM independently of transcript timestamps. */
export function scanQuietAudio(
  pcm: ArrayBuffer,
  sampleRate = 16000,
  options: Pick<QuietPauseOptions, 'thresholdDb' | 'peakDb'> = {},
): QuietAudioScan {
  const {
    thresholdDb = DEFAULT_QUIET_PAUSE_OPTIONS.thresholdDb,
    peakDb = DEFAULT_QUIET_PAUSE_OPTIONS.peakDb,
  } = options;
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0 ||
    ![thresholdDb, peakDb].every(Number.isFinite) ||
    thresholdDb > 0 ||
    peakDb > 0 ||
    peakDb < thresholdDb ||
    pcm.byteLength % 2 !== 0
  )
    throw new Error('Invalid quiet-pause audio or settings.');
  if (pcm.byteLength === 0) return { durationMs: 0, spans: [] };
  const samples = new DataView(pcm);
  const length = pcm.byteLength / 2;
  const frameSamples = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const rmsSquared = (32768 * 10 ** (thresholdDb / 20)) ** 2;
  const peakLimit = 32768 * 10 ** (peakDb / 20);
  const spans: QuietAudioScan['spans'] = [];
  let quietStart = -1;
  const flush = (end: number) => {
    if (quietStart < 0) return;
    spans.push({
      id: `silence:${quietStart}:${end}`,
      startMs: (quietStart / sampleRate) * 1000,
      endMs: (end / sampleRate) * 1000,
    });
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
  return { durationMs: (length / sampleRate) * 1000, spans };
}

/**
 * Qualify and pad the raw pause within the played window, rather than clipping a full-file cut.
 * Energy is not semantic speech: very quiet speech can resemble silence and needs review.
 */
export function quietPauseCandidates(
  scan: QuietAudioScan,
  options: Pick<QuietPauseOptions, 'minPauseMs' | 'keepMs' | 'window'> = {},
): CleanupCandidate[] {
  const {
    minPauseMs = DEFAULT_QUIET_PAUSE_OPTIONS.minPauseMs,
    keepMs = DEFAULT_QUIET_PAUSE_OPTIONS.keepMs,
    window,
  } = options;
  if (![minPauseMs, keepMs].every(Number.isFinite) || minPauseMs < 0 || keepMs < 0)
    throw new Error('Invalid quiet-pause audio or settings.');
  if (
    window &&
    (!Number.isFinite(window.startMs) ||
      !Number.isFinite(window.endMs) ||
      window.startMs < 0 ||
      window.endMs <= window.startMs)
  )
    return [];
  const playedStartMs = window?.startMs ?? 0;
  const playedEndMs = Math.min(window?.endMs ?? scan.durationMs, scan.durationMs);
  return scan.spans.flatMap((span) => {
    const rawStartMs = Math.max(span.startMs, playedStartMs);
    const rawEndMs = Math.min(span.endMs, playedEndMs);
    if (rawEndMs <= rawStartMs || rawEndMs - rawStartMs < minPauseMs) return [];
    const startMs = rawStartMs + keepMs;
    const endMs = rawEndMs - keepMs;
    if (endMs <= startMs) return [];
    // Analysis frames can straddle trim boundaries. Conservatively review an almost-wholly
    // quiet beat too; raw spans make this independent of playback-speed-scaled edge padding.
    const requiresReview =
      rawStartMs - playedStartMs <= FRAME_MS && playedEndMs - rawEndMs <= FRAME_MS;
    return [
      {
        id: span.id,
        kind: 'silence' as const,
        label: requiresReview ? 'Quiet source — review before removing' : 'Quiet pause',
        startMs,
        endMs,
        ...(requiresReview && { requiresReview: true }),
      },
    ];
  });
}

/** Find reviewed pause proposals without retaining the raw scan beyond this call. */
export function findQuietPauseCandidates(
  pcm: ArrayBuffer,
  sampleRate = 16000,
  options: QuietPauseOptions = {},
): CleanupCandidate[] {
  return quietPauseCandidates(scanQuietAudio(pcm, sampleRate, options), options);
}

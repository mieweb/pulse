import type { TranscriptWord } from '@/core/types/transcription';
import { AI_CUT_MAX_DURATION_MS, type AiEditInterval } from '@/core/types/ai-edit';

export { AI_CUT_MAX_DURATION_MS };
const MAX_PASSAGE_MS = 25_000;
const SOFT_PASSAGE_MS = 8_000;

/** All bounds are file-relative milliseconds; transcript words retain their native centiseconds. */
export type AiEditSource = {
  segmentId: string;
  file: string;
  sourceKey: string;
  startMs: number;
  endMs: number;
  speed: number;
  words: readonly TranscriptWord[];
};

export type AiEditPassage = AiEditInterval & {
  id: string;
  text: string;
  sourceOrder: number;
  speed: number;
  durationMs: number;
  /** Padding may enter silence, but must stop before an adjacent spoken word. */
  paddingStartMs: number;
  paddingEndMs: number;
};

export type AiCutPlan = {
  intervals: AiEditInterval[];
  durationMs: number;
  selectedPassageIds: string[];
};

export type AiCutOptions = { maxDurationMs?: number; paddingMs?: number };

function checkedOptions(options: AiCutOptions) {
  const maxDurationMs = options.maxDurationMs ?? AI_CUT_MAX_DURATION_MS;
  const paddingMs = options.paddingMs ?? 120;
  if (
    !Number.isFinite(maxDurationMs) ||
    maxDurationMs <= 0 ||
    maxDurationMs > AI_CUT_MAX_DURATION_MS ||
    !Number.isFinite(paddingMs) ||
    paddingMs < 0 ||
    paddingMs > 1000
  )
    throw new Error('The AI cut duration or padding is invalid.');
  return { maxDurationMs, paddingMs };
}

/**
 * Prefer sentence endings and pauses. Punctuation-free speech is bounded at whole-word
 * boundaries, preferring a pause after eight seconds and never slicing a word to meet a limit.
 */
export function buildPassages(sources: readonly AiEditSource[]): AiEditPassage[] {
  const passages: AiEditPassage[] = [];
  const seen = new Set<string>();
  for (const [sourceOrder, source] of sources.entries()) {
    if (
      !source.segmentId ||
      seen.has(source.segmentId) ||
      !source.file ||
      !source.sourceKey ||
      !Number.isFinite(source.startMs) ||
      !Number.isFinite(source.endMs) ||
      source.startMs < 0 ||
      source.endMs <= source.startMs ||
      !Number.isFinite(source.speed) ||
      source.speed < 0.25 ||
      source.speed > 4
    )
      throw new Error('An AI edit source has invalid media timing.');
    seen.add(source.segmentId);
    let previousStart = -1;
    const words = source.words
      .map((word, index) => {
        if (
          typeof word.text !== 'string' ||
          !Number.isFinite(word.t0) ||
          !Number.isFinite(word.t1) ||
          word.t0 < previousStart ||
          word.t0 < 0 ||
          word.t1 < word.t0
        )
          throw new Error('The transcript contains invalid word timing.');
        previousStart = word.t0;
        return { ...word, index, startMs: word.t0 * 10, endMs: word.t1 * 10 };
      })
      .filter(
        (word) =>
          word.text.trim() &&
          word.endMs > word.startMs &&
          word.startMs >= source.startMs &&
          word.endMs <= source.endMs,
      );
    let from = 0;
    let speechEndMs = 0;
    const append = (to: number) => {
      const first = words[from];
      const last = words[to - 1];
      const endMs = Math.max(...words.slice(from, to).map((word) => word.endMs));
      const startMs = first.startMs;
      passages.push({
        id: `p:${encodeURIComponent(source.segmentId)}:${first.index}-${last.index + 1}`,
        text: words
          .slice(from, to)
          .map((word) => word.text.trim())
          .join(' '),
        segmentId: source.segmentId,
        file: source.file,
        sourceKey: source.sourceKey,
        sourceOrder,
        startMs,
        endMs,
        speed: source.speed,
        durationMs: Math.ceil((endMs - startMs) / source.speed),
        paddingStartMs: Math.min(
          startMs,
          Math.max(source.startMs, words[from - 1]?.endMs ?? source.startMs),
        ),
        paddingEndMs: Math.max(endMs, Math.min(source.endMs, words[to]?.startMs ?? source.endMs)),
      });
      from = to;
      speechEndMs = 0;
    };
    for (let i = 0; i < words.length; i++) {
      if (
        i > from &&
        words[i].startMs >= speechEndMs &&
        (words[i].endMs - words[from].startMs) / source.speed > MAX_PASSAGE_MS
      )
        append(i);
      const current = words[i];
      const next = words[i + 1];
      speechEndMs = Math.max(speechEndMs, current.endMs);
      const duration = (speechEndMs - words[from].startMs) / source.speed;
      const gap = next ? (next.startMs - speechEndMs) / source.speed : 0;
      if (
        !next ||
        (gap >= 0 &&
          (/[.!?。！？][”’"')\]]*$/u.test(current.text.trim()) ||
            gap >= 900 ||
            (duration >= SOFT_PASSAGE_MS && gap >= 250)))
      )
        append(i + 1);
    }
  }
  return passages;
}

function selectedPassages(passages: readonly AiEditPassage[], ids: readonly string[]) {
  const byId = new Map(passages.map((passage) => [passage.id, passage]));
  const seen = new Set<string>();
  return ids.map((id) => {
    const passage = byId.get(id);
    if (typeof id !== 'string' || !passage || seen.has(id))
      throw new Error('The AI returned an unknown or repeated passage. Try the edit again.');
    seen.add(id);
    return passage;
  });
}

function planOf(selected: readonly AiEditPassage[], paddingMs: number): AiCutPlan {
  const sorted = [...selected].sort(
    (a, b) => a.sourceOrder - b.sourceOrder || a.startMs - b.startMs,
  );
  const padded: (AiEditInterval & { speed: number })[] = [];
  for (const passage of sorted) {
    const interval = {
      segmentId: passage.segmentId,
      file: passage.file,
      sourceKey: passage.sourceKey,
      startMs: Math.max(passage.paddingStartMs, passage.startMs - paddingMs * passage.speed),
      endMs: Math.min(passage.paddingEndMs, passage.endMs + paddingMs * passage.speed),
      speed: passage.speed,
    };
    const previous = padded[padded.length - 1];
    if (previous?.segmentId === interval.segmentId && interval.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    } else padded.push(interval);
  }
  return {
    intervals: padded.map(({ speed: _speed, ...interval }) => interval),
    durationMs: Math.ceil(
      padded.reduce(
        (total, interval) => total + (interval.endMs - interval.startMs) / interval.speed,
        0,
      ),
    ),
    selectedPassageIds: sorted.map((passage) => passage.id),
  };
}

/** Strict validation for a complete selection; the media budget includes all cut padding. */
export function createCutPlan(
  passages: readonly AiEditPassage[],
  selectedIds: readonly string[],
  options: AiCutOptions = {},
): AiCutPlan {
  const { maxDurationMs, paddingMs } = checkedOptions(options);
  const selected = selectedPassages(passages, selectedIds);
  if (selected.length === 0) throw new Error('The AI did not select any spoken passages.');
  const plan = planOf(selected, paddingMs);
  if (plan.durationMs > maxDurationMs)
    throw new Error('The selected passages exceed the AI cut duration.');
  return plan;
}

/** Accept whole passages in editorial priority order, then restore their original timeline order. */
export function fitPassageSelection(
  passages: readonly AiEditPassage[],
  priorityIds: readonly string[],
  options: AiCutOptions = {},
): AiCutPlan {
  const { maxDurationMs, paddingMs } = checkedOptions(options);
  const selected: AiEditPassage[] = [];
  for (const passage of selectedPassages(passages, priorityIds)) {
    if (planOf([...selected, passage], paddingMs).durationMs <= maxDurationMs)
      selected.push(passage);
  }
  if (selected.length === 0)
    throw new Error('No complete spoken passage fits the AI cut duration.');
  return planOf(selected, paddingMs);
}

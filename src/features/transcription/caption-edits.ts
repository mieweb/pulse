import { linesFromWords } from './group-lines';
import type { TranscriptWord } from './whisper';

// Edits to a clip's words (in the file's time, centiseconds), as the editor makes them on its
// captions. Edited words carry where each sentence (a caption box) starts, `start`, so a split or
// a merge sticks instead of being regrouped: a clip's first edit freezes the sentences its words
// were grouped into, and every edit here keeps the starts right.

/** A clip's word as edited: `start` on the first word of each sentence. */
export type CaptionWord = TranscriptWord & { start?: boolean };

/** The shortest a word can be made, centiseconds. */
export const MIN_WORD_CS = 8;

/** `words` with sentence starts: theirs, or the automatic grouping's when they have none. */
export function withStarts(words: readonly CaptionWord[]): CaptionWord[] {
  if (words.some((w) => w.start)) return words.map((w) => ({ ...w }));
  const out: CaptionWord[] = [];
  for (const line of linesFromWords(words.map((w) => ({ text: w.text, t0: w.t0, t1: w.t1 })))) {
    (line.words ?? []).forEach((w, i) => out.push(i === 0 ? { ...w, start: true } : { ...w }));
  }
  return out;
}

/** The sentences, as [from, to) ranges of word indices. */
export function sentences(words: readonly CaptionWord[]): [number, number][] {
  const out: [number, number][] = [];
  words.forEach((w, i) => {
    if (i === 0 || w.start) out.push([i, i + 1]);
    else out[out.length - 1][1] = i + 1;
  });
  return out;
}

/** `text` as words spread over `t0` … `t1` by length (a longer word gets more of the time). */
function spread(text: string, t0: number, t1: number): CaptionWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out: CaptionWord[] = [];
  let at = t0;
  let used = 0;
  for (const p of parts) {
    used += p.length;
    const end = Math.round(t0 + ((t1 - t0) * used) / total);
    out.push({ text: p, t0: at, t1: end });
    at = end;
  }
  return out;
}

/** Words `from` … `to` replaced by `text` over the same time, starting a sentence if they did. */
function replaceRange(
  words: readonly CaptionWord[],
  from: number,
  to: number,
  text: string,
): CaptionWord[] {
  const w = withStarts(words);
  const t0 = w[from]?.t0 ?? 0;
  const t1 = w[to - 1]?.t1 ?? t0;
  const made = spread(text, t0, t1);
  if (made.length && w[from]?.start) made[0].start = true;
  const rest = w.slice(to);
  // The sentence's first word went with nothing in its place: the next word starts it.
  if (!made.length && w[from]?.start && rest.length && !rest[0].start) rest[0].start = true;
  return [...w.slice(0, from), ...made, ...rest];
}

/** One word with new text over its time (several words if it's typed as several). */
export function replaceWordText(words: readonly CaptionWord[], i: number, text: string) {
  return replaceRange(words, i, i + 1, text);
}

/** One word removed. */
export function removeWord(words: readonly CaptionWord[], i: number) {
  return replaceRange(words, i, i + 1, '');
}

/** A new sentence starts at word `i`. */
export function splitAt(words: readonly CaptionWord[], i: number): CaptionWord[] {
  const w = withStarts(words);
  if (i > 0 && i < w.length) w[i].start = true;
  return w;
}

/** The sentence ending before word `to` joined with the next one. */
export function mergeWithNext(words: readonly CaptionWord[], to: number): CaptionWord[] {
  const w = withStarts(words);
  if (to > 0 && to < w.length) delete w[to].start;
  return w;
}

/** New times for some words (centiseconds), each kept at least MIN_WORD_CS long. */
export function setTimes(
  words: readonly CaptionWord[],
  changes: readonly { i: number; t0?: number; t1?: number }[],
): CaptionWord[] {
  const w = withStarts(words);
  for (const c of changes) {
    const x = w[c.i];
    if (!x) continue;
    if (c.t0 !== undefined) x.t0 = Math.round(c.t0);
    if (c.t1 !== undefined) x.t1 = Math.round(c.t1);
    if (x.t1 - x.t0 < MIN_WORD_CS) x.t1 = x.t0 + MIN_WORD_CS;
  }
  return w;
}

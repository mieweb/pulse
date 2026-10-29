import { linesFromWords } from './group-lines';
import type { TranscriptWord } from './whisper';

// Edits to a clip's words (in the file's time, centiseconds), as the editor makes them on its
// captions. Edited words carry where each sentence (a caption box) starts, `start`, so a split or
// a merge sticks instead of being regrouped: a clip's first edit freezes the sentences shown
// (`seedStarts`), and every edit here keeps the starts right.

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

/**
 * `words` with sentence starts where the editor shows its sentences: the starts already there;
 * else (the model's words, never edited) the shown sentences' first words (`froms`, ascending)
 * and the first word after the last shown one (`end`), the words outside them grouped on their
 * own. So a clip's first edit keeps the sentences on screen as they are (its trim and speed
 * decide how they were grouped).
 */
export function seedStarts(
  words: readonly CaptionWord[],
  froms: readonly number[],
  end: number,
): CaptionWord[] {
  const w = withStarts(words);
  if (words.some((x) => x.start) || !froms.length) return w;
  for (let k = froms[0]; k < Math.min(end, w.length); k++) delete w[k].start;
  for (const f of froms) if (w[f]) w[f].start = true;
  if (w[end]) w[end].start = true;
  return w;
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

/** Word `i` with new text over its time (several words if it's typed as several; none removes
 * it), starting a sentence if it did. */
export function replaceWordText(
  words: readonly CaptionWord[],
  i: number,
  text: string,
): CaptionWord[] {
  const w = withStarts(words);
  const t0 = w[i]?.t0 ?? 0;
  const t1 = w[i]?.t1 ?? t0;
  const made = spread(text, t0, t1);
  if (made.length && w[i]?.start) made[0].start = true;
  const rest = w.slice(i + 1);
  // The sentence's first word went with nothing in its place: the next word starts it.
  if (!made.length && w[i]?.start && rest.length && !rest[0].start) rest[0].start = true;
  return [...w.slice(0, i), ...made, ...rest];
}

/** Word `i` removed. */
export function removeWord(words: readonly CaptionWord[], i: number) {
  return replaceWordText(words, i, '');
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

/**
 * Word `i`'s new start or end (centiseconds). Only the edge asked for moves: it stays between the
 * words beside it in the clip (hidden ones too, which a wider trim shows again) and keeps the word
 * at least MIN_WORD_CS long (a word already shorter, at least as long as it is).
 */
export function setTimes(
  words: readonly CaptionWord[],
  i: number,
  t: { t0?: number; t1?: number },
): CaptionWord[] {
  const w = withStarts(words);
  const x = w[i];
  if (!x) return w;
  const min = Math.max(0, Math.min(MIN_WORD_CS, x.t1 - x.t0));
  if (t.t0 !== undefined) {
    x.t0 = Math.min(Math.max(Math.round(t.t0), w[i - 1]?.t1 ?? 0), x.t1 - min);
  }
  if (t.t1 !== undefined) {
    x.t1 = Math.max(Math.min(Math.round(t.t1), w[i + 1]?.t0 ?? Infinity), x.t0 + min);
  }
  return w;
}

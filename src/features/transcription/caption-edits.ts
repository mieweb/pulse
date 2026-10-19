import type { TranscriptWord } from './whisper';

// Edits to a clip's words (in the file's time, centiseconds), as the editor makes them on its
// captions: a line is a run of the clip's words (compose.ts `from` … `to`).

/** `text` as words spread over `t0` … `t1` by length (a longer word gets more of the time). */
function spread(text: string, t0: number, t1: number): TranscriptWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out: TranscriptWord[] = [];
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

/** The line `from` … `to` with new text over the same time (no text: the line goes). */
export function replaceLineText(
  words: readonly TranscriptWord[],
  from: number,
  to: number,
  text: string,
): TranscriptWord[] {
  const t0 = words[from]?.t0 ?? 0;
  const t1 = words[to - 1]?.t1 ?? t0;
  return [...words.slice(0, from), ...spread(text, t0, t1), ...words.slice(to)];
}

/** The line `from` … `to` removed. */
export function removeLine(
  words: readonly TranscriptWord[],
  from: number,
  to: number,
): TranscriptWord[] {
  return [...words.slice(0, from), ...words.slice(to)];
}

/** A new line of `text` over `t0` … `t1`, among the words in time order. */
export function insertLine(
  words: readonly TranscriptWord[],
  t0: number,
  t1: number,
  text: string,
): TranscriptWord[] {
  const at = words.findIndex((w) => w.t0 >= t0);
  const i = at < 0 ? words.length : at;
  return [...words.slice(0, i), ...spread(text, t0, t1), ...words.slice(i)];
}

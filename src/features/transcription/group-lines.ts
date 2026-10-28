import type { TranscriptLine, TranscriptWord } from './whisper';

// Caption-readability budget (Netflix/BBC-derived). A cue is one short, on-screen line that the
// overlay may wrap to at most two rows; keeping cues at ~42 chars gives punchy, karaoke-friendly
// captions that sync tightly with speech.
const MAX_LINE_CHARS = 42;
// Hard ceiling on a single cue's on-screen duration (centiseconds). 7s is the standard cap.
const MAX_DUR_CS = 700;

const SENTENCE_END = /[.!?…。！？]["')\]」』]?$/;

// Scripts written without spaces between words (Chinese, Japanese, Thai, Lao, Khmer, Burmese) and
// their punctuation. Their tokens are kept apart (each keeps its timing) and joined with no space.
const NO_SPACE =
  /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u3000-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFF9F]/;
/** A no-space-script character counts this much toward a line's width (about 16 a line). */
const WIDE_CHAR = 2.5;

/** What goes between two words in a caption: nothing next to a no-space script, else a space. */
export function wordGap(before: string, after: string): string {
  return NO_SPACE.test(before.slice(-1)) || NO_SPACE.test(after.charAt(0)) ? '' : ' ';
}

/** Words joined as a caption reads, without the stray space whisper leaves before punctuation. */
export function joinWords(words: readonly { text: string }[]): string {
  let out = '';
  for (let i = 0; i < words.length; i++) {
    out += (i > 0 ? wordGap(words[i - 1].text, words[i].text) : '') + words[i].text;
  }
  return out.replace(/\s+([,.!?;:…])/g, '$1').trim();
}

/** A word's width toward the line budget (a character, or WIDE_CHAR for a no-space script). */
export function widthOf(text: string): number {
  let w = 0;
  for (const ch of text) w += NO_SPACE.test(ch) ? WIDE_CHAR : 1;
  return w;
}

function flush(words: TranscriptWord[]): TranscriptLine {
  return { text: joinWords(words), t0: words[0].t0, t1: words[words.length - 1].t1, words };
}

/**
 * Whole words from `maxLen: 1` segments. whisper.rn doesn't split on words, so a segment is a
 * token: a word can come in pieces ("Jas|mine", "I|'m", "astronaut|.") and only a word's first
 * piece starts with a space. A piece without one continues the word before it. On the speech
 * bench (.devrun/whisper) taking pieces as words was most of the transcripts' errors. Scripts
 * without spaces never start a word with one, so their tokens stay apart, each with its timing.
 */
export function wholeWords(segments: TranscriptWord[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    // A piece continues the word before only where words are spaced (Latin "Jas|mine"); in
    // no-space scripts each token stays its own word, with its own timing.
    if (last && !/^\s/.test(seg.text) && wordGap(last.text, text)) {
      out[out.length - 1] = { text: last.text + text, t0: last.t0, t1: seg.t1 };
    } else {
      out.push({ text, t0: seg.t0, t1: seg.t1 });
    }
  }
  return out;
}

/**
 * Whole words (trimmed, centiseconds; see `wholeWords`) folded into caption-sized lines, each
 * carrying its `words[]` for word-level (karaoke) highlighting. A new line starts when the current
 * word ends a sentence, when appending the next word would exceed the character budget, or when
 * the cue would run past the max duration.
 */
export function linesFromWords(words: TranscriptWord[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let current: TranscriptWord[] = [];
  let chars = 0;

  for (const word of words) {
    const text = word.text;

    const gap = current.length ? wordGap(current[current.length - 1].text, text).length : 0;
    const wouldChars = chars + gap + widthOf(text);
    const wouldDur = current.length ? word.t1 - current[0].t0 : 0;
    if (current.length && (wouldChars > MAX_LINE_CHARS || wouldDur > MAX_DUR_CS)) {
      lines.push(flush(current));
      current = [];
      chars = widthOf(text);
    } else {
      chars = wouldChars;
    }
    current.push(word);

    if (SENTENCE_END.test(text)) {
      lines.push(flush(current));
      current = [];
      chars = 0;
    }
  }

  if (current.length) lines.push(flush(current));
  return lines;
}

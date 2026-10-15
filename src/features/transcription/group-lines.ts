import type { TranscriptLine, TranscriptWord } from './whisper';

// Caption-readability budget (Netflix/BBC-derived). A cue is one short, on-screen line that the
// overlay may wrap to at most two rows; keeping cues at ~42 chars gives punchy, karaoke-friendly
// captions that sync tightly with speech.
const MAX_LINE_CHARS = 42;
// Hard ceiling on a single cue's on-screen duration (centiseconds). 7s is the standard cap.
const MAX_DUR_CS = 700;

const SENTENCE_END = /[.!?…]["')\]]?$/;

/** Collapse the stray space whisper leaves before punctuation when words are joined (" ," → ","). */
function cueText(words: TranscriptWord[]): string {
  return words
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .trim();
}

function flush(words: TranscriptWord[]): TranscriptLine {
  return { text: cueText(words), t0: words[0].t0, t1: words[words.length - 1].t1, words };
}

/**
 * Whole words from `maxLen: 1` segments. whisper.rn doesn't split on words, so a segment is a
 * token: a word can come in pieces ("Jas|mine", "I|'m", "astronaut|.") and only a word's first
 * piece starts with a space. A piece without one continues the word before it. On the speech
 * bench (.devrun/whisper) taking pieces as words was most of the transcripts' errors.
 */
function wholeWords(segments: TranscriptWord[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && !/^\s/.test(seg.text)) {
      out[out.length - 1] = { text: last.text + text, t0: last.t0, t1: seg.t1 };
    } else {
      out.push({ text, t0: seg.t0, t1: seg.t1 });
    }
  }
  return out;
}

/**
 * Fold word-level whisper segments (from a `maxLen: 1` pass) into caption-sized lines, each
 * carrying its `words[]` for word-level (karaoke) highlighting. Pieces of a word are joined first
 * (see `wholeWords`). A new line starts when the
 * current word ends a sentence, when appending the next word would exceed the character budget,
 * or when the cue would run past the max duration. Word `text` is trimmed (whisper prefixes a
 * space); `t0`/`t1` stay in centiseconds.
 */
export function groupWordsIntoLines(segments: TranscriptWord[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let current: TranscriptWord[] = [];
  let chars = 0;

  for (const word of wholeWords(segments)) {
    const text = word.text;

    const wouldChars = chars + (current.length ? 1 : 0) + text.length;
    const wouldDur = current.length ? word.t1 - current[0].t0 : 0;
    if (current.length && (wouldChars > MAX_LINE_CHARS || wouldDur > MAX_DUR_CS)) {
      lines.push(flush(current));
      current = [];
      chars = 0;
    }

    current.push(word);
    chars += (current.length > 1 ? 1 : 0) + text.length;

    if (SENTENCE_END.test(text)) {
      lines.push(flush(current));
      current = [];
      chars = 0;
    }
  }

  if (current.length) lines.push(flush(current));
  return lines;
}

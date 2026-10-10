import type { TranscriptLine, TranscriptWord } from './whisper';

// Caption-readability budget (Netflix/BBC-derived). A cue is one short, on-screen line that the
// overlay may wrap to at most two rows; keeping cues at ~42 chars gives punchy, karaoke-friendly
// captions that sync tightly with speech.
const MAX_LINE_CHARS = 42;
// Hard ceiling on a single cue's on-screen duration (centiseconds). 7s is the standard cap.
const MAX_DUR_CS = 700;

// Western and CJK (。！？) sentence ends, optionally followed by a closing quote or bracket.
const SENTENCE_END = /[.!?…。！？]["')\]」』]?$/;

// Punctuation that hugs the word before it (whisper emits it as its own token: "Hello", ",").
const CLOSING = /^[,.!?;:…%)\]」』。、！？，：；）】》〉]/;
// Hiragana, katakana, CJK ideographs, CJK punctuation (、。「」) and full-width forms (，：！):
// written without spaces between them.
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;

/**
 * Whether a space goes between two caption words when they're joined for display: none before
 * closing punctuation ("Hello," not "Hello ,") and none between two CJK characters ("我们", not
 * "我 们"). Every place that renders words in sequence (the cue text, the karaoke row, the
 * on-video overlay) uses this, so they all read the same.
 */
export function spaceBefore(prev: string, word: string): boolean {
  if (!prev || !word) return false;
  if (CLOSING.test(word)) return false;
  return !(CJK.test(prev[prev.length - 1]) && CJK.test(word[0]));
}

/** Join caption words into display text with `spaceBefore`'s spacing. */
export function joinWords(words: string[]): string {
  let text = '';
  for (const word of words) text += (spaceBefore(text, word) ? ' ' : '') + word;
  return text;
}

function cueText(words: TranscriptWord[]): string {
  return joinWords(words.map((w) => w.text)).trim();
}

function flush(words: TranscriptWord[]): TranscriptLine {
  return { text: cueText(words), t0: words[0].t0, t1: words[words.length - 1].t1, words };
}

/**
 * Fold word-level whisper segments (from a `maxLen: 1` pass) into caption-sized lines, each
 * carrying its `words[]` for word-level (karaoke) highlighting. A new line starts when the
 * current word ends a sentence, when appending the next word would exceed the character budget,
 * or when the cue would run past the max duration. Word `text` is trimmed (whisper prefixes a
 * space); `t0`/`t1` stay in centiseconds.
 */
export function groupWordsIntoLines(segments: TranscriptWord[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let current: TranscriptWord[] = [];
  let chars = 0;

  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const word: TranscriptWord = { text, t0: seg.t0, t1: seg.t1 };

    const prev = current.length ? current[current.length - 1].text : '';
    const gap = spaceBefore(prev, text) ? 1 : 0;
    const wouldChars = chars + gap + text.length;
    const wouldDur = current.length ? seg.t1 - current[0].t0 : 0;
    if (current.length && (wouldChars > MAX_LINE_CHARS || wouldDur > MAX_DUR_CS)) {
      lines.push(flush(current));
      current = [];
      chars = 0;
    }

    // A flush above starts a fresh line, so the gap only counts when the word joins `prev`.
    chars += (current.length ? gap : 0) + text.length;
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

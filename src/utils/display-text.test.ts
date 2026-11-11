import { describe, expect, it } from '@jest/globals';

import { cleanDisplayText, codePointLength, cutToFit, graphemes } from './display-text';

const cp = String.fromCodePoint;
const ZWJ = cp(0x200d);

describe('codePointLength', () => {
  it('counts characters as the protocol does: code points, not UTF-16 units', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('😀é☕')).toBe(3);
    expect(codePointLength('😀'.repeat(200))).toBe(200);
    // A lone surrogate half is one.
    expect(codePointLength('😀'.slice(0, 1) + 'a')).toBe(2);
  });
});

describe('graphemes', () => {
  // Hermes has no Intl.Segmenter, so the app splits by its own rules; Node has one to check against.
  const reference = (text: string) =>
    Array.from(new Intl.Segmenter().segment(text), (s) => s.segment);

  it('splits text into the characters a person sees, as Intl.Segmenter does', () => {
    for (const text of [
      'plain text',
      'café au lait',
      `cafe${cp(0x301)} with a combining accent`,
      `a${cp(0x300)}${cp(0x301)}${cp(0x302)}b`,
      '😀😃👍🏽👍',
      ['👨', '👩', '👧', '👦'].join(ZWJ) + ' family',
      `🏳${cp(0xfe0f)}${ZWJ}🌈 flag`,
      '🇫🇷🇩🇪🇯🇵 flags',
      '🇫🇷🇩 an odd one out',
      `1${cp(0xfe0f)}${cp(0x20e3)} keycap`,
      `🏴${[0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f].map((c) => cp(c)).join('')} Scotland`,
      '한국어 텍스트',
      `${cp(0x1112)}${cp(0x1161)}${cp(0x11ab)} jamo`,
      '日本語のテキスト',
      'العربية نص',
      `e${ZWJ}x`,
      // Thai and Lao: the vowel sign AM stays with its consonant, like any vowel or tone mark.
      `${cp(0xe01, 0xe33)}${cp(0xe19, 0xe49, 0xe33)} ${cp(0xe04, 0xe33)}`,
      `${cp(0xe99, 0xec9, 0xeb3)} ${cp(0xe81, 0xeb3)}`,
      '',
    ]) {
      expect(graphemes(text)).toEqual(reference(text));
    }
  });

  it('never cuts a Thai name between a consonant and its vowel', () => {
    const nam = cp(0xe19, 0xe49, 0xe33); // "water": consonant, tone mark, vowel sign AM
    expect(cutToFit(nam + nam, (candidate) => Array.from(candidate).length <= 5)).toBe(nam);
  });
});

describe('cutToFit', () => {
  it('keeps the longest start that fits, in whole characters', () => {
    const short = (max: number) => (candidate: string) => candidate.length <= max;
    expect(cutToFit('hello', short(10))).toBe('hello');
    expect(cutToFit('hello', short(3))).toBe('hel');
    expect(cutToFit('ab😀cd', short(3))).toBe('ab');
    expect(cutToFit('ab😀cd', short(4))).toBe('ab😀');
    expect(cutToFit(`e${cp(0x301)}e${cp(0x301)}`, short(3))).toBe(`e${cp(0x301)}`);
    expect(cutToFit('😀', short(1))).toBe('');
  });
});

describe('cleanDisplayText', () => {
  it('leaves an ordinary name alone, trimmed', () => {
    expect(cleanDisplayText('  Team · Huddle  ', 60)).toBe('Team · Huddle');
    expect(cleanDisplayText('日本語 ☕ café', 60)).toBe('日本語 ☕ café');
  });

  it('is absent when there is nothing to see', () => {
    for (const blank of [null, undefined, '', '   ', '\n', cp(0x200b), cp(0x202e) + cp(0xfeff)]) {
      expect(cleanDisplayText(blank, 60)).toBeNull();
    }
    // What shows as nothing without being a space or a format character: a variation selector
    // or accents with no letter, the Hangul fillers, the blank Braille pattern.
    for (const blank of [
      cp(0xfe0f),
      cp(0x301, 0x301),
      cp(0x3164, 0x115f, 0x1160, 0xffa0),
      cp(0x2800),
      ` ${cp(0x2800)} ${cp(0xfe0f)} `,
    ]) {
      expect(cleanDisplayText(blank, 60)).toBeNull();
    }
    // With something to see, the same characters stay where they were.
    expect(cleanDisplayText(`${cp(0x2764, 0xfe0f)} e${cp(0x301)}`, 60)).toBe(
      `${cp(0x2764, 0xfe0f)} e${cp(0x301)}`,
    );
    // Blank once cut, as the builder treats it: one character of 500 accents is none of 60.
    expect(cleanDisplayText(`a${cp(0x301).repeat(500)}`, 60)).toBeNull();
  });

  it('cleans exactly the characters the protocol names', () => {
    // Every control character (C0, DEL, C1) and the two Unicode line separators become a space;
    // every bidirectional-formatting character is dropped. Checked over all of Unicode against
    // the properties themselves.
    const controls: number[] = [];
    const bidi: number[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = cp(code);
      if (/\p{Cc}/u.test(char) || code === 0x2028 || code === 0x2029) controls.push(code);
      else if (/\p{Bidi_Control}/u.test(char)) bidi.push(code);
    }
    expect(controls).toHaveLength(67);
    expect(bidi.map((c) => c.toString(16))).toEqual([
      '61c',
      '200e',
      '200f',
      '202a',
      '202b',
      '202c',
      '202d',
      '202e',
      '2066',
      '2067',
      '2068',
      '2069',
    ]);
    for (const code of controls) expect(cleanDisplayText(`a${cp(code)}b`, 60)).toBe('a b');
    for (const code of bidi) expect(cleanDisplayText(`a${cp(code)}b`, 60)).toBe('ab');
  });

  it('a run of control characters is one space, and one at an end is trimmed', () => {
    expect(cleanDisplayText('a\r\n\t\u0000b\n', 60)).toBe('a b');
  });

  it('cuts a longer text to the limit in code points, never through a character', () => {
    expect(cleanDisplayText('x'.repeat(61), 60)).toBe('x'.repeat(60));
    expect(cleanDisplayText('😀'.repeat(61), 60)).toBe('😀'.repeat(60));
    const family = ['👨', '👩', '👧', '👦'].join(ZWJ);
    expect(cleanDisplayText('x'.repeat(58) + family, 60)).toBe('x'.repeat(58));
    // Cut after a space: the space goes too.
    expect(cleanDisplayText('x'.repeat(59) + ' yz', 60)).toBe('x'.repeat(59));
    // One "character" too long for the limit by itself leaves nothing to show.
    expect(cleanDisplayText('e' + cp(0x301).repeat(80), 60)).toBeNull();
  });
});

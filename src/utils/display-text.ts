/**
 * Text that arrives from outside the app (a link's naming hints, PROTOCOL.md §3.1), made safe to
 * show on one line, and counted the way the protocol counts: in Unicode code points.
 */

/** A string's length in characters as the protocol counts them: Unicode code points. */
export function codePointLength(text: string): number {
  let length = 0;
  // A pair of surrogates is one code point; a lone half counts as one.
  for (let i = 0; i < text.length; i += text.codePointAt(i)! > 0xffff ? 2 : 1) length += 1;
  return length;
}

// What attaches to the character before it: combining and spacing marks, variation selectors,
// skin tones, tag characters, and the joiner of an emoji sequence.
const EXTENDS = /^[\p{Grapheme_Extend}\p{Mc}\p{Emoji_Modifier}\u{200D}]$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const REGIONAL_INDICATOR = /^\p{Regional_Indicator}$/u;
const ZERO_WIDTH_JOINER = '\u{200D}';

/** A Hangul syllable part: leading consonant, vowel, trailing consonant, or a whole syllable. */
function hangul(char: string): 'L' | 'V' | 'T' | 'LV' | 'LVT' | null {
  const cp = char.codePointAt(0)!;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c)) return 'L';
  if ((cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6)) return 'V';
  if ((cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)) return 'T';
  if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 === 0 ? 'LV' : 'LVT';
  return null;
}

function hangulJoins(before: string, after: string): boolean {
  const a = hangul(before);
  const b = hangul(after);
  if (!a || !b) return false;
  if (a === 'L') return b !== 'T';
  if (a === 'LV' || a === 'V') return b === 'V' || b === 'T';
  return b === 'T';
}

/**
 * The text as the characters a person sees: an emoji sequence (a family, a flag, a skin tone), a
 * letter with its accents or a Hangul syllable is one, however many code points it takes. The
 * rules of Unicode's grapheme clusters (UAX #29) that matter for cutting a name, written out
 * because Hermes has no `Intl.Segmenter`. Where it differs from the full rules (a few Indic
 * conjuncts), it cuts between whole code points all the same.
 */
export function graphemes(text: string): string[] {
  const clusters: string[] = [];
  let current = '';
  let last = '';
  // Flags are pairs of regional indicators: an odd one out starts the next pair.
  let indicators = 0;
  for (const char of text) {
    const joins =
      current !== '' &&
      (EXTENDS.test(char) ||
        (last === ZERO_WIDTH_JOINER && PICTOGRAPH.test(char)) ||
        (REGIONAL_INDICATOR.test(char) && indicators === 1 && REGIONAL_INDICATOR.test(last)) ||
        hangulJoins(last, char));
    if (joins) {
      current += char;
    } else {
      if (current !== '') clusters.push(current);
      current = char;
      indicators = 0;
    }
    if (REGIONAL_INDICATOR.test(char)) indicators += 1;
    last = char;
  }
  if (current !== '') clusters.push(current);
  return clusters;
}

/**
 * The longest start of `text`, in whole characters as a person sees them (`graphemes`), that
 * `fits`: never half an emoji or a letter without its accent.
 */
export function cutToFit(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  let cut = '';
  for (const cluster of graphemes(text)) {
    if (!fits(cut + cluster)) break;
    cut += cluster;
  }
  return cut;
}

/** Nothing a person can see: only spaces and invisible formatting characters. */
const BLANK = /^[\s\p{Cf}]*$/u;

/**
 * A host-supplied name as one line of plain text, at most `max` characters (code points), or
 * `null` when there's nothing to show. The same cleaning PulseVault's `buildUploadLink` does, done
 * again here because a link can be built by anyone: control characters and line breaks become a
 * space, bidirectional-formatting characters (which can reorder the text shown around them) are
 * dropped, and a longer text is cut at a whole character.
 */
export function cleanDisplayText(raw: string | null | undefined, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .replace(/[\p{Cc}\u{2028}\u{2029}]+/gu, ' ')
    .replace(/\p{Bidi_Control}/gu, '')
    .trim();
  if (BLANK.test(text)) return null;
  const cut = cutToFit(text, (candidate) => codePointLength(candidate) <= max).trim();
  return BLANK.test(cut) ? null : cut;
}

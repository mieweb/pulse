import { Accent } from '@/constants/theme';

/**
 * How captions look, as data in units of the picture, so the editor's preview, the export's
 * preview and a render onto the exported frames (burn-in) all draw the same caption at their own
 * size. Lengths are multiples of the text size; the text size is a fraction of the picture's
 * height. Colors are `#RRGGBBAA`.
 */
export type CaptionStyle = {
  /** The typeface: a font bundled with the app (assets/fonts), the same on every platform. */
  font: 'inter-extrabold';
  /** Text size, as a fraction of the picture's height. */
  size: number;
  /** Line height, as a multiple of the text size. */
  lineHeight: number;
  /** Words already spoken, the word being spoken, and words still to come. */
  color: string;
  activeColor: string;
  futureColor: string;
  /** The spoken word's size, as a multiple of the text's (a small pop). */
  activeScale: number;
  /** A dark edge round each letter (its width a multiple of the text size; 0: none). */
  outline: number;
  outlineColor: string;
  /** A soft shadow under the text: its blur and drop (multiples of the text size), and color. */
  shadowBlur: number;
  shadowDrop: number;
  shadowColor: string;
  /** A box behind the text (off by default: the outline reads on any picture): its color,
   * padding across and down, and corner radius. */
  box: boolean;
  background: string;
  padX: number;
  padY: number;
  radius: number;
  /** The least room kept between the text and the picture's sides. */
  margin: number;
  /** Where the caption's centre sits: a fraction of the picture's height (0 top, 1 bottom). */
  y: number;
};

/** How far up or down captions can be moved (their centre, as a fraction of the height). */
export const CAPTION_Y_MIN = 0.1;
export const CAPTION_Y_MAX = 0.9;

/** The captions' look: Inter ExtraBold in white with a dark outline and a soft shadow, no box,
 * the spoken word in the app's accent and a touch larger. */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  font: 'inter-extrabold',
  size: 0.034,
  lineHeight: 1.25,
  color: '#FFFFFFFF',
  activeColor: `${Accent}FF`,
  futureColor: '#FFFFFFFF',
  activeScale: 1.04,
  outline: 0.055,
  outlineColor: '#000000E6',
  shadowBlur: 0.12,
  shadowDrop: 0.06,
  shadowColor: '#00000099',
  box: false,
  background: '#00000099',
  padX: 0.5,
  padY: 0.25,
  radius: 0.4,
  margin: 0.7,
  y: 0.82,
};

/** A draft's caption style: the default look, at the place the captions were moved to. */
export function captionStyleFor(y: number | null | undefined): CaptionStyle {
  return y == null ? DEFAULT_CAPTION_STYLE : { ...DEFAULT_CAPTION_STYLE, y };
}

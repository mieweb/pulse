import { Accent } from '@/constants/theme';

/**
 * How captions look, as data in units of the picture, so the editor's preview, the export's
 * preview and a render onto the exported frames (burn-in) all draw the same caption at their own
 * size. Lengths are multiples of the text size; the text size is a fraction of the picture's
 * height. Colors are `#RRGGBBAA`.
 */
export type CaptionStyle = {
  /** Text size, as a fraction of the picture's height. */
  size: number;
  /** Line height, as a multiple of the text size. */
  lineHeight: number;
  /** Font weight (the platform's bold system font until a bundled font is chosen). */
  weight: 700;
  /** Words already spoken, the word being spoken, and words still to come. */
  color: string;
  activeColor: string;
  futureColor: string;
  /** The box behind the text: its color, padding across and down, and corner radius. */
  background: string;
  padX: number;
  padY: number;
  radius: number;
  /** The least room kept between the box and the picture's sides. */
  margin: number;
  /** Where the caption's centre sits: a fraction of the picture's height (0 top, 1 bottom). */
  y: number;
};

/** How far up or down captions can be moved (their centre, as a fraction of the height). */
export const CAPTION_Y_MIN = 0.1;
export const CAPTION_Y_MAX = 0.9;

/** The captions' look until it can be changed: bold white on a dark box, spoken word in accent. */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  size: 0.031,
  lineHeight: 1.3,
  weight: 700,
  color: '#FFFFFFFF',
  activeColor: `${Accent}FF`,
  futureColor: '#FFFFFF73',
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

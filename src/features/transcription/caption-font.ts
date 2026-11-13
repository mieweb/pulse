import {
  matchFont,
  Skia,
  useTypeface,
  type SkFont,
  type SkTypeface,
} from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import { Platform } from 'react-native';

import type { CaptionStyle } from './caption-style';

// The captions' typefaces, bundled with the app (assets/fonts, SIL Open Font License), so the
// caption is drawn the same on iOS, Android and onto exported frames.
const FONTS: Record<CaptionStyle['font'], number> = {
  'inter-extrabold': require('../../../assets/fonts/Inter-ExtraBold.ttf'),
};

/** Typefaces loaded so far (once per app run, so a caption shown again draws in it at once). */
const typefaces = new Map<CaptionStyle['font'], SkTypeface>();

/** The caption's font at `size` (dp): the bundled one once loaded, the system's bold until then. */
export function useCaptionFont(font: CaptionStyle['font'], size: number): SkFont {
  const known = typefaces.get(font) ?? null;
  const loaded = useTypeface(known ? null : FONTS[font]);
  useEffect(() => {
    if (loaded) typefaces.set(font, loaded);
  }, [font, loaded]);
  const typeface = known ?? loaded;
  return useMemo(
    () =>
      typeface
        ? Skia.Font(typeface, size)
        : matchFont({
            fontFamily: Platform.select({ ios: 'Helvetica Neue', default: 'sans-serif' }),
            fontSize: size,
            fontWeight: '800',
          }),
    [typeface, size],
  );
}

/**
 * How far `text` advances at `font` (dp): the sum of its glyphs' advances, which is what
 * drawText moves by. (`getTextWidth` came out short for Inter, ~4% on a long word, so words
 * placed by it ran into the spaces after them.)
 */
export function advance(font: SkFont, text: string): number {
  if (!text) return 0;
  let w = 0;
  for (const g of font.getGlyphWidths(font.getGlyphIDs(text))) w += g;
  return w;
}

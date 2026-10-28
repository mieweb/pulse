import {
  matchFont,
  Skia,
  useTypeface,
  type FontWeight,
  type SkFont,
  type SkPaint,
  type SkParagraph,
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

/** Whether `font` has no glyph for some character of `text` (Inter has no Chinese, Japanese,
 * Arabic, Thai or emoji): drawText would draw boxes, so such text is drawn by `fallbackText`. */
export function lacksGlyphs(font: SkFont, text: string): boolean {
  return font.getGlyphIDs(text).includes(0);
}

/**
 * `text` laid out on one line in the system's fonts, as a paragraph per paint in `paints` (a paint
 * can't be swapped once a paragraph is built). A paragraph picks a font per character (Skia's
 * font fallback), which a single SkFont can't. Drawn with `by[key].paint(canvas, x, y - baseline)`
 * for a baseline at `y`; `width` is its advance.
 */
export type FallbackText<K extends string> = {
  width: number;
  baseline: number;
  by: Record<K, SkParagraph>;
};

// Built once per text, size, weight and set of paints (a caption shown again reuses them).
const fallbacks = new WeakMap<object, Map<string, FallbackText<string>>>();

export function fallbackText<K extends string>(
  text: string,
  size: number,
  weight: FontWeight,
  paints: Record<K, SkPaint>,
  keys: readonly K[],
): FallbackText<K> {
  let cache = fallbacks.get(paints);
  if (!cache) fallbacks.set(paints, (cache = new Map()));
  const id = `${size}|${weight}|${text}`;
  const known = cache.get(id);
  if (known) return known as FallbackText<K>;
  const by = {} as Record<K, SkParagraph>;
  for (const k of keys) {
    const p = Skia.ParagraphBuilder.Make({ maxLines: 1 })
      .pushStyle({ fontSize: size, fontStyle: { weight } }, paints[k])
      .addText(text)
      .build();
    p.layout(1e6);
    by[k] = p;
  }
  const first = by[keys[0]];
  const made = {
    width: first.getLongestLine(),
    baseline: first.getLineMetrics()[0]?.baseline ?? size,
    by,
  };
  cache.set(id, made);
  return made;
}

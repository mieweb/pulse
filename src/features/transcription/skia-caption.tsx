import {
  BlurStyle,
  Canvas,
  PaintStyle,
  Picture,
  Skia,
  StrokeJoin,
} from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { advance, useCaptionFont } from './caption-font';
import { CAPTION_Y_MAX, CAPTION_Y_MIN, type CaptionStyle } from './caption-style';
import { captionRows } from './caption-track';
import { wordGap } from './group-lines';
import type { TranscriptLine } from './whisper';

// The caption on the video, drawn with Skia: the style (caption-style.ts) and the rows decided in
// JS (caption-track.ts), so what's drawn here is what a burn-in at export draws. The line under
// the playhead, the word being spoken and where the caption sits are all worked out on the UI
// thread, so playback never re-renders React for it; the caption is redrawn only when one of
// them changes.

/** One word as drawn: the space before it and its text, with their widths at the font (dp). */
type DrawnWord = { lead: string; text: string; t0: number; t1: number; lw: number; tw: number };
/** One caption, ready to draw: its rows of words, and the widest row's width. */
type DrawnLine = { t0: number; t1: number; rows: DrawnWord[][]; widths: number[]; widest: number };

const clampW = (v: number, lo: number, hi: number) => {
  'worklet';
  return Math.min(hi, Math.max(lo, v));
};

/** The caption's box on the picture (dp) for line `line`, at `y` (the box's centre). */
function boxOf(
  line: DrawnLine,
  y: number,
  w: number,
  h: number,
  size: number,
  style: CaptionStyle,
  scale: number,
) {
  'worklet';
  const padX = style.padX * size * scale;
  const padY = style.padY * size * scale;
  const lh = style.lineHeight * size * scale;
  const bw = line.widest * scale + padX * 2;
  const bh = line.rows.length * lh + padY * 2;
  const cy = clampW(y * h, bh / 2, h - bh / 2);
  return { x: (w - bw) / 2, y: cy - bh / 2, w: bw, h: bh, padX, padY, lh };
}

type Props = {
  lines: readonly TranscriptLine[];
  /** Playback time, ms (UI thread). */
  timeMs: SharedValue<number>;
  style: CaptionStyle;
  /** The picture's size, dp. */
  width: number;
  height: number;
  /** Drag to move (`onMove` with the new centre, a fraction of the height) and tap; omitted: a
   * caption that only shows. */
  onPickUp?: () => void;
  /** (If what it returns fails, the caption goes back to the style's place.) */
  onMove?: (y: number) => Promise<unknown> | void;
  onTap?: () => void;
};

export function SkiaCaption({
  lines,
  timeMs,
  style,
  width,
  height,
  onPickUp,
  onMove,
  onTap,
}: Props) {
  const size = Math.max(6, Math.round(style.size * height));
  const font = useCaptionFont(style.font, size);
  const outlineGap = style.outline * size * 2;
  // Rows and word widths measured once per change of the captions (or the font).
  const drawn = useMemo<DrawnLine[]>(
    () =>
      lines.map((line) => {
        const rows = captionRows(line).map((row) =>
          row.map((w, i) => {
            const lead = i > 0 ? wordGap(row[i - 1].text, w.text) : '';
            return {
              lead,
              text: w.text,
              t0: w.t0,
              t1: w.t1,
              // The space, widened by what the outline covers of it on both words' sides, so
              // the gap between outlined words reads as an ordinary space.
              lw: lead ? advance(font, lead) + outlineGap : 0,
              tw: advance(font, w.text),
            };
          }),
        );
        const widths = rows.map((r) => r.reduce((n, w) => n + w.lw + w.tw, 0));
        return { t0: line.t0, t1: line.t1, rows, widths, widest: Math.max(0, ...widths) };
      }),
    [lines, font, outlineGap],
  );
  const metrics = useMemo(() => font.getMetrics(), [font]);
  const paints = useMemo(() => {
    const p = (c: string) => {
      const x = Skia.Paint();
      x.setAntiAlias(true);
      x.setColor(Skia.Color(c));
      return x;
    };
    // The outline: a stroke round each letter, half of it outside, `outline` × size wide there.
    const outline = p(style.outlineColor);
    outline.setStyle(PaintStyle.Stroke);
    outline.setStrokeWidth(style.outline * size * 2);
    outline.setStrokeJoin(StrokeJoin.Round);
    // The shadow: the text blurred, a little below it (the blur follows the drawing's scale).
    const shadow = p(style.shadowColor);
    shadow.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, style.shadowBlur * size, true));
    return {
      bg: p(style.background),
      spoken: p(style.color),
      active: p(style.activeColor),
      future: p(style.futureColor),
      outline,
      shadow,
    };
  }, [style, size]);

  const model = useSharedValue<DrawnLine[]>(drawn);
  useEffect(() => {
    model.set(drawn);
  }, [drawn, model]);
  // Where the caption sits: the style's place, or where a drag has it.
  const yv = useSharedValue(style.y);
  const dragging = useSharedValue(false);
  useEffect(() => {
    if (!dragging.get()) yv.set(style.y);
  }, [style.y, yv, dragging]);

  /** The line under the playhead (binary search), or -1. */
  const lineIndex = useDerivedValue(() => {
    const ls = model.get();
    const pos = timeMs.get() / 10;
    let lo = 0;
    let hi = ls.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pos < ls[mid].t0) hi = mid - 1;
      // Half-open (up to, not including, its end): where two touch, the later one shows.
      else if (pos >= ls[mid].t1) lo = mid + 1;
      else return mid;
    }
    return -1;
  });

  /** The word to highlight in that line (counted across its rows): the one under the playhead,
   * else the last one started; -1 with no line. */
  const activeWord = useDerivedValue(() => {
    const i = lineIndex.get();
    const ls = model.get();
    if (i < 0 || i >= ls.length) return -1;
    const pos = timeMs.get() / 10;
    const rows = ls[i].rows;
    let active = -1;
    let n = 0;
    for (let r = 0; r < rows.length; r++) {
      for (let k = 0; k < rows[r].length; k++) {
        if (pos >= rows[r][k].t0) active = n;
        n++;
      }
    }
    return active;
  });

  // A row wider than the picture's room shrinks, the whole caption with it.
  const room = width - style.margin * size * 2 - style.padX * size * 2;

  const picture = useDerivedValue(() => {
    const rec = Skia.PictureRecorder();
    const c = rec.beginRecording(Skia.XYWHRect(0, 0, width, height));
    const i = lineIndex.get();
    const ls = model.get();
    if (i >= 0 && i < ls.length) {
      const line = ls[i];
      const scale = line.widest > room && line.widest > 0 ? room / line.widest : 1;
      const b = boxOf(line, yv.get(), width, height, size, style, scale);
      if (style.box) {
        const r = style.radius * size * scale;
        c.drawRRect(Skia.RRectXY(Skia.XYWHRect(b.x, b.y, b.w, b.h), r, r), paints.bg);
      }
      const active = activeWord.get();
      // Baseline of each row: centred in its line height by the font's ascent and descent.
      const ascent = -metrics.ascent * scale;
      const descent = metrics.descent * scale;
      // Three passes over the words, as outlined captions are drawn: every shadow, then every
      // outline, then every word's fill on top. A word's outline never covers its neighbour's
      // letters, so the spaces keep the font's own width.
      for (let pass = 0; pass < 3; pass++) {
        if (pass === 0 && !(style.shadowBlur > 0)) continue;
        if (pass === 1 && !(style.outline > 0)) continue;
        let at = 0;
        for (let r = 0; r < line.rows.length; r++) {
          const row = line.rows[r];
          const rowTop = b.y + b.padY + r * b.lh;
          const baseline = rowTop + (b.lh - (ascent + descent)) / 2 + ascent;
          let x = (width - line.widths[r] * scale) / 2;
          for (let k = 0; k < row.length; k++) {
            const w = row[k];
            x += w.lw * scale;
            const isActive = at === active;
            // The spoken word a touch larger, about its own middle (the line doesn't move).
            const pop = isActive ? style.activeScale : 1;
            c.save();
            c.translate(x + (w.tw * scale) / 2, baseline);
            c.scale(scale * pop, scale * pop);
            c.translate(-w.tw / 2, 0);
            if (pass === 0) c.drawText(w.text, 0, style.shadowDrop * size, paints.shadow, font);
            else if (pass === 1) c.drawText(w.text, 0, 0, paints.outline, font);
            else {
              const paint = isActive ? paints.active : at < active ? paints.spoken : paints.future;
              c.drawText(w.text, 0, 0, paint, font);
            }
            c.restore();
            x += w.tw * scale;
            at++;
          }
        }
      }
    }
    return rec.finishRecordingAsPicture();
  });

  // The touch area: the caption's box, wherever it's drawn (none while no line shows).
  const touch = useAnimatedStyle(() => {
    const i = lineIndex.get();
    const ls = model.get();
    if (i < 0 || i >= ls.length) return { left: 0, top: 0, width: 0, height: 0 };
    const line = ls[i];
    const scale = line.widest > room && line.widest > 0 ? room / line.widest : 1;
    const b = boxOf(line, yv.get(), width, height, size, style, scale);
    return { left: b.x, top: b.y, width: b.w, height: b.h };
  });

  const interactive = !!(onMove || onTap);
  const from = useSharedValue(0);
  const callbacks = useMemo(
    () => ({
      pickUp: () => onPickUp?.(),
      move: (v: number) => {
        void Promise.resolve(onMove?.(v)).catch(() => yv.set(style.y));
      },
      tap: () => onTap?.(),
    }),
    [onPickUp, onMove, onTap, yv, style.y],
  );
  const { pickUp, move, tap } = callbacks;
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .activeOffsetY([-6, 6])
      .onStart(() => {
        dragging.set(true);
        from.set(yv.get());
        scheduleOnRN(pickUp);
      })
      .onUpdate((e) => {
        if (height > 0)
          yv.set(clampW(from.get() + e.translationY / height, CAPTION_Y_MIN, CAPTION_Y_MAX));
      })
      .onEnd(() => {
        scheduleOnRN(move, yv.get());
      })
      .onFinalize(() => {
        dragging.set(false);
      });
    const press = Gesture.Tap()
      .maxDistance(10)
      .onEnd(() => {
        scheduleOnRN(tap);
      });
    return Gesture.Exclusive(pan, press);
  }, [dragging, from, yv, height, pickUp, move, tap]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        <Picture picture={picture} />
      </Canvas>
      {interactive && (
        <GestureDetector gesture={gesture}>
          {/* Takes the touch from the preview under it, so a drag or a tap never plays or pauses. */}
          <Animated.View
            style={[styles.touch, touch]}
            onStartShouldSetResponder={() => true}
            accessibilityRole="button"
            accessibilityLabel="Caption"
            accessibilityHint="Edits the captions. Drag up or down to move them."
          />
        </GestureDetector>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  touch: { position: 'absolute' },
});

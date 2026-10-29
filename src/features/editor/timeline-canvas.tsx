import {
  Canvas,
  ClipOp,
  FilterMode,
  FontWeight,
  matchFont,
  MipmapMode,
  PaintStyle,
  Picture,
  Skia,
  type SkCanvas,
  type SkFont,
  type SkImage,
  type SkPaint,
} from '@shopify/react-native-skia';
import { File } from 'expo-file-system';
import { useEffect, useMemo } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { Accent } from '@/constants/theme';

import {
  FILM_HEIGHT,
  TILE_GAP,
  TILE_HEIGHT,
  TILE_RADIUS,
  type TileMotion,
  type TilePalette,
} from './clip-tile';
import { CAP_GRIP, rulerSteps } from './timeline-geometry';
import { PEAK_MS, type Peaks } from './use-waveforms';
import {
  advance,
  fallbackText,
  lacksGlyphs,
  type FallbackText,
} from '@/features/transcription/caption-font';

// The timeline's picture, drawn by the GPU: every clip's filmstrip and waveform, the captions
// lane and the time ruler, recorded on the UI thread each frame from the playhead, the scale and
// the trim in progress. So scrubbing, flinging, playing and pinching never re-render React: it
// re-renders only when what's drawn changes (an edit, frames landing, a caption change). The
// clips' outlines, edit cues, the selection frame and the gestures stay views over it.

const WAVE_TOP = FILM_HEIGHT + 2;
const WAVE_HEIGHT = TILE_HEIGHT - WAVE_TOP;
/** One waveform line per this many dp. */
const WAVE_STEP = 2;

/** Stored level (0–255 over -48…0 dBFS) → display height 0–1, as clip-tile drew it. */
const LEVELS = Array.from({ length: 256 }, (_, l) =>
  l === 0 ? 0 : Math.pow(Math.pow(10, ((l / 255) * 48 - 48) / 20), 0.6),
);

/** What the canvas draws of one clip. Times in ms; `frameTimes` sorted, `frameImages` beside it. */
export type CanvasClip = {
  inMs: number;
  speed: number;
  sourceMs: number;
  muted: boolean;
  peaks: Peaks | null;
  /** The clip's cover, already drawn with its edit (or the last one, while a new one decodes). */
  cover: SkImage | null;
  /** A filmstrip tile's width (dp): the picture's shape as edited, FILM_HEIGHT tall. */
  tileW: number;
  /** The file's own frames (unedited), by the time each shows. */
  frameTimes: number[];
  frameImages: SkImage[];
  /** The edit drawn on the frames: clockwise quarter turns, a horizontal flip, then the crop
   * (normalized in the turned, flipped picture). */
  turns: number;
  flipped: boolean;
  crop: { x: number; y: number; w: number; h: number } | null;
};

/** A caption on the lane, timeline centiseconds; its words when it has them. */
export type CanvasCaption = {
  t0: number;
  t1: number;
  text: string;
  words?: readonly { text: string; t0: number; t1: number }[];
};

/** The paints the lane's text is drawn with. */
const TEXT_PAINTS = ['text', 'activeText'] as const;
/** Text the lane's font can't draw (Chinese, Arabic, emoji…), as paragraphs in the system's fonts. */
type LaneFallback = FallbackText<(typeof TEXT_PAINTS)[number]> | null;

/** A caption as drawn: its words always a list (empty without word timing), each with its text's
 * width at the lane's font (dp), for centring it in its slot. */
type DrawnCaption = {
  t0: number;
  t1: number;
  text: string;
  fb: LaneFallback;
  words: readonly { text: string; t0: number; t1: number; w: number; fb: LaneFallback }[];
};

/** `text` with its baseline at `y`, in the lane's font or, where that has no glyphs, its fallback. */
function drawLabel(
  c: SkCanvas,
  text: string,
  fb: LaneFallback,
  x: number,
  y: number,
  kind: (typeof TEXT_PAINTS)[number],
  paints: Record<(typeof TEXT_PAINTS)[number], SkPaint>,
  font: SkFont,
) {
  'worklet';
  if (fb) fb.by[kind].paint(c, x, y - fb.baseline);
  else c.drawText(text, x, y, paints[kind], font);
}

type Props = {
  width: number;
  /** The clips' row, the lane and the ruler (y of each, dp from the canvas's top). */
  tilesTop: number;
  laneTop: number;
  laneHeight: number;
  rulerTop: number;
  rulerHeight: number;
  clips: readonly CanvasClip[];
  captions: readonly CanvasCaption[];
  captionSelected: number;
  /** The selected caption's selected word (-1: none). */
  captionWord: number;
  /** A selected word's grip being dragged (1 start, 2 end; 0 none) and where it is (timeline ms). */
  capSide: SharedValue<number>;
  capValue: SharedValue<number>;
  timeMs: SharedValue<number>;
  motion: TileMotion;
  palette: TilePalette & { text: string; ruler: string };
};

function hexPaint(color: string, stroke = 0, alpha = 1): SkPaint {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(color));
  if (stroke > 0) {
    p.setStyle(PaintStyle.Stroke);
    p.setStrokeWidth(stroke);
  }
  if (alpha < 1) p.setAlphaf(alpha);
  return p;
}

// Covers decoded once per file (shared by every editor), and each clip's last one: a clip whose
// cover was just re-rendered (an edit) keeps showing the last until the new one can be read.
const coverCache = new Map<string, SkImage | null>();
const lastCover = new Map<string, SkImage>();
const COVER_CACHE_LIMIT = 64;

function decodeCover(uri: string): SkImage | null {
  const cached = coverCache.get(uri);
  if (cached !== undefined) return cached;
  let img: SkImage | null = null;
  try {
    const file = new File(uri);
    // Small JPEGs already on disk: read and decoded at once, so a clip never waits for its cover.
    if (file.exists) img = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(file.bytesSync()));
  } catch {
    img = null;
  }
  // A missing file isn't remembered (it may be being written); a decoded or broken one is.
  if (img || new File(uri).exists) coverCache.set(uri, img);
  while (coverCache.size > COVER_CACHE_LIMIT) {
    const oldest = coverCache.keys().next().value;
    if (oldest === undefined) break;
    coverCache.delete(oldest);
  }
  return img;
}

/** Each clip's cover (id → file) as a GPU image: its own once readable, else its last one. */
export function useCovers(
  covers: readonly { id: string; uri: string | null }[],
): (SkImage | null)[] {
  const key = covers.map((c) => `${c.id}=${c.uri ?? ''}`).join('\n');
  return useMemo(
    () => {
      // Only these clips' last covers are kept (a deleted clip's goes).
      const ids = new Set(covers.map((c) => c.id));
      for (const id of lastCover.keys()) if (!ids.has(id)) lastCover.delete(id);
      return covers.map(({ id, uri }) => {
        const img = uri ? decodeCover(uri) : null;
        if (img) lastCover.set(id, img);
        return img ?? lastCover.get(id) ?? null;
      });
    },
    // `key` is `covers` as one value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
}

export function TimelineCanvas(props: Props) {
  const { width, clips, captions, captionSelected, timeMs, motion, palette } = props;
  const { captionWord, capSide, capValue } = props;
  const { tilesTop, laneTop, laneHeight, rulerTop, rulerHeight } = props;
  const height = laneTop + laneHeight;

  const font = useMemo<SkFont>(
    () =>
      matchFont({
        fontFamily: Platform.select({ ios: 'Helvetica', default: 'sans-serif' }),
        fontSize: 11,
        fontWeight: '600',
      }),
    [],
  );
  const smallFont = useMemo<SkFont>(
    () =>
      matchFont({
        fontFamily: Platform.select({ ios: 'Helvetica', default: 'sans-serif' }),
        fontSize: 9,
        fontWeight: '500',
      }),
    [],
  );
  const paints = useMemo(
    () => ({
      tile: hexPaint(palette.tile),
      film: hexPaint(palette.film),
      wave: hexPaint(palette.wave),
      line: hexPaint(palette.line, 1),
      lineSoft: hexPaint(palette.line, 1, 0.5),
      center: hexPaint(palette.line, 1, 0.35),
      image: Skia.Paint(),
      text: hexPaint(palette.text),
      ruler: hexPaint(palette.ruler, 1, 0.5),
      rulerText: hexPaint(palette.ruler, 0, 0.7),
      selectedWord: hexPaint(Accent, 0, 0.25),
      active: hexPaint(Accent),
      activeText: hexPaint('#FFFFFF'),
      // A word's segment, a step lighter than its sentence's box.
      word: hexPaint(palette.text, 0, 0.1),
    }),
    [palette.tile, palette.film, palette.wave, palette.line, palette.text, palette.ruler],
  );
  const laneFallback = useMemo(
    () =>
      (text: string): LaneFallback =>
        lacksGlyphs(font, text)
          ? fallbackText(text, font.getSize(), FontWeight.SemiBold, paints, TEXT_PAINTS)
          : null,
    [font, paints],
  );

  // The captions with their words measured, once per change of the captions (not per frame).
  const drawnCaptions = useMemo<DrawnCaption[]>(
    () =>
      captions.map((cap) => ({
        t0: cap.t0,
        t1: cap.t1,
        text: cap.text,
        fb: laneFallback(cap.text),
        words: (cap.words ?? []).map((w) => {
          const fb = laneFallback(w.text);
          return { ...w, w: fb ? fb.width : advance(font, w.text), fb };
        }),
      })),
    [captions, font, laneFallback],
  );

  // What's drawn, on the UI thread. Peaks are copied there once per change of the clips.
  const model = useSharedValue<{
    clips: readonly CanvasClip[];
    captions: readonly DrawnCaption[];
    sel: number;
    word: number;
  }>({ clips, captions: drawnCaptions, sel: captionSelected, word: captionWord });
  useEffect(() => {
    model.set({
      clips,
      captions: drawnCaptions,
      sel: captionSelected,
      word: captionWord,
    });
  }, [clips, drawnCaptions, captionSelected, captionWord, model]);

  const { slots, sel, side, delta, zoom } = motion;
  const half = width / 2;

  // One recorder for the canvas's life, reused each frame (as Skia's Pictures guide does): a new
  // one per frame reports 1 MiB of memory pressure to the UI runtime each time.
  const recorder = useMemo(() => Skia.PictureRecorder(), []);
  const picture = useDerivedValue(() => {
    const rec = recorder;
    const c = rec.beginRecording(Skia.XYWHRect(0, 0, width, height));
    const z = zoom.get();
    const t = timeMs.get();
    // Timeline ms at the canvas's left edge, and the x of timeline ms `ms`.
    const leftMs = t - half / z;
    const rightMs = t + half / z;
    const xOf = (ms: number) => (ms - leftMs) * z;
    const m = model.get();
    const g = slots.get();
    const s = side.get();
    const d = delta.get();
    const trimmed = sel.get();

    // --- Ruler ---
    const steps = rulerSteps(z);
    const first = Math.max(0, Math.floor(leftMs / steps.minorMs));
    for (let n = first; n * steps.minorMs <= rightMs; n++) {
      const ms = n * steps.minorMs;
      const x = xOf(ms);
      const major = Math.abs(ms / steps.majorMs - Math.round(ms / steps.majorMs)) < 1e-6;
      const h = major ? 6 : 3;
      c.drawLine(x, rulerTop + rulerHeight - h, x, rulerTop + rulerHeight, paints.ruler);
      if (major) {
        const tenths = Math.floor(ms / 100);
        const secs = Math.floor(tenths / 10);
        const ss = secs % 60;
        const label =
          `${Math.floor(secs / 60)}:${ss < 10 ? '0' : ''}${ss}` +
          (steps.majorMs < 1000 ? `.${tenths % 10}` : '');
        c.drawText(label, x + 3, rulerTop + 9, paints.rulerText, smallFont);
      }
    }

    // --- Clips ---
    for (let i = 0; i < m.clips.length; i++) {
      const clip = m.clips[i];
      let startMs = g[i * 2] ?? 0;
      let lengthMs = g[i * 2 + 1] ?? 0;
      // A trim in progress: the left grip moves the start, the right one the end (and the clips
      // after it); the source stays where it is under both.
      if (s !== 0 && trimmed >= 0) {
        if (i === trimmed) {
          if (s === 1) {
            startMs += d;
            lengthMs -= d;
          } else lengthMs += d;
        } else if (i > trimmed && s === 2) startMs += d;
      }
      const endMs = startMs + lengthMs;
      if (endMs < leftMs || startMs > rightMs) continue;
      const x0 = xOf(startMs);
      const w = Math.max(2, lengthMs * z - TILE_GAP);
      const tile = Skia.XYWHRect(x0, tilesTop, w, TILE_HEIGHT);
      const rr = Skia.RRectXY(tile, TILE_RADIUS, TILE_RADIUS);
      c.save();
      c.clipRRect(rr, ClipOp.Intersect, true);
      c.drawRect(tile, paints.tile);
      // The source's own time at the tile's left: its trim start, unmoved by the left grip.
      const srcAt0 = clip.inMs + (s === 1 && i === trimmed ? d * clip.speed : 0);
      // x of source time `src` (ms).
      const xSrc = (src: number) => x0 + ((src - srcAt0) / clip.speed) * z;
      const visFrom = Math.max(x0, 0);
      const visTo = Math.min(x0 + w, width);

      // Filmstrip: tiles in the shape of the clip's picture (the whole of it), the same size at
      // any zoom, laid from the source's start (so a scroll or a trim never moves one; a zoom
      // changes the moment each shows). Each is drawn with the loaded frame nearest its middle
      // (its own once it's in), else the cover; so a tile's picture only changes for a closer
      // frame.
      c.drawRect(Skia.XYWHRect(x0, tilesTop, w, FILM_HEIGHT), paints.film);
      // A tile's length in source ms.
      const tileMs = (clip.tileW / z) * clip.speed;
      const srcFrom = srcAt0 + ((visFrom - x0) / z) * clip.speed;
      const srcTo = srcAt0 + ((visTo - x0) / z) * clip.speed;
      const ft = clip.frameTimes;
      let fi = 0;
      for (
        let ts = Math.max(0, Math.floor(srcFrom / tileMs) * tileMs);
        ts < Math.min(srcTo, clip.sourceMs);
        ts += tileMs
      ) {
        // Times only grow along the row, so the nearest frame's index only moves forward.
        const mid = ts + tileMs / 2;
        while (fi + 1 < ft.length && Math.abs(ft[fi + 1] - mid) <= Math.abs(ft[fi] - mid)) fi++;
        const dx = xSrc(ts);
        if (!ft.length) {
          // No frame yet: the cover (drawn with the edit already), cover-fit to the cell.
          if (clip.cover)
            drawCovered(
              c,
              clip.cover,
              dx,
              tilesTop,
              clip.tileW,
              FILM_HEIGHT,
              0,
              false,
              null,
              paints.image,
            );
          continue;
        }
        drawCovered(
          c,
          clip.frameImages[fi],
          dx,
          tilesTop,
          clip.tileW,
          FILM_HEIGHT,
          clip.turns,
          clip.flipped,
          clip.crop,
          paints.image,
        );
      }

      // Waveform: one line per WAVE_STEP dp, the peak (outer, light) and the RMS (inner).
      const wy = tilesTop + WAVE_TOP;
      c.drawRect(Skia.XYWHRect(x0, wy, w, WAVE_HEIGHT), paints.wave);
      const peaks = clip.peaks;
      if (peaks && !clip.muted) {
        const mid = wy + WAVE_HEIGHT / 2;
        const halfH = WAVE_HEIGHT / 2 - 2;
        c.drawLine(visFrom, mid, visTo, mid, paints.center);
        const count = peaks.length / 2;
        const span = (WAVE_STEP / z) * clip.speed;
        const outer = Skia.PathBuilder.Make();
        const inner = Skia.PathBuilder.Make();
        for (
          let x = visFrom - ((visFrom - x0) % WAVE_STEP) + WAVE_STEP / 2;
          x < visTo;
          x += WAVE_STEP
        ) {
          const s0 = srcAt0 + ((x - WAVE_STEP / 2 - x0) / z) * clip.speed;
          let p = 0;
          let r = 0;
          const last = Math.min(count, Math.ceil((s0 + span) / PEAK_MS));
          for (let b = Math.max(0, Math.floor(s0 / PEAK_MS)); b < last; b++) {
            if (peaks[b * 2] > p) p = peaks[b * 2];
            if (peaks[b * 2 + 1] > r) r = peaks[b * 2 + 1];
          }
          const ph = LEVELS[p] * halfH;
          if (ph < 0.75) continue;
          const rh = Math.min(ph, LEVELS[r] * halfH);
          outer.moveTo(x, mid - ph);
          outer.lineTo(x, mid + ph);
          inner.moveTo(x, mid - rh);
          inner.lineTo(x, mid + rh);
        }
        c.drawPath(outer.build(), paints.lineSoft);
        c.drawPath(inner.build(), paints.line);
      }
      c.restore();
    }

    // --- Captions lane ---
    const dragSide = capSide.get();
    const dragValue = capValue.get();
    for (let i = 0; i < m.captions.length; i++) {
      // The selected caption as its grip is dragged, else as it is.
      const cap =
        i === m.sel && dragSide !== 0
          ? dragged(m.captions[i], m.word, dragSide, dragValue)
          : m.captions[i];
      const a = cap.t0 * 10;
      const b = cap.t1 * 10;
      if (b < leftMs || a > rightMs) continue;
      const x = xOf(a);
      const w = Math.max(6, (b - a) * z - 2);
      const box = Skia.RRectXY(Skia.XYWHRect(x, laneTop, w, laneHeight), 6, 6);
      c.drawRRect(box, paints.tile);
      const textY = laneTop + laneHeight / 2 + 4;
      // Every word at its own time, at any scale, so the caption keeps its shape as the timeline
      // zooms: zoomed out, a word whose slot is too narrow shows only as much as fits (and a tiny
      // one only its place); zoomed in, each reads whole. The spoken word is in the accent, as
      // the caption on the video shows it. A line without word timing shows its text.
      const words = cap.words;
      c.save();
      c.clipRRect(box, ClipOp.Intersect, true);
      if (words.length) {
        const posCs = t / 10;
        // The word under the playhead, else the last one started (as the overlay rests on it).
        let active = -1;
        // Half-open, start up to (not including) the end: where two touch, the later one has it.
        if (posCs >= cap.t0 && posCs < cap.t1) {
          for (let k = 0; k < words.length; k++) {
            if (posCs >= words[k].t0) active = k;
            if (posCs >= words[k].t0 && posCs < words[k].t1) break;
          }
        }
        for (let k = 0; k < words.length; k++) {
          // Each word its own segment, from its start to its end (a pause shows as a gap), so
          // what's drawn is what a selected word's grips hold.
          const wx = xOf(words[k].t0 * 10);
          const span = Math.max(2, (words[k].t1 - words[k].t0) * 10 * z);
          if (wx > width || wx + span < 0) continue;
          const pill = Skia.RRectXY(
            Skia.XYWHRect(wx + 0.5, laneTop + 2, Math.max(1, span - 1), laneHeight - 4),
            4,
            4,
          );
          c.drawRRect(pill, k === active ? paints.active : paints.word);
          // A word's text always shows: centred in its segment when it fits there, else from the
          // segment's start, cut off at its end.
          const fits = words[k].w + 8 <= span;
          // One colour for every word, so nothing changes as the playhead enters a sentence; only
          // the spoken word stands out.
          const kind = k === active ? 'activeText' : 'text';
          if (fits) {
            const tx = wx + (span - words[k].w) / 2;
            drawLabel(c, words[k].text, words[k].fb, tx, textY, kind, paints, font);
          } else if (span > 3) {
            // (Narrower, the clip leaves nothing of the text to draw.)
            c.save();
            c.clipRect(
              Skia.XYWHRect(wx + 1, laneTop, span - 2, laneHeight),
              ClipOp.Intersect,
              true,
            );
            drawLabel(c, words[k].text, words[k].fb, wx + 4, textY, kind, paints, font);
            c.restore();
          }
        }
      } else if (w > 14) {
        c.clipRect(Skia.XYWHRect(x + 6, laneTop, w - 12, laneHeight), ClipOp.Intersect, true);
        drawLabel(c, cap.text, cap.fb, x + 6, textY, 'text', paints, font);
      }
      c.restore();
      if (i === m.sel && words[m.word]) {
        // The selected word: tinted, a grip outside each edge.
        const wa = xOf(words[m.word].t0 * 10);
        const wb = xOf(words[m.word].t1 * 10);
        c.drawRRect(
          Skia.RRectXY(Skia.XYWHRect(wa, laneTop, Math.max(2, wb - wa), laneHeight), 4, 4),
          paints.selectedWord,
        );
        drawGrip(c, wa - CAP_GRIP, laneTop, laneHeight, paints.active, paints.activeText);
        drawGrip(c, wb, laneTop, laneHeight, paints.active, paints.activeText);
      }
    }
    return rec.finishRecordingAsPicture();
  });

  return (
    <Canvas style={[StyleSheet.absoluteFill, { width, height }]} pointerEvents="none">
      <Picture picture={picture} />
    </Canvas>
  );
}

/**
 * `img` with an edit drawn on it (clockwise quarter `turns`, then a horizontal flip, then the
 * normalized `crop`, as merge applies them), the middle of it that has the cell's shape filling
 * the cell (x, y, w, h). The edit is a drawing transform, so an edited clip's frames need no
 * fetching of their own.
 */
function drawCovered(
  c: SkCanvas,
  img: SkImage,
  x: number,
  y: number,
  w: number,
  h: number,
  turns: number,
  flipped: boolean,
  crop: { x: number; y: number; w: number; h: number } | null,
  paint: SkPaint,
) {
  'worklet';
  const iw = img.width();
  const ih = img.height();
  // The edited picture's size, and the part the crop keeps.
  const ew = turns % 2 ? ih : iw;
  const eh = turns % 2 ? iw : ih;
  const kx = (crop ? crop.x : 0) * ew;
  const ky = (crop ? crop.y : 0) * eh;
  const kw = (crop ? crop.w : 1) * ew;
  const kh = (crop ? crop.h : 1) * eh;
  // The middle of the kept part that has the cell's shape.
  const aspect = w / h;
  let sw = kw;
  let sh = kw / aspect;
  if (sh > kh) {
    sh = kh;
    sw = kh * aspect;
  }
  const sx = kx + (kw - sw) / 2;
  const sy = ky + (kh - sh) / 2;
  const s = w / sw;
  c.save();
  c.clipRect(Skia.XYWHRect(x, y, w, h), ClipOp.Intersect, true);
  // Edited picture → cell.
  c.translate(x, y);
  c.scale(s, s);
  c.translate(-sx, -sy);
  // Source → edited picture: the flip, after the turn.
  if (flipped) {
    c.translate(ew, 0);
    c.scale(-1, 1);
  }
  if (turns === 1) {
    c.translate(ih, 0);
    c.rotate(90, 0, 0);
  } else if (turns === 2) {
    c.translate(iw, ih);
    c.rotate(180, 0, 0);
  } else if (turns === 3) {
    c.translate(0, iw);
    c.rotate(270, 0, 0);
  }
  // Scaled smoothly (not point-sampled), so a downscaled frame doesn't shimmer as it moves.
  const all = Skia.XYWHRect(0, 0, iw, ih);
  c.drawImageRectOptions(img, all, all, FilterMode.Linear, MipmapMode.None, paint);
  c.restore();
}

/** A caption grip: a rounded accent tab `CAP_GRIP` wide at x, with a light bar down its middle. */
function drawGrip(c: SkCanvas, x: number, y: number, h: number, fill: SkPaint, bar: SkPaint) {
  'worklet';
  c.drawRRect(Skia.RRectXY(Skia.XYWHRect(x, y, CAP_GRIP, h), 3, 3), fill);
  c.drawRRect(Skia.RRectXY(Skia.XYWHRect(x + CAP_GRIP / 2 - 1, y + h / 2 - 5, 2, 10), 1, 1), bar);
}

/**
 * The selected word's caption as a grip drag leaves it (centiseconds): `side` 1 moves the word's
 * start, 2 its end, to `v` ms (that word only). The same rule the editor saves on release.
 */
function dragged(cap: DrawnCaption, word: number, side: number, v: number): DrawnCaption {
  'worklet';
  const words: DrawnCaption['words'][number][] = [];
  for (let k = 0; k < cap.words.length; k++) {
    const x = cap.words[k];
    words.push({ text: x.text, t0: x.t0, t1: x.t1, w: x.w, fb: x.fb });
  }
  const cs = v / 10;
  const last = words.length - 1;
  if (last < 0 || !words[word]) return cap;
  if (side === 1) words[word].t0 = cs;
  else if (side === 2) words[word].t1 = cs;
  return { t0: words[0].t0, t1: words[last].t1, text: cap.text, fb: cap.fb, words };
}

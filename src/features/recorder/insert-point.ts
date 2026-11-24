import { anchorAtSlot, type ClipAnchor, isEnd } from '@/core/clip-anchor';
import { formatDuration } from '@/utils/format';

// The recorder's insert cursor (#308), as pure logic: where it sits on the clip strip, which
// touches move it, its copy, and how it follows clips being added and removed. The strip and the
// cursor (segment-bar.tsx, insert-cursor.tsx) call the geometry from their gestures' worklets, so
// those functions are worklets too; the rest runs on JS.

// --- Boundaries and anchors -----------------------------------------------------------------------

/**
 * The cursor as a boundary index: 0 before the first clip … `ids.length` after the last (the end).
 * An anchor whose clip isn't in `ids` reads as the end, as `insertSegments` resolves it.
 */
export function boundaryOf(anchor: ClipAnchor, ids: readonly string[]): number {
  const i = isEnd(anchor) ? -1 : ids.indexOf(anchor.before);
  return i < 0 ? ids.length : i;
}

/**
 * The anchor for boundary `k` (`anchorAtSlot`): before the clip there, or the end after the last.
 * It keeps its place when clips are added at it (a run of takes stays in order with no move) and
 * when the clip before it is retaken.
 */
export const anchorAtBoundary = anchorAtSlot;

/** One boundary along (an accessibility increment or decrement), held to the strip. */
export function stepBoundary(k: number, delta: number, count: number): number {
  return Math.min(count, Math.max(0, k + delta));
}

// --- Following the draft --------------------------------------------------------------------------

/**
 * The cursor once the draft's clips changed (`before` → `after` are its clip ids in order, as last
 * shown and now). If its clip went, it stays in the same place: before the next clip still there,
 * or the end; else it stays before its clip, its `next` brought up to date. A clip it never saw
 * (the list not loaded yet) leaves it alone.
 */
export function cursorAfterRemoval(
  cursor: ClipAnchor,
  before: readonly string[],
  after: readonly string[],
): ClipAnchor {
  if (isEnd(cursor)) return cursor;
  const k = after.indexOf(cursor.before);
  if (k >= 0) return anchorAtBoundary(k, after);
  const i = before.indexOf(cursor.before);
  if (i < 0) return cursor;
  const next = before.slice(i + 1).find((id) => after.includes(id));
  return anchorAtBoundary(next === undefined ? after.length : after.indexOf(next), after);
}

/** The cursor as a clip is about to be deleted from `ids` (the recorder's trash): as if gone. */
export function cursorBeforeDelete(
  cursor: ClipAnchor,
  ids: readonly string[],
  id: string,
): ClipAnchor {
  return cursorAfterRemoval(
    cursor,
    ids,
    ids.filter((other) => other !== id),
  );
}

/**
 * The clip order the strip shows: one it has just set itself (a drop: a reorder or a delete) until
 * the draft's clips next change, else the draft's. The draft's live clips catch up a beat after a
 * drop; until then the cursor, its chip and taps go by the order on screen. `pending.base` is the
 * clips list the drop was made over: any newer list (the drop stored, or anything else) wins.
 */
export function orderShown<T>(
  clips: T,
  ids: readonly string[],
  pending: { base: T; ids: readonly string[] } | null,
): readonly string[] {
  return pending && pending.base === clips ? pending.ids : ids;
}

/** The cursor's boundary kept where it was across a reorder (`before` → `after` orders). */
export function cursorAfterReorder(
  cursor: ClipAnchor,
  before: readonly string[],
  after: readonly string[],
): ClipAnchor {
  return anchorAtBoundary(boundaryOf(cursor, before), after);
}

// --- Copy -----------------------------------------------------------------------------------------

/** What the copy needs of a clip: its badge label and its length on the timeline. */
export type CursorClip = { label: string | null; durationMs: number };

/** A clip's name in copy: its badge label (creation number), else its place (1-based). */
function clipName(clips: readonly CursorClip[], i: number): string {
  return clips[i]?.label || String(i + 1);
}

/** Where boundary `k` is, in words: "before clip 1", "between clips 1 and 2", "at the end". */
export function insertPlace(k: number, clips: readonly CursorClip[]): string {
  if (k >= clips.length) return 'at the end';
  if (k <= 0) return `before clip ${clipName(clips, 0)}`;
  return `between clips ${clipName(clips, k - 1)} and ${clipName(clips, k)}`;
}

/** The recorded time before boundary `k`, ms. */
export function timeAtBoundary(k: number, clips: readonly CursorClip[]): number {
  let ms = 0;
  for (let i = 0; i < Math.min(k, clips.length); i++) ms += Math.max(0, clips[i].durationMs);
  return ms;
}

/**
 * The chip over the strip: "Adding at 0:03 · between clips 1 and 2". Null at the end, where adding
 * is the default and nothing needs saying.
 */
export function insertChipText(k: number, clips: readonly CursorClip[]): string | null {
  if (k >= clips.length) return null;
  return `Adding at ${formatDuration(timeAtBoundary(k, clips))} · ${insertPlace(k, clips)}`;
}

/** The cursor's accessibility label; its value is `cursorA11yValue`. */
export const CURSOR_A11Y_LABEL = 'Insert point';

/** The cursor's accessibility value: "between clips 1 and 2, at 0:03", or "at the end". */
export function cursorA11yValue(k: number, clips: readonly CursorClip[]): string {
  const place = insertPlace(k, clips);
  if (k >= clips.length) return place;
  return `${place}, at ${formatDuration(timeAtBoundary(k, clips))}`;
}

// --- Geometry -------------------------------------------------------------------------------------

/**
 * The strip's layout, in the gesture's frame: x along the scrolled content (the touch's x plus
 * the scroll offset), y down from the top of the touch area.
 */
export type StripGeometry = {
  /** Content padding before the first clip. */
  pad: number;
  tileWidth: number;
  gap: number;
  /** The clips' band: top and height. */
  tileTop: number;
  tileHeight: number;
};

/** A tap that moves further than this is a scroll, and leaves the cursor alone. */
export const TAP_SLOP = 10;

/** Boundary `k`'s x: the middle of the gap before clip k (the padding's middle at either end). */
export function boundaryX(k: number, g: StripGeometry): number {
  'worklet';
  return g.pad + k * (g.tileWidth + g.gap) - g.gap / 2;
}

/** The boundary nearest `x`, held to 0 … `count`. */
export function nearestBoundary(x: number, count: number, g: StripGeometry): number {
  'worklet';
  const k = Math.round((x - g.pad + g.gap / 2) / (g.tileWidth + g.gap));
  return Math.min(count, Math.max(0, k));
}

/** Whether a point is on a clip's tile (its gestures own it: tap, hold to reorder). */
export function onClip(x: number, y: number, count: number, g: StripGeometry): boolean {
  'worklet';
  if (y < g.tileTop || y > g.tileTop + g.tileHeight) return false;
  const rel = x - g.pad;
  if (rel < 0) return false;
  const pitch = g.tileWidth + g.gap;
  const i = Math.floor(rel / pitch);
  return i < count && rel - i * pitch <= g.tileWidth;
}

/**
 * The scroll offset that brings [x0, x1] (content x) into a `viewport`-wide view of `content`, or
 * null when it's in view already. Moves as little as it can; a range wider than the view shows its
 * end (the cursor's side).
 */
export function scrollToShow(
  offset: number,
  viewport: number,
  content: number,
  x0: number,
  x1: number,
): number | null {
  const max = Math.max(0, content - viewport);
  let target = offset;
  if (x1 > offset + viewport) target = x1 - viewport;
  else if (x0 < offset) target = x0;
  target = Math.min(max, Math.max(0, target));
  return Math.abs(target - offset) < 0.5 ? null : target;
}

/** Dragging the cursor near an edge of the strip scrolls it: within this far of an edge… */
export const EDGE_ZONE = 56;
/** …at up to this speed (px/s), deeper into the zone faster. */
export const MAX_SCROLL_SPEED = 760;

/**
 * The strip's scroll speed (px/s, negative leftwards) for the dragged cursor at `x` in a
 * `viewport`-wide view, its x held `pad` in from each edge: none outside the edge zones.
 */
export function edgeScrollSpeed(x: number, viewport: number, pad: number): number {
  'worklet';
  const knob = Math.min(Math.max(x, pad), viewport - pad);
  if (knob < pad + EDGE_ZONE) return -MAX_SCROLL_SPEED * (1 - (knob - pad) / EDGE_ZONE);
  if (knob > viewport - pad - EDGE_ZONE)
    return MAX_SCROLL_SPEED * (1 - (viewport - pad - knob) / EDGE_ZONE);
  return 0;
}

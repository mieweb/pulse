import { type ClipAnchor, type ClipsAdded, END } from '@/core/clip-anchor';
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
  if ('before' in anchor) {
    const i = ids.indexOf(anchor.before);
    return i < 0 ? ids.length : i;
  }
  if ('after' in anchor) {
    const i = ids.indexOf(anchor.after);
    return i < 0 ? ids.length : i + 1;
  }
  return ids.length;
}

/**
 * The anchor for boundary `k`: before the clip there, or the end after the last. Always the
 * `before` form, which keeps its place when clips are added at it (a run of takes stays in order
 * with no move) and when the clip before it is retaken.
 */
export function anchorAtBoundary(k: number, ids: readonly string[]): ClipAnchor {
  return k >= 0 && k < ids.length ? { before: ids[k] } : END;
}

/** One boundary along (an accessibility increment or decrement), held to the strip. */
export function stepBoundary(k: number, delta: number, count: number): number {
  return Math.min(count, Math.max(0, k + delta));
}

// --- Following the draft --------------------------------------------------------------------------

/**
 * The cursor after clips were added to its draft. One in the `before` form, or at the end, stays as
 * it is: the new clips are on its left and it is still where it was. One `after` a clip moves past
 * clips that landed right after that clip (whichever anchor they were added at), to before the
 * clip that follows them, or the end.
 */
export function cursorAfterAdd(cursor: ClipAnchor, added: ClipsAdded): ClipAnchor {
  if (!('after' in cursor)) return cursor;
  if (added.prevId === undefined) {
    // Neighbours not reported: only the same anchor is known to be the same slot.
    if (!('after' in added.anchor) || added.anchor.after !== cursor.after) return cursor;
    return { after: added.segmentIds[added.segmentIds.length - 1] };
  }
  if (added.prevId !== cursor.after) return cursor;
  return added.nextId ? { before: added.nextId } : END;
}

/**
 * The cursor once clips have gone from the draft (`before` → `after` are its clip ids in order, as
 * last shown and now). If its clip went, it stays in the same place: before the next clip still
 * there, or the end. A clip it never saw (the list not loaded yet) leaves it alone.
 */
export function cursorAfterRemoval(
  cursor: ClipAnchor,
  before: readonly string[],
  after: readonly string[],
): ClipAnchor {
  const id = 'before' in cursor ? cursor.before : 'after' in cursor ? cursor.after : null;
  if (id == null || after.includes(id)) return cursor;
  const i = before.indexOf(id);
  if (i < 0) return cursor;
  for (let j = i + 1; j < before.length; j++) {
    if (after.includes(before[j])) return { before: before[j] };
  }
  return END;
}

/**
 * The same place in the `before` form, once its clip is in `ids`: after a clip is before the next
 * one, or the end after the last. Anything else is returned as it is.
 */
export function normalizeCursor(cursor: ClipAnchor, ids: readonly string[]): ClipAnchor {
  if (!('after' in cursor)) return cursor;
  const i = ids.indexOf(cursor.after);
  if (i < 0) return cursor;
  return anchorAtBoundary(i + 1, ids);
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

/**
 * Where a screen take goes, resolved as it's added: it was pinned at Record screen's tap as
 * `pinned` (the cursor then) with `prevId`, the clip before that spot (null: the draft's start).
 * Long takes convert for a while, and the clip after the spot may be deleted meanwhile: then it
 * goes after the clip before it, or at the start if it was there; with both gone, the end.
 * `prevId` undefined (a row saved before it was kept) keeps `pinned` as it is.
 */
export function resolvePinned(
  pinned: ClipAnchor,
  prevId: string | null | undefined,
  stillThere: (id: string) => boolean,
  firstId: () => string | null,
): ClipAnchor {
  if (!('before' in pinned) || prevId === undefined || stillThere(pinned.before)) return pinned;
  if (prevId === null) {
    const first = firstId();
    return first ? { before: first } : END;
  }
  return stillThere(prevId) ? { after: prevId } : END;
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

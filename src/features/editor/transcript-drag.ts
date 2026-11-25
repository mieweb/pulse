export type TranscriptWordBox = {
  id: string;
  /** Position in transcript reading order, independent of visual left/right direction. */
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TranscriptPoint = { x: number; y: number };

function validBox(box: TranscriptWordBox): boolean {
  'worklet';
  return (
    Number.isInteger(box.index) &&
    box.index >= 0 &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  );
}

function intervalGap(value: number, start: number, length: number): number {
  'worklet';
  return Math.max(start - value, value - start - length, 0);
}

function sameLine(a: TranscriptWordBox, b: TranscriptWordBox): boolean {
  'worklet';
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap >= Math.min(a.height, b.height) / 2;
}

/**
 * Begin only on a word (optionally with small target slop). During a drag, `nearest` follows
 * the closest visual line and then its closest word, including line-end and inter-beat space.
 * Selection order comes from each box's index, so wrapped LTR/RTL layouts use the same hit test.
 * Coordinates belong to one scroll-content space, not individual nested word containers.
 */
export function transcriptWordAtPoint(
  boxes: readonly TranscriptWordBox[],
  point: TranscriptPoint,
  options: { nearest?: boolean; slop?: number } = {},
): TranscriptWordBox | null {
  'worklet';
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const slop = Number.isFinite(options.slop) ? Math.max(0, options.slop!) : 0;
  let hit: TranscriptWordBox | null = null;
  let hitGap = Infinity;
  let hitCenter = Infinity;
  let line: TranscriptWordBox | null = null;
  let lineGap = Infinity;
  let lineCenter = Infinity;
  for (const box of boxes) {
    if (!validBox(box)) continue;
    const dx = intervalGap(point.x, box.x, box.width);
    const dy = intervalGap(point.y, box.y, box.height);
    const centerX = point.x - box.x - box.width / 2;
    const centerY = point.y - box.y - box.height / 2;
    const gap = dx * dx + dy * dy;
    const center = centerX * centerX + centerY * centerY;
    if (
      dx <= slop &&
      dy <= slop &&
      (gap < hitGap ||
        (gap === hitGap &&
          (center < hitCenter || (center === hitCenter && (!hit || box.index < hit.index)))))
    ) {
      hit = box;
      hitGap = gap;
      hitCenter = center;
    }
    // A pointer between lines crosses at their midpoint, even if one line is much shorter.
    const verticalCenter = Math.abs(centerY);
    if (
      dy < lineGap ||
      (dy === lineGap &&
        (verticalCenter < lineCenter ||
          (verticalCenter === lineCenter && (!line || box.y < line.y))))
    ) {
      line = box;
      lineGap = dy;
      lineCenter = verticalCenter;
    }
  }
  if (hit || !options.nearest || !line) return hit;
  let nearest: TranscriptWordBox | null = null;
  let nearestGap = Infinity;
  let nearestCenter = Infinity;
  for (const box of boxes) {
    if (!validBox(box) || !sameLine(box, line)) continue;
    const gap = intervalGap(point.x, box.x, box.width);
    const center = Math.abs(point.x - box.x - box.width / 2);
    if (
      gap < nearestGap ||
      (gap === nearestGap &&
        (center < nearestCenter ||
          (center === nearestCenter && (!nearest || box.index < nearest.index))))
    ) {
      nearest = box;
      nearestGap = gap;
      nearestCenter = center;
    }
  }
  return nearest;
}

/** Recompute from the gesture's baseline so reversing/shrinking restores untouched selections. */
export function transcriptDragSelection(
  ids: readonly string[],
  baseline: ReadonlySet<string>,
  anchorIndex: number,
  endIndex: number,
): Set<string> {
  const selected = new Set(baseline);
  if (
    !Number.isInteger(anchorIndex) ||
    !Number.isInteger(endIndex) ||
    anchorIndex < 0 ||
    endIndex < 0 ||
    anchorIndex >= ids.length ||
    endIndex >= ids.length
  )
    return selected;
  const selecting = !baseline.has(ids[anchorIndex]);
  const from = Math.min(anchorIndex, endIndex);
  const to = Math.max(anchorIndex, endIndex);
  for (let index = from; index <= to; index++) {
    if (selecting) selected.add(ids[index]);
    else selected.delete(ids[index]);
  }
  return selected;
}

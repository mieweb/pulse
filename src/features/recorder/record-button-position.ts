/**
 * Geometry for the user-movable record button (#231). Positions are the button's CENTRE in
 * screen points; persisted as fractions of the screen so a saved spot survives a different
 * screen size. Pure (worklet-safe) so the drag gesture can clamp on the UI thread.
 */

export type Point = { x: number; y: number };
/** Allowed range for the button's centre (inclusive). */
export type CenterBounds = { minX: number; maxX: number; minY: number; maxY: number };

const clamp = (v: number, lo: number, hi: number) => {
  'worklet';
  // A screen too small for the range collapses it onto its midpoint instead of inverting.
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(Math.max(v, lo), hi);
};

/** Clamp a button centre into `bounds`. */
export function clampCenter(p: Point, bounds: CenterBounds): Point {
  'worklet';
  return { x: clamp(p.x, bounds.minX, bounds.maxX), y: clamp(p.y, bounds.minY, bounds.maxY) };
}

/**
 * Where the button's centre may go: anywhere on screen with the whole button (and the move
 * handle on its left) visible, below the top bar (so the ✕ stays reachable) and clear of the
 * safe-area edges.
 */
export function centerBounds({
  screen,
  insets,
  topReserved,
  buttonSize,
  leftExtent,
  margin,
}: {
  screen: { width: number; height: number };
  insets: { top: number; bottom: number; left: number; right: number };
  /** Height from the top of the screen reserved for the top bar (includes the top inset). */
  topReserved: number;
  buttonSize: number;
  /** Extra width left of the button (the move handle and its gap) that must stay on screen. */
  leftExtent: number;
  margin: number;
}): CenterBounds {
  const half = buttonSize / 2;
  return {
    minX: insets.left + margin + leftExtent + half,
    maxX: screen.width - insets.right - margin - half,
    minY: Math.max(topReserved, insets.top) + margin + half,
    maxY: screen.height - insets.bottom - margin - half,
  };
}

/** Serialize a centre as screen fractions for the settings table. */
export function serializePosition(center: Point, screen: { width: number; height: number }) {
  return JSON.stringify({ x: center.x / screen.width, y: center.y / screen.height });
}

/** Parse a stored position (screen fractions); `null` for unset or corrupt values. */
export function parsePosition(raw: string | null): Point | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const { x, y } = v as { x?: unknown; y?: unknown };
    const ok = (n: unknown): n is number =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    return ok(x) && ok(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

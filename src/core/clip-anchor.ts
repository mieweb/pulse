/**
 * Where new clips go in a draft (issue #308): before or after a clip, by its segment id, or at the
 * end. The editor's + works it out from the playhead (`anchorForPlayhead`), the recorder holds one
 * as its insert cursor, and `insertSegments` (src/db/drafts.ts) resolves it to a slot when the
 * clips are written. An anchor whose clip is gone by then resolves to the end, never an error.
 *
 * `onClipsAdded` / `takeClipsAdded` hear every insert `insertSegments` commits: the recorder moves
 * its cursor past a clip that landed at it, and the editor places its playhead after the clips
 * added while the recorder covered it.
 */

export type ClipAnchor = { before: string } | { after: string } | { at: 'end' };

export const END: ClipAnchor = { at: 'end' };

export function isEnd(anchor: ClipAnchor): anchor is { at: 'end' } {
  return 'at' in anchor;
}

export function sameAnchor(a: ClipAnchor, b: ClipAnchor): boolean {
  if ('before' in a) return 'before' in b && a.before === b.before;
  if ('after' in a) return 'after' in b && a.after === b.after;
  return isEnd(b);
}

// The library's own id rule (media-refs.ts `SAFE_ID`): anything else never names a clip.
const SEGMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `before:<id>`, `after:<id>` or `end`: plain text, safe as an expo-router param. */
export function anchorToRouteParam(anchor: ClipAnchor): string {
  if ('before' in anchor) return `before:${anchor.before}`;
  if ('after' in anchor) return `after:${anchor.after}`;
  return 'end';
}

/** The anchor `anchorToRouteParam` wrote; anything else (missing, malformed, an array) is the end. */
export function anchorFromRouteParam(param: unknown): ClipAnchor {
  if (typeof param !== 'string') return END;
  const sep = param.indexOf(':');
  if (sep < 0) return END;
  const side = param.slice(0, sep);
  const id = param.slice(sep + 1);
  if (!SEGMENT_ID.test(id)) return END;
  if (side === 'before') return { before: id };
  if (side === 'after') return { after: id };
  return END;
}

/**
 * The anchor for the playhead at `timeMs`, never splitting a clip: in the first half of clip i,
 * before it; in its second half (the midpoint included), after it; exactly on the boundary
 * between two clips, before the second. At or past the end, or in an empty draft, the end; after
 * the last clip is the end too (the same slot, so a cursor there reads as "at the end").
 *
 * `starts[i]` is clip i's start on the timeline and `totalMs` the timeline's length, as in the
 * editor's `TimelineLayout`; `ids[i]` is clip i's segment id.
 */
export function anchorForPlayhead(
  ids: readonly string[],
  starts: readonly number[],
  totalMs: number,
  timeMs: number,
): ClipAnchor {
  const n = Math.min(ids.length, starts.length);
  if (n === 0 || !(timeMs < totalMs)) return END;
  let i = 0;
  while (i + 1 < n && starts[i + 1] <= timeMs) i++;
  const start = starts[i];
  const end = i + 1 < n ? starts[i + 1] : totalMs;
  if (timeMs <= start || timeMs - start < (end - start) / 2) return { before: ids[i] };
  return i + 1 < n ? { after: ids[i] } : END;
}

// --- Clips added -------------------------------------------------------------------------------

export type ClipsAdded = {
  draftId: string;
  /** The new clips' ids, in their order in the draft. */
  segmentIds: string[];
  /** The anchor they were added at (as asked, before it was resolved). */
  anchor: ClipAnchor;
  /**
   * Where they landed, by their neighbours once written: the clip right before them (null at the
   * start) and right after them (null at the end). Two anchors can name the same slot (`after:X`
   * and `before:Y` when Y follows X), so a listener asking "did they land at my slot?" compares
   * these rather than the anchor. Absent when not known.
   */
  prevId?: string | null;
  nextId?: string | null;
};

const listeners = new Set<(added: ClipsAdded) => void>();
const unread = new Map<string, string[]>();

/** Told by `insertSegments` once new clips are in a draft. */
export function noteClipsAdded(added: ClipsAdded): void {
  if (added.segmentIds.length === 0) return;
  unread.set(added.draftId, [...(unread.get(added.draftId) ?? []), ...added.segmentIds]);
  for (const listener of listeners) {
    try {
      listener(added);
    } catch (e) {
      console.warn('[clip-anchor] a clips-added listener threw', e);
    }
  }
}

/** Called with every insert from now on, until the returned function is called. */
export function onClipsAdded(listener: (added: ClipsAdded) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The ids of the clips added to the draft since the last call, in the order they were added
 * (empty if none), and forget them.
 */
export function takeClipsAdded(draftId: string): string[] {
  const ids = unread.get(draftId) ?? [];
  unread.delete(draftId);
  return ids;
}

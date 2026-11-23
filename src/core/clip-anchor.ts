/**
 * Where new clips go in a draft (issue #308): before or after a clip, by its segment id, or at the
 * end. The editor's + works it out from the playhead (`anchorForPlayhead`), the recorder holds one
 * as its insert cursor, and `insertSegments` (src/db/drafts.ts) resolves it to a slot when the
 * clips are written. An anchor whose clip is gone by then resolves to the end, never an error.
 *
 * `onClipsAdded` hears every insert `insertSegments` commits: the recorder moves its cursor past a
 * clip that landed at it. An open editor arms its draft (`expectClipsAdded`) and takes the clips
 * added to it (`takeClipsAdded`), from its own + or a recorder over it, to place its playhead after
 * them and make the addition one undo step.
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
  const { clip, slot } = playheadSlot(starts.slice(0, n), totalMs, timeMs);
  if (slot >= n) return END;
  return slot === clip ? { before: ids[clip] } : { after: ids[clip] };
}

/**
 * The rule behind `anchorForPlayhead`, on positions only (a worklet, so the editor can follow it
 * on the UI thread): the clip under the playhead (-1 at the end or with no clips) and the slot new
 * clips take, 0 (before the first clip) to `starts.length` (the end).
 */
export function playheadSlot(
  starts: readonly number[],
  totalMs: number,
  timeMs: number,
): { clip: number; slot: number } {
  'worklet';
  const n = starts.length;
  if (n === 0 || !(timeMs < totalMs)) return { clip: -1, slot: n };
  let i = 0;
  while (i + 1 < n && starts[i + 1] <= timeMs) i++;
  const start = starts[i];
  const end = i + 1 < n ? starts[i + 1] : totalMs;
  const firstHalf = timeMs <= start || timeMs - start < (end - start) / 2;
  return { clip: i, slot: firstHalf ? i : i + 1 };
}

// --- Clips added -------------------------------------------------------------------------------

export type ClipsAdded = {
  draftId: string;
  /** The new clips' ids, in their order in the draft. */
  segmentIds: string[];
  /** The anchor they were added at (as asked, before it was resolved). */
  anchor: ClipAnchor;
};

const listeners = new Set<(added: ClipsAdded) => void>();

/**
 * The drafts an editor is open on, each with the ids added since that editor last took them.
 * Only these drafts are recorded, so nothing piles up for drafts no editor is waiting on (a run of
 * takes in a recorder opened from Home), and an editor never hears of clips added before it
 * opened. `arms` counts the editors on the draft (an editor can sit under another one's recorder).
 */
const expected = new Map<string, { arms: number; ids: string[] }>();
/** Ids kept per draft at most: an editor takes them on every focus, so this is a backstop. */
const MAX_UNREAD = 500;

/** Told by `insertSegments` once new clips are in a draft. */
export function noteClipsAdded(added: ClipsAdded): void {
  if (added.segmentIds.length === 0) return;
  const entry = expected.get(added.draftId);
  if (entry) entry.ids = [...entry.ids, ...added.segmentIds].slice(-MAX_UNREAD);
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
 * An editor is open on `draftId`: the clips added to it from now on are kept for
 * `takeClipsAdded`, until the returned function is called (the editor closing). Several arms on
 * one draft share one list.
 */
export function expectClipsAdded(draftId: string): () => void {
  const entry = expected.get(draftId);
  if (entry) entry.arms++;
  else expected.set(draftId, { arms: 1, ids: [] });
  let armed = true;
  return () => {
    if (!armed) return;
    armed = false;
    const e = expected.get(draftId);
    if (!e) return;
    if (--e.arms <= 0) expected.delete(draftId);
  };
}

/**
 * The ids of the clips added to the draft since it was armed (`expectClipsAdded`) or last taken,
 * in the order they were added (empty if none, or if no editor armed it), and forget them.
 */
export function takeClipsAdded(draftId: string): string[] {
  const entry = expected.get(draftId);
  if (!entry) return [];
  const { ids } = entry;
  entry.ids = [];
  return ids;
}

import type { SplitReceipt } from '@/db/drafts';

/**
 * Where new clips go in a draft: at a boundary, at the end, or at an exact source point inside
 * a clip. The editor's + freezes the playhead with `anchorForExactPlayhead`; `insertSegments`
 * splits only when the prepared new clips commit. The recorder retains that exact point until
 * its first successful addition or an explicit cursor move.
 *
 * `next` is the clip that followed `before` when the anchor was made: an add that waits (an
 * import converting, a screen take) still lands in the same place if `before` is deleted
 * meanwhile, before `next`. With both gone, or no `next` (`before` was the last clip), the end.
 * The `before` form stays put as clips land at it, so a run of takes or a batch of images lands in
 * order with no move.
 * An inside anchor has no such fallback: if its original changes or disappears before the
 * split commits, the writer rejects it. Once its right half exists, it becomes that boundary.
 *
 * `onClipsAdded` hears every insert `insertSegments` commits. An open editor arms its draft
 * (`expectClipsAdded`) and takes the clips added to it (`takeClipsAdded`), from its own + or a
 * recorder over it, to place its playhead after them and make the addition one undo step. A
 * recorder over it that goes back to it on its Edit leaves the editor a place instead
 * (`returnEditorTo`): its insert cursor, where the editor's playhead goes (`timeAtAnchor`).
 */

/** A source position frozen while an imported or recorded clip is being prepared. */
export type ClipSplit = {
  sourceMs: number;
  sourceKey: string;
  rightId: string;
  /** Timeline offset inside `before`, for the cursor before the split is committed. */
  offsetMs: number;
};

export type ClipAnchor = { before: string; next?: string; split?: ClipSplit } | { at: 'end' };

export const END: ClipAnchor = { at: 'end' };

export function isEnd(anchor: ClipAnchor): anchor is { at: 'end' } {
  return 'at' in anchor;
}

export function sameAnchor(a: ClipAnchor, b: ClipAnchor): boolean {
  if (isEnd(a) || isEnd(b)) return isEnd(a) && isEnd(b);
  return (
    a.before === b.before &&
    a.next === b.next &&
    a.split?.sourceMs === b.split?.sourceMs &&
    a.split?.sourceKey === b.split?.sourceKey &&
    a.split?.rightId === b.split?.rightId &&
    a.split?.offsetMs === b.split?.offsetMs
  );
}

/**
 * Where `anchor` puts new clips: before `before` while it's in the draft, else before `next`, else
 * the end. The one rule for every reader of an anchor, so they can't disagree: `insertSegments`
 * writes with it and the recorder's cursor shows it. `slotOf` is a clip's slot, or undefined when
 * the clip isn't in the draft; undefined back means the end.
 */
export function resolveAnchor<T>(
  anchor: ClipAnchor,
  slotOf: (id: string) => T | undefined,
): T | undefined {
  if (isEnd(anchor)) return undefined;
  // A completed split keeps adding before its right half. A pending inside target must never
  // fall through to a different clip when its original disappeared; the writer rejects it.
  if (anchor.split) return slotOf(anchor.split.rightId) ?? slotOf(anchor.before);
  const at = slotOf(anchor.before);
  if (at !== undefined || anchor.next === undefined) return at;
  return slotOf(anchor.next);
}

/** `resolveAnchor` over the clip ids in order: the slot, 0 … `ids.length` (the end). */
export function anchorSlot(anchor: ClipAnchor, ids: readonly string[]): number {
  return (
    resolveAnchor(anchor, (id) => {
      const i = ids.indexOf(id);
      return i < 0 ? undefined : i;
    }) ?? ids.length
  );
}

/** The anchor for slot `slot` of the clips `ids` (0 before the first, `ids.length` the end). */
export function anchorAtSlot(slot: number, ids: readonly string[]): ClipAnchor {
  if (!(slot >= 0 && slot < ids.length)) return END;
  return slot + 1 < ids.length ? { before: ids[slot], next: ids[slot + 1] } : { before: ids[slot] };
}

// The library's own id rule (media-refs.ts `SAFE_ID`): anything else never names a clip.
const SEGMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Boundary text or an encoded inside position, safe as an expo-router param or saved setting. */
export function anchorToRouteParam(anchor: ClipAnchor): string {
  if (isEnd(anchor)) return 'end';
  if (anchor.split) return `inside:${encodeURIComponent(JSON.stringify(anchor))}`;
  return anchor.next ? `before:${anchor.before},${anchor.next}` : `before:${anchor.before}`;
}

/** The anchor `anchorToRouteParam` wrote; anything else (missing, malformed, an array) is the end. */
export function anchorFromRouteParam(param: unknown): ClipAnchor {
  if (typeof param !== 'string') return END;
  if (param.startsWith('inside:')) {
    if (param.length > 20000) return END;
    try {
      const value: unknown = JSON.parse(decodeURIComponent(param.slice('inside:'.length)));
      if (typeof value !== 'object' || value === null) return END;
      const { before, next, split } = value as Record<string, unknown>;
      if (typeof before !== 'string' || !SEGMENT_ID.test(before)) return END;
      if (next !== undefined && (typeof next !== 'string' || !SEGMENT_ID.test(next))) return END;
      if (typeof split !== 'object' || split === null) return END;
      const { sourceMs, sourceKey, rightId, offsetMs } = split as Record<string, unknown>;
      if (
        typeof sourceMs !== 'number' ||
        !Number.isFinite(sourceMs) ||
        sourceMs <= 0 ||
        sourceMs > Number.MAX_SAFE_INTEGER ||
        typeof offsetMs !== 'number' ||
        !Number.isFinite(offsetMs) ||
        offsetMs <= 0 ||
        offsetMs > Number.MAX_SAFE_INTEGER ||
        typeof sourceKey !== 'string' ||
        sourceKey.length === 0 ||
        sourceKey.length > 4096 ||
        /[\0\r\n]/.test(sourceKey) ||
        typeof rightId !== 'string' ||
        !SEGMENT_ID.test(rightId) ||
        rightId === before
      )
        return END;
      return {
        before,
        ...(next === undefined ? {} : { next }),
        split: { sourceMs, sourceKey, rightId, offsetMs },
      };
    } catch {
      return END;
    }
  }
  if (!param.startsWith('before:')) return END;
  const [before, next, ...rest] = param.slice('before:'.length).split(',');
  if (rest.length > 0 || !SEGMENT_ID.test(before)) return END;
  if (next === undefined) return { before };
  return SEGMENT_ID.test(next) ? { before, next } : END;
}

/**
 * The anchor for the playhead at `timeMs`, never splitting a clip: in the first half of clip i,
 * before it; in its second half (the midpoint included), before the clip after it; exactly on the
 * boundary between two clips, before the second. At or past the end, after the last clip's
 * midpoint, or in an empty draft, the end.
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
  return anchorAtSlot(playheadSlot(starts.slice(0, n), totalMs, timeMs).slot, ids.slice(0, n));
}

/**
 * The editor's exact playhead position. A boundary needs no split; inside a clip, retain its
 * source position and render identity so a later conversion cannot silently move the insert.
 */
export function anchorForExactPlayhead(
  clips: readonly {
    id: string;
    edit: { startMs: number; endMs: number; speed: number };
    sourceKey: string;
  }[],
  starts: readonly number[],
  totalMs: number,
  timeMs: number,
  freshId: () => string,
): ClipAnchor {
  const n = Math.min(clips.length, starts.length);
  if (n === 0 || !Number.isFinite(timeMs) || timeMs >= totalMs) return END;
  // The editor represents an end seek as totalMs - 1 so the preview can show its last frame.
  // Treat that position as append, rather than creating an invisible one-millisecond half.
  if (timeMs > 0 && timeMs >= totalMs - 1) return END;
  const ids = clips.slice(0, n).map((c) => c.id);
  let i = 0;
  while (i + 1 < n && starts[i + 1] <= timeMs) i++;
  const offsetMs = Math.max(0, timeMs - starts[i]);
  if (offsetMs === 0) return anchorAtSlot(i, ids);
  const clip = clips[i];
  const sourceMs = clip.edit.startMs + offsetMs * clip.edit.speed;
  if (sourceMs >= clip.edit.endMs) return anchorAtSlot(i + 1, ids);
  return {
    before: clip.id,
    ...(i + 1 < n ? { next: ids[i + 1] } : {}),
    split: { sourceMs, sourceKey: clip.sourceKey, rightId: freshId(), offsetMs },
  };
}

/**
 * Where the playhead goes for `anchor`: its exact offset before a pending split, the right
 * half's start once committed, or the ordinary boundary/end. `ids`, `starts` and `totalMs` as
 * `anchorForPlayhead`.
 */
export function timeAtAnchor(
  anchor: ClipAnchor,
  ids: readonly string[],
  starts: readonly number[],
  totalMs: number,
): number {
  const slot = anchorSlot(anchor, ids);
  if (!isEnd(anchor) && anchor.split && !ids.includes(anchor.split.rightId)) {
    const original = ids.indexOf(anchor.before);
    if (original >= 0) {
      const start = starts[original] ?? totalMs;
      const end = starts[original + 1] ?? totalMs;
      return Math.min(end, start + anchor.split.offsetMs);
    }
  }
  return slot < ids.length ? (starts[slot] ?? totalMs) : totalMs;
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
  /** The containing clip replaced by this insertion, for one compound Undo/Redo step. */
  split?: SplitReceipt;
};

const listeners = new Set<(added: ClipsAdded) => void>();

/**
 * The drafts an editor is open on, each with the ids added since that editor last took them.
 * Only these drafts are recorded, so nothing piles up for drafts no editor is waiting on (a run of
 * takes in a recorder opened from Home), and an editor never hears of clips added before it
 * opened. `arms` counts the editors on the draft (an editor can sit under another one's recorder).
 */
const expected = new Map<
  string,
  {
    arms: number;
    ids: string[];
    splits: SplitReceipt[];
    returnTo: ClipAnchor | null;
    onDiscard?: (split: SplitReceipt) => void;
  }
>();

/** Told by `insertSegments` once new clips are in a draft. */
export function noteClipsAdded(added: ClipsAdded): boolean {
  if (added.segmentIds.length === 0) return false;
  const entry = expected.get(added.draftId);
  // Every id, uncapped: the editor makes what it takes one undo step, and a step missing some of
  // its clips would leave them behind on Undo. The editor takes them on every focus.
  if (entry) {
    entry.ids = [...entry.ids, ...added.segmentIds];
    if (added.split) entry.splits.push(added.split);
  }
  for (const listener of listeners) {
    try {
      listener(added);
    } catch (e) {
      console.warn('[clip-anchor] a clips-added listener threw', e);
    }
  }
  return entry !== undefined;
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
 * one draft share one list. The final editor closing releases any split receipts it never took.
 */
export function expectClipsAdded(
  draftId: string,
  onDiscard?: (split: SplitReceipt) => void,
): () => void {
  const entry = expected.get(draftId);
  if (entry) {
    entry.arms++;
    entry.onDiscard ??= onDiscard;
  } else expected.set(draftId, { arms: 1, ids: [], splits: [], returnTo: null, onDiscard });
  let armed = true;
  return () => {
    if (!armed) return;
    armed = false;
    const e = expected.get(draftId);
    if (!e) return;
    if (--e.arms <= 0) {
      expected.delete(draftId);
      for (const split of e.splits) {
        try {
          e.onDiscard?.(split);
        } catch (e) {
          console.warn('[clip-anchor] discarding a split receipt failed', e);
        }
      }
    }
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

/** Split receipts stay separate from visible inserted ids while image batches are grouped. */
export function takeClipSplits(draftId: string): SplitReceipt[] {
  const entry = expected.get(draftId);
  if (!entry) return [];
  const { splits } = entry;
  entry.splits = [];
  return splits;
}

/**
 * A recorder over an editor on `draftId` is going back to it on its Edit: the editor's playhead
 * goes to `anchor` (the recorder's insert cursor, or the clip tapped there) as it's back on top,
 * instead of after the clips added meanwhile. Kept only while an editor is armed on the draft; a
 * later call replaces it.
 */
export function returnEditorTo(draftId: string, anchor: ClipAnchor): void {
  const entry = expected.get(draftId);
  if (entry) entry.returnTo = anchor;
}

/** The place `returnEditorTo` left for the draft's editor (null if none), and forget it. */
export function takeEditorReturn(draftId: string): ClipAnchor | null {
  const entry = expected.get(draftId);
  if (!entry) return null;
  const { returnTo } = entry;
  entry.returnTo = null;
  return returnTo;
}

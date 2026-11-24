/**
 * Where new clips go in a draft (issue #308): before a clip, by its segment id, or at the end. The
 * editor's + works it out from the playhead (`anchorForPlayhead`), the recorder holds one as its
 * insert cursor, and `insertSegments` (src/db/drafts.ts) resolves it to a slot when the clips are
 * written, by the rule the cursor shows (`resolveAnchor`).
 *
 * `next` is the clip that followed `before` when the anchor was made: an add that waits (an
 * import converting, a screen take) still lands in the same place if `before` is deleted
 * meanwhile, before `next`. With both gone, or no `next` (`before` was the last clip), the end.
 * The `before` form stays put as clips land at it, so a run of takes or a batch of images lands in
 * order with no move.
 *
 * `onClipsAdded` hears every insert `insertSegments` commits. An open editor arms its draft
 * (`expectClipsAdded`) and takes the clips added to it (`takeClipsAdded`), from its own + or a
 * recorder over it, to place its playhead after them and make the addition one undo step. A
 * recorder over it that goes back to it on its Edit leaves the editor a place instead
 * (`returnEditorTo`): its insert cursor, where the editor's playhead goes (`timeAtAnchor`).
 */

export type ClipAnchor = { before: string; next?: string } | { at: 'end' };

export const END: ClipAnchor = { at: 'end' };

export function isEnd(anchor: ClipAnchor): anchor is { at: 'end' } {
  return 'at' in anchor;
}

export function sameAnchor(a: ClipAnchor, b: ClipAnchor): boolean {
  if (isEnd(a) || isEnd(b)) return isEnd(a) && isEnd(b);
  return a.before === b.before && a.next === b.next;
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

/** `before:<id>`, `before:<id>,<next>` or `end`: plain text, safe as an expo-router param. */
export function anchorToRouteParam(anchor: ClipAnchor): string {
  if (isEnd(anchor)) return 'end';
  return anchor.next ? `before:${anchor.before},${anchor.next}` : `before:${anchor.before}`;
}

/** The anchor `anchorToRouteParam` wrote; anything else (missing, malformed, an array) is the end. */
export function anchorFromRouteParam(param: unknown): ClipAnchor {
  if (typeof param !== 'string' || !param.startsWith('before:')) return END;
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
 * Where the playhead goes for `anchor` (the way back from `anchorForPlayhead`): the start of the
 * clip new clips go before (`anchorSlot`), or `totalMs` at the end. `ids`, `starts` and `totalMs`
 * as there.
 */
export function timeAtAnchor(
  anchor: ClipAnchor,
  ids: readonly string[],
  starts: readonly number[],
  totalMs: number,
): number {
  const slot = anchorSlot(anchor, ids);
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
};

const listeners = new Set<(added: ClipsAdded) => void>();

/**
 * The drafts an editor is open on, each with the ids added since that editor last took them.
 * Only these drafts are recorded, so nothing piles up for drafts no editor is waiting on (a run of
 * takes in a recorder opened from Home), and an editor never hears of clips added before it
 * opened. `arms` counts the editors on the draft (an editor can sit under another one's recorder).
 */
const expected = new Map<string, { arms: number; ids: string[]; returnTo: ClipAnchor | null }>();

/** Told by `insertSegments` once new clips are in a draft. */
export function noteClipsAdded(added: ClipsAdded): void {
  if (added.segmentIds.length === 0) return;
  const entry = expected.get(added.draftId);
  // Every id, uncapped: the editor makes what it takes one undo step, and a step missing some of
  // its clips would leave them behind on Undo. The editor takes them on every focus.
  if (entry) entry.ids = [...entry.ids, ...added.segmentIds];
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
  else expected.set(draftId, { arms: 1, ids: [], returnTo: null });
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

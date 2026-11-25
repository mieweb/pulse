import { reorderSegments, resetEdit, setEditState } from '@/db/drafts';
import { setClipWriteBarrier } from '@/core/draft-write-barrier';

/** An edit as stored, or null for "no edit" (reset). */
export type EditValue = string | null;

/** What's being written: clips with an edit in flight, and whether an order is. */
export type DraftWrites = { edits: ReadonlySet<string>; order: boolean };

/** The newest write that failed (one already replaced by a newer value isn't reported): the clip
 * (an edit) or null (an order), and why. */
export type WriteFailure = { draftId: string; id: string | null; error: unknown };

// The editor's writes live here rather than in one editor: a write still running when the editor
// closes finishes in order with what a reopened editor asks for (one at a time per clip, only the
// newest waiting), and export can wait for them all.
const nextEdit = new Map<string, { draftId: string; value: EditValue }>();
const editing = new Map<string, string>();
const nextOrder = new Map<string, string[]>();
const ordering = new Set<string>();

let snapshot: DraftWrites = { edits: new Set(), order: false };
const listeners = new Set<() => void>();
const failureListeners = new Set<(f: WriteFailure) => void>();
let whenIdle: (() => void)[] = [];
const otherWrites = new Map<Promise<unknown>, string>();
const failureVersions = new Map<string, number>();

function changed() {
  snapshot = { edits: new Set(editing.keys()), order: ordering.size > 0 };
  for (const l of listeners) l();
  if (!hasPendingDraftWrites()) {
    const waiting = whenIdle;
    whenIdle = [];
    for (const resolve of waiting) resolve();
  }
}

const failed = (f: WriteFailure) => {
  noteFailure(f.draftId);
  for (const l of failureListeners) l(f);
};

/** Store `value` for a clip: after the write under way for it, replacing any still waiting. */
export function writeEdit(id: string, value: EditValue, draftId: string) {
  nextEdit.set(id, { draftId, value });
  if (editing.has(id)) return;
  editing.set(id, draftId);
  changed();
  void (async () => {
    while (nextEdit.has(id)) {
      const { value: v, draftId: owner } = nextEdit.get(id)!;
      nextEdit.delete(id);
      try {
        if (v === null) await resetEdit(id);
        else await setEditState(id, v);
      } catch (error) {
        // A newer value is queued: it's what the editor shows and what gets stored, so this one
        // failing changes nothing the person sees.
        if (!nextEdit.has(id)) failed({ draftId: owner, id, error });
      }
    }
    editing.delete(id);
    changed();
  })();
}

/** Put the draft's clips in `order`: after the reorder under way, replacing any still waiting. */
export function writeOrder(order: string[], draftId: string) {
  nextOrder.set(draftId, order);
  if (ordering.has(draftId)) return;
  ordering.add(draftId);
  changed();
  void (async () => {
    while (nextOrder.has(draftId)) {
      const o = nextOrder.get(draftId)!;
      nextOrder.delete(draftId);
      try {
        await reorderSegments(o);
      } catch (error) {
        if (!nextOrder.has(draftId)) failed({ draftId, id: null, error });
      }
    }
    ordering.delete(draftId);
    changed();
  })();
}

/** For useSyncExternalStore. */
export function subscribeWrites(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const getWrites = () => snapshot;

/** Told of every write that fails, until the returned function is called. */
export function onWriteFailure(listener: (f: WriteFailure) => void) {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}

/** Resolves once every edit and reorder asked for so far is stored (or failed). */
export function flushDraftWrites(): Promise<void> {
  if (!hasPendingDraftWrites()) return Promise.resolve();
  return new Promise((resolve) => whenIdle.push(resolve));
}

/** Caption text/position writes participate in the same checkpoint barrier as clip edits. */
export function trackDraftWrite<T>(draftId: string, write: Promise<T>): Promise<T> {
  const tracked = write
    .catch((error: unknown) => {
      noteFailure(draftId);
      throw error;
    })
    .finally(() => {
      otherWrites.delete(tracked);
      changed();
    });
  otherWrites.set(tracked, draftId);
  return tracked;
}

function noteFailure(draftId: string): void {
  failureVersions.set(draftId, draftWriteFailureVersion(draftId) + 1);
}

/** A failed save invalidates only the owning draft's optimistic Undo/Redo session. */
export const draftWriteFailureVersion = (draftId: string) => failureVersions.get(draftId) ?? 0;
export const hasPendingDraftWrites = (draftId?: string) =>
  draftId === undefined
    ? editing.size > 0 || ordering.size > 0 || otherWrites.size > 0
    : [...editing.values()].includes(draftId) ||
      ordering.has(draftId) ||
      [...otherWrites.values()].includes(draftId);

setClipWriteBarrier(flushDraftWrites);

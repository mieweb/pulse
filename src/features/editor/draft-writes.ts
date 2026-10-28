import { reorderSegments, resetEdit, setEditState } from '@/db/drafts';

/** An edit as stored, or null for "no edit" (reset). */
export type EditValue = string | null;

/** What's being written: clips with an edit in flight, and whether an order is. */
export type DraftWrites = { edits: ReadonlySet<string>; order: boolean };

/** The newest write that failed (one already replaced by a newer value isn't reported): the clip
 * (an edit) or null (an order), and why. */
export type WriteFailure = { id: string | null; error: unknown };

// The editor's writes live here rather than in one editor: a write still running when the editor
// closes finishes in order with what a reopened editor asks for (one at a time per clip, only the
// newest waiting), and export can wait for them all.
const nextEdit = new Map<string, EditValue>();
const editing = new Set<string>();
let nextOrder: string[] | null = null;
let ordering = false;

let snapshot: DraftWrites = { edits: new Set(), order: false };
const listeners = new Set<() => void>();
const failureListeners = new Set<(f: WriteFailure) => void>();
let whenIdle: (() => void)[] = [];

function changed() {
  snapshot = { edits: new Set(editing), order: ordering };
  for (const l of listeners) l();
  if (editing.size === 0 && !ordering) {
    const waiting = whenIdle;
    whenIdle = [];
    for (const resolve of waiting) resolve();
  }
}

const failed = (f: WriteFailure) => {
  for (const l of failureListeners) l(f);
};

/** Store `value` for a clip: after the write under way for it, replacing any still waiting. */
export function writeEdit(id: string, value: EditValue) {
  nextEdit.set(id, value);
  if (editing.has(id)) return;
  editing.add(id);
  changed();
  void (async () => {
    while (nextEdit.has(id)) {
      const v = nextEdit.get(id) ?? null;
      nextEdit.delete(id);
      try {
        if (v === null) await resetEdit(id);
        else await setEditState(id, v);
      } catch (error) {
        // A newer value is queued: it's what the editor shows and what gets stored, so this one
        // failing changes nothing the person sees.
        if (!nextEdit.has(id)) failed({ id, error });
      }
    }
    editing.delete(id);
    changed();
  })();
}

/** Put the draft's clips in `order`: after the reorder under way, replacing any still waiting. */
export function writeOrder(order: string[]) {
  nextOrder = order;
  if (ordering) return;
  ordering = true;
  changed();
  void (async () => {
    while (nextOrder) {
      const o = nextOrder;
      nextOrder = null;
      try {
        await reorderSegments(o);
      } catch (error) {
        if (!nextOrder) failed({ id: null, error });
      }
    }
    ordering = false;
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
  if (editing.size === 0 && !ordering) return Promise.resolve();
  return new Promise((resolve) => whenIdle.push(resolve));
}

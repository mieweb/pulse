import type { FlowScreen, OpenRequest } from '@mieweb/pulse-embed';

import {
  flowReducer,
  initFlow,
  type FlowEvent,
  type FlowState,
  type OpenedDraft,
} from '../flow/reducer';

/**
 * The flow's state outside React: the pure reducer (flow/reducer.ts) plus a key per stack item, so
 * FlowStack keeps a screen mounted while it stays in the stack and mounts a fresh one when it is
 * pushed again. The shell ends the flow from outside the screens too (the host's `close`, a
 * library it can't open), so the state can't live in a component.
 */
export type StackItem = {
  key: string;
  screen: FlowScreen;
  /** The editor opens on this clip (a clip tapped in the recorder, or the edit entry's clipId). */
  clipId?: string;
};

export type FlowSnapshot = { readonly state: FlowState; readonly items: readonly StackItem[] };

/**
 * The items for `stack`: the bottom items that are still the same screen keep their keys (and
 * stay mounted); the rest are new. A new editor takes `clipId`.
 */
export function stackItems(
  prev: readonly StackItem[],
  stack: readonly FlowScreen[],
  newKey: (screen: FlowScreen) => string,
  clipId?: string,
): StackItem[] {
  let kept = 0;
  while (kept < prev.length && kept < stack.length && prev[kept].screen === stack[kept]) kept++;
  return [
    ...prev.slice(0, kept),
    ...stack.slice(kept).map((screen) => ({
      key: newKey(screen),
      screen,
      ...(screen === 'editor' && clipId ? { clipId } : null),
    })),
  ];
}

export function createFlowStore(opts: {
  requestId: string;
  request: OpenRequest;
  /** Runs once, as the flow first has an end. */
  onEnd: (state: FlowState) => void;
}) {
  let seq = 0;
  const newKey = (screen: FlowScreen) => `${screen}-${seq++}`;
  const { requestId, request } = opts;
  const firstClip = request.entry === 'edit' ? request.clipId : undefined;
  const first = initFlow(requestId, request);
  let snapshot: FlowSnapshot = {
    state: first,
    items: stackItems([], first.stack, newKey, firstClip),
  };
  const listeners = new Set<() => void>();

  const set = (next: FlowSnapshot) => {
    const ended = next.state.end && !snapshot.state.end;
    snapshot = next;
    listeners.forEach((l) => l());
    if (ended) opts.onEnd(next.state);
  };

  return {
    getSnapshot: (): FlowSnapshot => snapshot,
    state: (): FlowState => snapshot.state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * What the library says about the draft an edit, export or record-continue opens, once it can
     * be read (the library's migrations run first). Only before the first screen draws.
     */
    open(draft: OpenedDraft): void {
      const { state } = snapshot;
      if (state.mounted || state.end) return;
      set({ state: initFlow(requestId, request, draft), items: snapshot.items });
    },
    /** Feed `event` to the reducer; a new editor it shows opens on `clipId`. */
    dispatch(event: FlowEvent, extra?: { clipId?: string }): void {
      const state = flowReducer(snapshot.state, event);
      if (state === snapshot.state) return;
      const items =
        state.stack === snapshot.state.stack
          ? snapshot.items
          : stackItems(snapshot.items, state.stack, newKey, extra?.clipId);
      set({ state, items });
    },
  };
}

export type FlowStore = ReturnType<typeof createFlowStore>;

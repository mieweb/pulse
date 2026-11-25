import type { FlowScreen, OpenRequest, PulseErrorInfo } from '@mieweb/pulse-embed';

import { type ClipAnchor, returnEditorTo } from '@/core/clip-anchor';
import { editAnchor } from '@/features/recorder/insert-point';

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
  /**
   * A recorder: its insert cursor starts here (the editor's "Record a clip here"). An editor: it
   * opens at this boundary (the recorder's insert cursor, on its Edit).
   */
  anchor?: ClipAnchor;
};

/** What a screen pushed by an event opens with. */
export type PushedWith = { clipId?: string; anchor?: ClipAnchor };

export type FlowSnapshot = { readonly state: FlowState; readonly items: readonly StackItem[] };

/**
 * The items for `stack`: the bottom items that are still the same screen keep their keys (and
 * stay mounted); the rest are new. A new editor takes `clipId`, else `anchor`; a new recorder
 * `anchor`.
 */
export function stackItems(
  prev: readonly StackItem[],
  stack: readonly FlowScreen[],
  newKey: (screen: FlowScreen) => string,
  { clipId, anchor }: PushedWith = {},
): StackItem[] {
  let kept = 0;
  while (kept < prev.length && kept < stack.length && prev[kept].screen === stack[kept]) kept++;
  return [
    ...prev.slice(0, kept),
    ...stack.slice(kept).map((screen) => ({
      key: newKey(screen),
      screen,
      ...(screen === 'editor' && clipId ? { clipId } : null),
      ...((screen === 'recorder' || (screen === 'editor' && !clipId)) && anchor
        ? { anchor }
        : null),
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
    items: stackItems([], first.stack, newKey, { clipId: firstClip }),
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
    /**
     * The draft the entry opens doesn't exist: the flow ends `failed{error}` before any screen,
     * naming no draft (the reducer's failure would name the missing one). Ending the store, not
     * just writing a result, keeps a host `close` that comes after it from ending the flow again.
     */
    missing(error: PulseErrorInfo): void {
      const { state } = snapshot;
      if (state.mounted || state.end) return;
      set({ state: { ...state, end: { status: 'failed', error } }, items: snapshot.items });
    },
    /**
     * Feed `event` to the reducer. The recorder `addClips` pushes starts its insert cursor at the
     * event's anchor. The editor `edit` shows opens `at` the clip tapped or the recorder's cursor;
     * an editor it goes back to (the recorder was over it) is left that place (`returnEditorTo`),
     * so its playhead goes there as it's back on top.
     */
    dispatch(event: FlowEvent): void {
      const state = flowReducer(snapshot.state, event);
      if (state === snapshot.state) return;
      const pushed: PushedWith =
        event.type === 'addClips'
          ? { anchor: event.anchor }
          : event.type === 'edit' && event.at
            ? 'clipId' in event.at
              ? { clipId: event.at.clipId }
              : { anchor: event.at.anchor }
            : {};
      const items =
        state.stack === snapshot.state.stack
          ? snapshot.items
          : stackItems(snapshot.items, state.stack, newKey, pushed);
      const top = items[items.length - 1];
      if (event.type === 'edit' && event.at && state.draftId && snapshot.items.includes(top)) {
        returnEditorTo(state.draftId, editAnchor(event.at));
      }
      set({ state, items });
    },
  };
}

export type FlowStore = ReturnType<typeof createFlowStore>;

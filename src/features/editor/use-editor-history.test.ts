import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Present, Step } from './editor-history';
import { createEditorHistory, type EditorHistoryStore } from './editor-history-store';
import type { EditorClip } from './use-editor-draft';
import { useEditorHistory } from './use-editor-history';

// Keep the hook's one state slot across renders; the actual history store supplies its snapshots.
// Effects and native rendering are unnecessary for readiness gating and the commands it exposes.
let mockState: unknown;
jest.mock('react', () => ({
  useState: (initial: () => unknown) => {
    mockState ??= initial();
    return [mockState, () => {}];
  },
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
let mockStore: EditorHistoryStore;
jest.mock('@/features/editor/persistent-editor-history', () => ({
  editorUndoSession: () => ({ store: mockStore, open: () => () => {}, changed: () => {} }),
}));
jest.mock('@/features/toast/toast-provider', () => ({
  useToast: () => ({ showToast: () => {} }),
}));

const snapshot = (edit: string, caption: string, y: number): Step => ({
  kind: 'state',
  snapshot: { order: ['a'], edits: { a: edit }, captions: { a: caption }, captionY: y },
});
const setValue = jest.fn();
const reorder = jest.fn();
const setCaptions = jest.fn();
const setCaptionY = jest.fn();
function render(ready: boolean, now: Present) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Controlled hook harness without a renderer.
  return useEditorHistory(
    'draft',
    ready,
    now.clips as EditorClip[],
    setValue,
    reorder,
    now.captions,
    setCaptions,
    now.captionY,
    setCaptionY,
  );
}
const unloaded: Present = { clips: [], captions: new Map(), captionY: null };
const loaded: Present = {
  clips: [{ id: 'a', editKey: 'current-edit' }],
  captions: new Map([['a', 'current-caption']]),
  captionY: 0.6,
};

beforeEach(() => {
  mockState = undefined;
  jest.clearAllMocks();
  mockStore = createEditorHistory({
    initial: {
      past: [snapshot('prior-edit', 'prior-caption', 0.3)],
      future: [snapshot('later-edit', 'later-caption', 0.8)],
      lastOp: null,
    },
    flush: async () => {},
    takeOut: async () => null,
    restore: async () => {},
    drop: async () => {},
    failed: () => {},
  });
});

describe('useEditorHistory initial query readiness', () => {
  it('keeps saved stacks intact until both the clips and caption position have loaded', () => {
    const saved = mockStore.getState();
    const pending = render(false, unloaded);
    expect(pending.canUndo).toBe(false);
    expect(pending.canRedo).toBe(false);
    pending.undo();
    pending.redo();
    pending.record(null);
    expect(mockStore.getState()).toBe(saved);
    expect(setValue).not.toHaveBeenCalled();
    expect(setCaptions).not.toHaveBeenCalled();
    expect(setCaptionY).not.toHaveBeenCalled();

    const ready = render(true, loaded);
    expect(ready.canUndo).toBe(true);
    expect(ready.canRedo).toBe(true);
    ready.undo();
    expect(setValue).toHaveBeenCalledWith('a', 'prior-edit');
    expect(setCaptions).toHaveBeenCalledWith(new Map([['a', 'prior-caption']]));
    expect(setCaptionY).toHaveBeenCalledWith(0.3);
    // Redo must remember the loaded current draft, never the empty initial live-query result.
    expect(mockStore.getState().future.at(-1)).toEqual(
      snapshot('current-edit', 'current-caption', 0.6),
    );
    const undone: Present = {
      clips: [{ id: 'a', editKey: 'prior-edit' }],
      captions: new Map([['a', 'prior-caption']]),
      captionY: 0.3,
    };
    render(true, undone).redo();
    expect(setValue).toHaveBeenLastCalledWith('a', 'current-edit');
    expect(setCaptions).toHaveBeenLastCalledWith(new Map([['a', 'current-caption']]));
    expect(setCaptionY).toHaveBeenLastCalledWith(0.6);
  });

  it('still accepts committed clip additions and batch completion while queries load', async () => {
    const pending = render(false, unloaded);
    await pending.beginBatch('images');
    pending.recordAdded(['added'], [], 'images');
    expect(mockStore.getState().batchOpen).toBe(true);
    pending.endBatch('images');
    expect(mockStore.getState().batchOpen).toBe(false);
    expect(mockStore.getState().past.at(-1)).toMatchObject({ kind: 'added', ids: ['added'] });
    expect(render(false, unloaded).canUndo).toBe(false);
    expect(render(true, loaded).canUndo).toBe(true);
  });
});

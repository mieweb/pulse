import { describe, expect, it } from '@jest/globals';
import type { OpenRequest, PulseContext } from '@mieweb/pulse-embed';

import type { FlowState } from '../flow/reducer';
import { createFlowStore, stackItems, type StackItem } from './flow-store';

const context: PulseContext = {
  key: 'ticket:t-42',
  kind: 'ticket',
  id: 'T-42',
  label: 'Fix login',
};
const record: OpenRequest = { entry: 'record', context };

function store(request: OpenRequest = record) {
  const ended: FlowState[] = [];
  const s = createFlowStore({ requestId: 'r1', request, onEnd: (state) => void ended.push(state) });
  return { s, ended, keys: () => s.getSnapshot().items.map((i) => `${i.key}`) };
}

describe('stackItems', () => {
  let n = 0;
  const key = (screen: string) => `${screen}-${n++}`;

  it('keeps the items still in place and makes new ones for the rest', () => {
    const prev: StackItem[] = [
      { key: 'recorder-0', screen: 'recorder' },
      { key: 'editor-1', screen: 'editor', clipId: 'c1' },
    ];
    expect(stackItems(prev, ['recorder', 'editor', 'export'], () => 'export-9')).toEqual([
      ...prev,
      { key: 'export-9', screen: 'export' },
    ]);
    expect(stackItems(prev, ['recorder'], key)).toEqual([prev[0]]);
    // A different screen at a position is a new item, whatever was there.
    expect(stackItems(prev, ['recorder', 'export'], () => 'export-8')).toEqual([
      prev[0],
      { key: 'export-8', screen: 'export' },
    ]);
  });

  it('gives a clip only to a new editor', () => {
    const items = stackItems([], ['editor', 'recorder'], key, 'c2');
    expect(items.map((i) => i.clipId)).toEqual(['c2', undefined]);
  });
});

describe('createFlowStore', () => {
  it('mounts a fresh editor when one is pushed again, and keeps the recorder under it', () => {
    const { s, keys } = store();
    s.dispatch({ type: 'mounted' });
    s.dispatch({ type: 'record' });
    s.dispatch({ type: 'stop', draftId: 'd1', clipCount: 1 });
    const [recorder] = keys();
    s.dispatch({ type: 'edit' }, { clipId: 'c1' });
    const [, editor] = keys();
    expect(s.getSnapshot().items[1]).toEqual({ key: editor, screen: 'editor', clipId: 'c1' });
    s.dispatch({ type: 'back' });
    s.dispatch({ type: 'edit' });
    expect(keys()[0]).toBe(recorder);
    expect(keys()[1]).not.toBe(editor);
    expect(s.getSnapshot().items[1].clipId).toBeUndefined();
  });

  it('keeps the same snapshot when an event changes nothing', () => {
    const { s } = store();
    const before = s.getSnapshot();
    s.dispatch({ type: 'edit' }); // no clip yet
    expect(s.getSnapshot()).toBe(before);
  });

  it('opens the edit entry on its clip', () => {
    const { s } = store({ entry: 'edit', draftId: 'd1', clipId: 'c9' });
    expect(s.getSnapshot().items).toEqual([{ key: 'editor-0', screen: 'editor', clipId: 'c9' }]);
  });

  it('takes the opened draft only before the first screen draws', () => {
    const { s } = store({ entry: 'edit', draftId: 'd1' });
    s.open({ context: null, clipCount: 3 });
    expect(s.state().clipCount).toBe(3);
    s.dispatch({ type: 'mounted' });
    s.open({ context: null, clipCount: 5 });
    expect(s.state().clipCount).toBe(3);
  });

  it('ends once, telling subscribers first', () => {
    const { s, ended } = store();
    const order: string[] = [];
    s.subscribe(() => order.push(s.state().end ? 'ended' : 'changed'));
    s.dispatch({ type: 'mounted' });
    s.dispatch({ type: 'close' }); // no take: canceled
    s.dispatch({ type: 'hostClose' });
    expect(ended.map((e) => e.end)).toEqual([{ status: 'canceled', reason: 'user' }]);
    expect(order).toEqual(['changed', 'ended']);
  });
});

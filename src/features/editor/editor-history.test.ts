import { describe, expect, it } from '@jest/globals';

import type { TakenOutClips } from '@/db/drafts';
import { emptyHistory, record, type History } from '@/features/transcription/edit-history';

import {
  diffSnapshot,
  keepEmptyEditorOpen,
  planStep,
  restoreOrder,
  snapshotOf,
  takenOut,
  type Present,
  type Step,
} from './editor-history';

const present = (ids: string[], edits: Record<string, string | null> = {}): Present => ({
  clips: ids.map((id) => ({ id, editKey: edits[id] ?? null })),
  captions: new Map(),
  captionY: null,
});
const state = (p: Present): Step => ({ kind: 'state', snapshot: snapshotOf(p) });
const taken = (ids: string[]): TakenOutClips => ({
  draftId: 'd',
  order: ids,
  rows: [],
  transcripts: [],
});
const push = (h: History<Step>, step: Step) => record(h, step, null, 0);

describe('restoreOrder', () => {
  it('restores the order of the clips the step names', () => {
    expect(restoreOrder(['b', 'a', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('keeps a clip added after the step next to the clip it follows, not at the end', () => {
    // a b c reordered to b a c, then n inserted after a: undoing the reorder.
    expect(restoreOrder(['b', 'a', 'n', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'n', 'b', 'c']);
  });

  it('keeps a run of added clips together, and added clips that lead at the front', () => {
    expect(restoreOrder(['n', 'm', 'c', 'b', 'a'], ['a', 'b', 'c'])).toEqual([
      'n',
      'm',
      'a',
      'b',
      'c',
    ]);
    expect(restoreOrder(['b', 'a', 'x', 'y', 'c'], ['a', 'b', 'c'])).toEqual([
      'a',
      'x',
      'y',
      'b',
      'c',
    ]);
  });

  it('skips clips the step names that have gone', () => {
    expect(restoreOrder(['c', 'a'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });
});

describe('diffSnapshot', () => {
  it('is empty when nothing differs, and leaves added clips where they are', () => {
    const before = snapshotOf(present(['a', 'b']));
    expect(diffSnapshot(before, present(['a', 'n', 'b']))).toEqual({
      edits: [],
      captions: new Map(),
      captionY: undefined,
      order: null,
    });
  });

  it('writes back the edits of clips still here and skips deleted ones', () => {
    const before = snapshotOf(present(['a', 'b'], { a: 'e1', b: 'e2' }));
    const diff = diffSnapshot(before, present(['a'], { a: 'e3' }));
    expect(diff.edits).toEqual([['a', 'e1']]);
    expect(diff.order).toBeNull();
  });
});

describe('planStep', () => {
  it('undoes an addition by taking out the clips still in the draft', () => {
    const added: Step = { kind: 'added', ids: ['x', 'y'], taken: null };
    const h = push(emptyHistory<Step>(), added);
    const plan = planStep(h, 'undo', present(['a', 'x', 'b']));
    expect(plan).toMatchObject({ kind: 'takeOut', ids: ['x'], step: added });
  });

  it('drops an addition whose clips have all gone, and goes on to the step before', () => {
    let h = push(emptyHistory<Step>(), state(present(['b', 'a'])));
    h = push(h, { kind: 'added', ids: ['x'], taken: null });
    const plan = planStep(h, 'undo', present(['a', 'b']));
    expect(plan.kind).toBe('state');
    if (plan.kind === 'state') expect(plan.diff.order).toEqual(['b', 'a']);
    expect(plan.history.past).toEqual([]);
  });

  it('takes out an addition even when deleting the original leaves only its clips', () => {
    const added: Step = { kind: 'added', ids: ['x'], taken: null };
    const h = push(emptyHistory<Step>(), added);
    const plan = planStep(h, 'undo', present(['x']));
    expect(plan).toMatchObject({ kind: 'takeOut', ids: ['x'], step: added });
    expect(plan.history).toBe(h);
  });

  it('undoes the final addition before older draft-wide edits', () => {
    // The captions moved (a draft-wide step), x added, then a deleted: x is all that's left.
    const moved: Present = { ...present(['a']), captionY: 0.2 };
    let h = push(emptyHistory<Step>(), state(moved));
    h = push(h, { kind: 'added', ids: ['x'], taken: null });
    const now: Present = { ...present(['x']), captionY: 0.8 };
    const plan = planStep(h, 'undo', now);
    expect(plan).toMatchObject({ kind: 'takeOut', ids: ['x'] });
    expect(plan.history.past).toEqual([state(moved), { kind: 'added', ids: ['x'], taken: null }]);
  });

  it('redoes an addition that has what was taken out', () => {
    const out = taken(['a', 'x']);
    const h = {
      ...emptyHistory<Step>(),
      future: [{ kind: 'added', ids: ['x'], taken: out }] as Step[],
    };
    const plan = planStep(h, 'redo', present(['a']));
    expect(plan.kind).toBe('putBack');
    if (plan.kind === 'putBack') expect(plan.step.taken).toBe(out);
    expect(takenOut(h.future)).toEqual([out]);
  });

  it('undoing a reorder made before an insert keeps the inserted clip in place', () => {
    // a b c reordered to b a c (the step holds a b c), then x inserted after a.
    const h = push(emptyHistory<Step>(), state(present(['a', 'b', 'c'])));
    const plan = planStep(h, 'undo', present(['b', 'a', 'x', 'c']));
    if (plan.kind !== 'state') throw new Error(plan.kind);
    expect(plan.diff.order).toEqual(['a', 'x', 'b', 'c']);
    // Its redo restores the reorder with x still after a.
    expect(plan.history.future).toEqual([state(present(['b', 'a', 'x', 'c']))]);
  });

  it('a state step that changes nothing is dropped and the next one tried', () => {
    let h = push(emptyHistory<Step>(), state(present(['a'], { a: 'e1' })));
    h = push(h, state(present(['a'], { a: 'e2' })));
    const plan = planStep(h, 'undo', present(['a'], { a: 'e2' }));
    expect(plan.kind).toBe('state');
    if (plan.kind === 'state') expect(plan.diff.edits).toEqual([['a', 'e1']]);
    expect(plan.history.past).toEqual([]);
  });
});

describe('empty editor after addition undo', () => {
  it('stays open through empty database updates until restored clips are observed', () => {
    let retained = false;
    const render = (clips: number, historyKeepsOpen: boolean) => {
      retained = keepEmptyEditorOpen(retained, clips, historyKeepsOpen);
      return retained;
    };
    expect(render(1, false)).toBe(false);
    expect(render(1, true)).toBe(true); // undo starts before the row disappears
    expect(render(0, true)).toBe(true); // undo commits and keeps the clip for redo
    expect(render(0, true)).toBe(true); // redo starts, its future stack is temporarily empty
    expect(render(0, false)).toBe(true); // redo committed, live query still has the old rows
    expect(render(1, false)).toBe(false); // the restored clip reaches the screen
    expect(render(0, false)).toBe(false); // ordinary deletion can close the editor again
  });

  it('does not retain an empty draft with no recoverable addition', () => {
    expect(keepEmptyEditorOpen(false, 0, false)).toBe(false);
  });
});

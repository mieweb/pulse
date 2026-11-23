import { describe, expect, it } from '@jest/globals';

import type { TakenOutClips } from '@/db/drafts';
import { emptyHistory, record, type History } from '@/features/transcription/edit-history';

import {
  diffSnapshot,
  planStep,
  redoAdded,
  restoreOrder,
  snapshotOf,
  takenOut,
  undoAdded,
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

  it('drops an addition that would leave the draft with no clips', () => {
    const h = push(emptyHistory<Step>(), { kind: 'added', ids: ['x'], taken: null });
    const plan = planStep(h, 'undo', present(['x']));
    expect(plan).toMatchObject({ kind: 'none', history: { past: [] } });
  });

  it('undo, then redo, of an addition moves the same step between the stacks', () => {
    const added: Step = { kind: 'added', ids: ['x'], taken: null };
    const h = push(push(emptyHistory<Step>(), state(present(['a']))), added);
    const plan = planStep(h, 'undo', present(['a', 'x']));
    if (plan.kind !== 'takeOut') throw new Error(plan.kind);
    const out = taken(['a', 'x']);
    const undone = undoAdded(plan.history, plan.step, out)!;
    expect(undone.past).toHaveLength(1);
    expect(undone.future).toEqual([{ kind: 'added', ids: ['x'], taken: out }]);
    expect(takenOut(undone.future)).toEqual([out]);

    const again = planStep(undone, 'redo', present(['a']));
    if (again.kind !== 'putBack') throw new Error(again.kind);
    expect(again.step.taken).toBe(out);
    const redone = redoAdded(again.history, again.step)!;
    expect(redone.future).toEqual([]);
    expect(redone.past[redone.past.length - 1]).toEqual(added);
  });

  it('won’t move an addition that is no longer on top (a change came in meanwhile)', () => {
    const added: Step = { kind: 'added', ids: ['x'], taken: null };
    const h = push(push(emptyHistory<Step>(), added), state(present(['a', 'x'])));
    expect(undoAdded(h, added, taken(['a', 'x']))).toBeNull();
    expect(redoAdded(h, added)).toBeNull();
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

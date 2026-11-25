import { describe, expect, it } from '@jest/globals';
import type { OpenRequest, PulseContext } from '@mieweb/pulse-embed';

import { flowReducer, initFlow, type FlowEvent, type FlowState } from '../flow/reducer';
import { syncEvents, type DraftSeen } from './draft-sync';

const context: PulseContext = {
  key: 'ticket:t-42',
  kind: 'ticket',
  id: 'T-42',
  label: 'Fix login',
};
const record: OpenRequest = { entry: 'record', context };

const run = (state: FlowState, ...events: FlowEvent[]) => events.reduce(flowReducer, state);
const seen = (over: Partial<DraftSeen> = {}): DraftSeen => ({
  draftId: 'd1',
  clipCount: 1,
  lastModified: 100,
  ...over,
});
/** Feed what the library shows into the flow, as the shell does. */
const sync = (state: FlowState, now: DraftSeen, last: DraftSeen | null = null) =>
  run(state, ...syncEvents(state, now, last));

describe('syncEvents', () => {
  it('turns a first take on a new recording into record + stop', () => {
    const s = run(initFlow('r1', record), { type: 'mounted' });
    expect(syncEvents(s, seen(), null)).toEqual([
      { type: 'record' },
      { type: 'stop', draftId: 'd1', clipCount: 1 },
    ]);
    const after = sync(s, seen());
    expect(after).toMatchObject({ draftId: 'd1', clipCount: 1, stage: 'recorded', changed: true });
    // Read again with nothing new: nothing to do.
    expect(syncEvents(after, seen(), seen())).toEqual([]);
  });

  it('waits for the first clip of a new recording, so an empty draft row is no take', () => {
    const s = run(initFlow('r1', record), { type: 'mounted' });
    const empty = seen({ clipCount: 0 });
    expect(syncEvents(s, empty, null)).toEqual([]);
    // The take or import was dropped: X ends the flow with no clip and no stage.
    const closed = run(sync(s, empty), { type: 'close' });
    expect(closed.end).toEqual({ status: 'canceled', reason: 'user' });
    expect(closed.stage).toBe('none');
    // The clip lands: now it's a take.
    expect(syncEvents(s, seen(), empty)).toEqual([
      { type: 'record' },
      { type: 'stop', draftId: 'd1', clipCount: 1 },
    ]);
  });

  it('follows a take deleted from the recorder’s clip bar, so X with none left creates no draft', () => {
    let s = sync(run(initFlow('r1', record), { type: 'mounted' }), seen());
    s = sync(s, seen({ clipCount: 0, lastModified: 200 }), seen());
    expect(s.clipCount).toBe(0);
    s = run(s, { type: 'close' });
    expect(s.end).toEqual({ status: 'canceled', reason: 'user' });
    expect(s.deleteDraft).toBe('d1');
  });

  it('reads a change on the editor as an edit, even with the clip count unchanged', () => {
    const opened = run(
      initFlow('r1', { entry: 'edit', draftId: 'd1' }, { context: null, clipCount: 2 }),
      { type: 'mounted' },
    );
    const base = seen({ clipCount: 2 });
    expect(syncEvents(opened, base, base)).toEqual([]);
    const trimmed = seen({ clipCount: 2, lastModified: 150 });
    expect(syncEvents(opened, trimmed, base)).toEqual([{ type: 'edited', clipCount: 2 }]);
    const s = sync(opened, trimmed, base);
    expect(run(s, { type: 'close' }).end).toEqual({
      status: 'closed',
      reason: 'user',
      draftId: 'd1',
    });
  });

  it('leaves an opened draft nobody changed as canceled', () => {
    const opened = run(
      initFlow('r1', { entry: 'edit', draftId: 'd1' }, { context: null, clipCount: 2 }),
      { type: 'mounted' },
    );
    const base = seen({ clipCount: 2 });
    const s = sync(opened, base, base);
    expect(run(s, { type: 'close' }).end).toEqual({
      status: 'canceled',
      reason: 'user',
      draftId: 'd1',
    });
  });

  it("leaves Export's readiness to Export: the library's rows don't say it", () => {
    let s = sync(run(initFlow('r1', record), { type: 'mounted' }), seen());
    s = run(s, { type: 'edit' }, { type: 'export' });
    expect(syncEvents(s, seen({ lastModified: 200 }), seen())).toEqual([]);
  });

  it('retains a newly created empty draft whose first observed state has a redo-only addition', () => {
    const initial = run(initFlow('r1', record), { type: 'mounted' });
    const dormant = seen({ clipCount: 0, retainedUndo: true });
    expect(syncEvents(initial, dormant, null)).toEqual([
      { type: 'undoRetention', retainedUndo: true },
      { type: 'record' },
      { type: 'stop', draftId: 'd1', clipCount: 0 },
    ]);
    const state = sync(initial, dormant);
    expect(state).toMatchObject({ draftId: 'd1', clipCount: 0, retainedUndo: true, stage: 'none' });
    const closed = run(state, { type: 'hostClose' });
    expect(closed.end).toEqual({ status: 'closed', reason: 'host', draftId: 'd1' });
    expect(closed.deleteDraft).toBeNull();
  });

  it('tracks retained Undo changes even with the same zero count and timestamp', () => {
    const recorded = sync(run(initFlow('r1', record), { type: 'mounted' }), seen());
    const editor = run(recorded, { type: 'edit' });
    const dormant = seen({ clipCount: 0, lastModified: 200, retainedUndo: true });
    const emptied = sync(editor, dormant, seen());
    expect(emptied).toMatchObject({ clipCount: 0, retainedUndo: true });
    expect(run(emptied, { type: 'close' }).sheet).toBe('exit');
    const noRedo = { ...dormant, retainedUndo: false };
    expect(syncEvents(emptied, noRedo, dormant)).toEqual([
      { type: 'undoRetention', retainedUndo: false },
    ]);
    const discarded = run(sync(emptied, noRedo, dormant), { type: 'hostClose' });
    expect(discarded.end).toEqual({ status: 'canceled', reason: 'host' });
    expect(discarded.deleteDraft).toBe('d1');
  });

  it('refreshes retention on the recorder and Export without inventing another take or edit', () => {
    const recording = sync(run(initFlow('r1', record), { type: 'mounted' }), seen());
    const retained = seen({ retainedUndo: true });
    expect(syncEvents(recording, retained, seen())).toEqual([
      { type: 'undoRetention', retainedUndo: true },
    ]);
    const exporting = run(recording, { type: 'edit' }, { type: 'export' });
    expect(syncEvents(exporting, retained, seen())).toEqual([
      { type: 'undoRetention', retainedUndo: true },
    ]);
    const untouched = initFlow('r1', { entry: 'edit', draftId: 'd1' }, { context, clipCount: 1 });
    const fresh = sync(untouched, retained, seen());
    expect(fresh.changed).toBe(false);
    expect(run(fresh, { type: 'hostClose' }).end).toEqual({
      status: 'canceled',
      reason: 'host',
      draftId: 'd1',
    });
  });

  it('ignores another draft, an ended flow and a draft that is gone', () => {
    const s = sync(run(initFlow('r1', record), { type: 'mounted' }), seen());
    expect(syncEvents(s, seen({ draftId: 'd2', clipCount: 4 }), null)).toEqual([]);
    expect(syncEvents(s, null, seen())).toEqual([]);
    const ended = run(s, { type: 'hostClose' });
    expect(syncEvents(ended, seen({ clipCount: 3 }), seen())).toEqual([]);
  });
});

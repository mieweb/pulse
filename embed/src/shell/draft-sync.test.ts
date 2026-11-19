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
  mergedSignature: null,
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

  it('marks a new merge on Export as merged', () => {
    let s = sync(run(initFlow('r1', record), { type: 'mounted' }), seen());
    s = run(s, { type: 'edit' }, { type: 'export' });
    const merged = seen({ mergedSignature: 'sig-1' });
    expect(syncEvents(s, merged, seen())).toEqual([{ type: 'merged' }]);
    expect(sync(s, merged, seen()).stage).toBe('exported');
    expect(syncEvents(s, merged, merged)).toEqual([]);
  });

  it('ignores another draft, an ended flow and a draft that is gone', () => {
    const s = sync(run(initFlow('r1', record), { type: 'mounted' }), seen());
    expect(syncEvents(s, seen({ draftId: 'd2', clipCount: 4 }), null)).toEqual([]);
    expect(syncEvents(s, null, seen())).toEqual([]);
    const ended = run(s, { type: 'hostClose' });
    expect(syncEvents(ended, seen({ clipCount: 3 }), seen())).toEqual([]);
  });
});

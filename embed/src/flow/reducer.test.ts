import { describe, expect, it } from '@jest/globals';
import type { OpenRequest, PulseContext, PulseErrorInfo } from '@mieweb/pulse-embed';

import {
  exitSheetCopy,
  flowReducer,
  initFlow,
  topScreen,
  type FlowEvent,
  type FlowState,
} from './reducer';
import { flowResult } from './result';

const context: PulseContext = {
  key: 'ticket:t-42',
  kind: 'ticket',
  id: 'T-42',
  label: 'Fix login',
};

const recordNew: OpenRequest = { entry: 'record', context };
const exportRef = { rel: 'results/r1.mp4', path: '/docs/results/r1.mp4', webUrl: 'x://r1.mp4' };
const failure: PulseErrorInfo = {
  code: 'permission.camera',
  message: 'Camera access was denied.',
  recoverable: false,
  callId: 'c1',
};

function run(state: FlowState, ...events: FlowEvent[]): FlowState {
  return events.reduce(flowReducer, state);
}

/** A record flow with one clip landed on draft d1. */
function recorded(): FlowState {
  return run(
    initFlow('r1', recordNew),
    { type: 'mounted' },
    { type: 'record' },
    { type: 'stop', draftId: 'd1', clipCount: 1 },
  );
}

describe('initFlow', () => {
  it('opens each entry on its first screen', () => {
    expect(initFlow('r1', recordNew).stack).toEqual(['recorder']);
    expect(initFlow('r1', { entry: 'edit', draftId: 'd1' }).stack).toEqual(['editor']);
    expect(initFlow('r1', { entry: 'export', draftId: 'd1' }).stack).toEqual(['export']);
  });

  it('starts a new recording with no draft and the request context', () => {
    const s = initFlow('r1', recordNew);
    expect(s).toMatchObject({
      draftId: null,
      newDraft: true,
      clipCount: 0,
      stage: 'none',
      context,
      mounted: false,
      end: null,
    });
  });

  it('continues an existing draft as one the flow did not make', () => {
    const s = initFlow(
      'r1',
      { ...recordNew, draft: { continue: 'd9' } },
      {
        context,
        clipCount: 3,
      },
    );
    expect(s).toMatchObject({ draftId: 'd9', newDraft: false, clipCount: 3 });
  });

  it('takes the context of an opened draft from the draft', () => {
    const s = initFlow('r1', { entry: 'edit', draftId: 'd1' }, { context, clipCount: 2 });
    expect(s).toMatchObject({ context, draftId: 'd1', clipCount: 2, newDraft: false });
  });
});

describe('record and stop', () => {
  it('records a take only on the recorder', () => {
    const s = run(initFlow('r1', recordNew), { type: 'record' });
    expect(s.recording).toBe(true);
    const editor = initFlow('r1', { entry: 'edit', draftId: 'd1' }, { context, clipCount: 1 });
    expect(flowReducer(editor, { type: 'record' })).toBe(editor);
  });

  it('a landed take sets the draft, the count and the stage', () => {
    expect(recorded()).toMatchObject({
      recording: false,
      draftId: 'd1',
      clipCount: 1,
      changed: true,
      stage: 'recorded',
    });
  });

  it('a dropped take changes nothing but the recording flag', () => {
    const s = run(initFlow('r1', recordNew), { type: 'record' }, { type: 'stop' });
    expect(s).toMatchObject({ recording: false, draftId: null, clipCount: 0, changed: false });
  });

  it('ignores navigation and X while a take runs', () => {
    const s = run(recorded(), { type: 'record' });
    for (const type of ['edit', 'close', 'back', 'export', 'addClips'] as const) {
      expect(flowReducer(s, { type })).toBe(s);
    }
  });

  it('a stop with no take running does nothing', () => {
    const s = recorded();
    expect(flowReducer(s, { type: 'stop', draftId: 'd1', clipCount: 5 })).toBe(s);
  });
});

describe('navigation', () => {
  it('goes recorder → editor → export and back again', () => {
    let s = run(recorded(), { type: 'edit' });
    expect(s.stack).toEqual(['recorder', 'editor']);
    s = run(s, { type: 'export' });
    expect(s.stack).toEqual(['recorder', 'editor', 'export']);
    expect(topScreen(s)).toBe('export');
    s = run(s, { type: 'back' });
    expect(s.stack).toEqual(['recorder', 'editor']);
    s = run(s, { type: 'back' });
    expect(s.stack).toEqual(['recorder']);
    expect(s.end).toBeNull();
  });

  it('needs a clip before the editor or Export', () => {
    const s = run(initFlow('r1', recordNew), { type: 'mounted' });
    expect(flowReducer(s, { type: 'edit' })).toBe(s);
    const empty = initFlow('r1', { entry: 'edit', draftId: 'd1' }, { context, clipCount: 0 });
    expect(flowReducer(empty, { type: 'export' })).toBe(empty);
  });

  it('only moves from the screen each step belongs to', () => {
    const onRecorder = recorded();
    expect(flowReducer(onRecorder, { type: 'export' })).toBe(onRecorder);
    expect(flowReducer(onRecorder, { type: 'addClips' })).toBe(onRecorder);
    const onEditor = run(onRecorder, { type: 'edit' });
    expect(flowReducer(onEditor, { type: 'edit' })).toBe(onEditor);
  });

  it('addClips from a record flow opens a recorder over the editor, and Edit returns to it', () => {
    let s = run(recorded(), { type: 'edit' }, { type: 'addClips', anchor: { before: 'c1' } });
    expect(s.stack).toEqual(['recorder', 'editor', 'recorder']);
    s = run(s, { type: 'record' }, { type: 'stop', draftId: 'd1', clipCount: 2 }, { type: 'edit' });
    expect(s.stack).toEqual(['recorder', 'editor']);
    expect(s).toMatchObject({ clipCount: 2, changed: true, end: null });
    // X on the added recorder (back) also returns to the editor, and the flow stays open.
    s = run(s, { type: 'addClips' }, { type: 'back' });
    expect(s.stack).toEqual(['recorder', 'editor']);
    expect(s.end).toBeNull();
  });

  it('Export from the added recorder goes over the editor, and Trim comes back to it', () => {
    let s = run(recorded(), { type: 'edit' }, { type: 'addClips', anchor: { before: 'c1' } });
    s = run(s, { type: 'record' }, { type: 'stop', draftId: 'd1', clipCount: 2 });
    // The recorder's Export, as the shell sends it: edit, then export.
    s = run(s, { type: 'edit' }, { type: 'export' });
    expect(s.stack).toEqual(['recorder', 'editor', 'export']);
    // Trim (the shell's back from Export, offered with the editor under it).
    s = run(s, { type: 'back' });
    expect(s.stack).toEqual(['recorder', 'editor']);
    expect(s.end).toBeNull();
  });

  it('the round trip sends no result, whichever way the recorder is left', () => {
    let s = run(recorded(), { type: 'edit' });
    for (const leave of [{ type: 'edit' }, { type: 'back' }] as const) {
      s = run(s, { type: 'addClips', anchor: { before: 'c2' } });
      s = run(s, { type: 'record' }, { type: 'stop', draftId: 'd1' }, leave);
      expect(topScreen(s)).toBe('editor');
      expect(s.end).toBeNull();
    }
  });

  it('addClips round trip from an edit flow pushes the recorder and pops back', () => {
    let s = initFlow('r1', { entry: 'edit', draftId: 'd1' }, { context, clipCount: 1 });
    s = run(s, { type: 'mounted' }, { type: 'addClips' });
    expect(s.stack).toEqual(['editor', 'recorder']);
    s = run(s, { type: 'record' }, { type: 'stop', draftId: 'd1', clipCount: 2 }, { type: 'edit' });
    expect(s.stack).toEqual(['editor']);
    expect(s).toMatchObject({ clipCount: 2, changed: true, end: null });
  });

  it('Edit carries where the recorder was without changing where it goes', () => {
    // The place rides along for the store (a new editor opens there, one gone back to is told).
    const at = { anchor: { before: 'c1', next: 'c2' } };
    let s = run(recorded(), { type: 'edit', at });
    expect(s.stack).toEqual(['recorder', 'editor']);
    s = run(s, { type: 'addClips', anchor: { before: 'c1' } });
    s = run(s, { type: 'edit', at: { clipId: 'c2' } });
    expect(s.stack).toEqual(['recorder', 'editor']);
    expect(s.end).toBeNull();
    // Still needs a clip, and still only from a recorder.
    const fresh = run(initFlow('r1', recordNew), { type: 'mounted' });
    expect(flowReducer(fresh, { type: 'edit', at })).toBe(fresh);
    expect(flowReducer(s, { type: 'edit', at })).toBe(s);
  });

  it('back from an added recorder returns to the editor without ending', () => {
    let s = initFlow('r1', { entry: 'edit', draftId: 'd1' }, { context, clipCount: 1 });
    s = run(s, { type: 'addClips' }, { type: 'back' });
    expect(s.stack).toEqual(['editor']);
    expect(s.end).toBeNull();
  });
});

describe('stage', () => {
  it('advances recorded → edited → exported, and a later change makes the export stale', () => {
    let s = run(recorded(), { type: 'edit' }, { type: 'edited', clipCount: 1 });
    expect(s.stage).toBe('edited');
    s = run(s, { type: 'export' }, { type: 'merged' });
    expect(s.stage).toBe('exported');
    s = run(s, { type: 'back' }, { type: 'edited', clipCount: 1 });
    expect(s.stage).toBe('edited');
    s = run(s, { type: 'addClips' }, { type: 'record' }, { type: 'stop', draftId: 'd1' });
    expect(s).toMatchObject({ stage: 'edited', clipCount: 2 });
  });
});

describe('X with clips: the keep/discard sheet', () => {
  it('X on a new draft with a clip shows the sheet instead of ending', () => {
    const s = run(recorded(), { type: 'close' });
    expect(s.sheet).toBe('exit');
    expect(s.end).toBeNull();
  });

  it('back at the root means X', () => {
    expect(run(recorded(), { type: 'back' }).sheet).toBe('exit');
  });

  it('Keep ends closed with the draft', () => {
    const s = run(recorded(), { type: 'edit' }, { type: 'close' }, { type: 'keep' });
    expect(s.end).toEqual({ status: 'closed', reason: 'user', draftId: 'd1' });
    expect(s).toMatchObject({ sheet: null, deleteDraft: null });
    expect(topScreen(s)).toBe('editor');
  });

  it('Discard ends canceled and deletes the draft', () => {
    const s = run(recorded(), { type: 'close' }, { type: 'discard' });
    expect(s.end).toEqual({ status: 'canceled', reason: 'user' });
    expect(s.deleteDraft).toBe('d1');
  });

  it('Cancel (and back) dismisses the sheet and the flow goes on', () => {
    for (const type of ['dismissSheet', 'back'] as const) {
      const s = run(recorded(), { type: 'close' }, { type });
      expect(s).toMatchObject({ sheet: null, end: null });
      expect(run(s, { type: 'edit' }).stack).toEqual(['recorder', 'editor']);
    }
  });

  it('nothing else moves while the sheet is up', () => {
    const s = run(recorded(), { type: 'close' });
    for (const type of ['edit', 'record', 'close', 'export'] as const) {
      expect(flowReducer(s, { type })).toBe(s);
    }
  });

  it('the sheet answers do nothing without a sheet', () => {
    const s = recorded();
    for (const type of ['keep', 'discard', 'dismissSheet'] as const) {
      expect(flowReducer(s, { type })).toBe(s);
    }
  });
});

describe('a clock type: the sheet and Keep draft', () => {
  const wrapUp: PulseContext = {
    key: 'clock:e1',
    kind: 'clock',
    id: 'E1',
    label: 'Mon 9:02 session',
    uploadType: {
      id: 'clock.wrapup',
      version: 1,
      sendLabel: 'Clock out & send',
      requireOnline: true,
      confirmSend: true,
    },
  };
  const clockRecorded = () =>
    run(
      initFlow('r1', { entry: 'record', context: wrapUp }),
      { type: 'mounted' },
      { type: 'record' },
      { type: 'stop', draftId: 'd1', clipCount: 1 },
    );

  it('X before Send: the keep answer says the person is still clocked in', () => {
    const s = run(clockRecorded(), { type: 'edit' }, { type: 'export' }, { type: 'close' });
    expect(s.sheet).toBe('exit');
    expect(exitSheetCopy(s)).toEqual({
      title: 'Keep this video?',
      keep: 'Keep draft (you’re still clocked in)',
      discard: 'Discard video',
      cancel: 'Cancel',
    });
    // Keep: the draft stays, nothing was sent (so nothing clocked).
    const kept = run(s, { type: 'keep' });
    expect(kept.end).toEqual({ status: 'closed', reason: 'user', draftId: 'd1' });
    expect(kept).toMatchObject({ deleteDraft: null, stage: 'recorded' });
  });

  it('a clock-in type says still clocked out; a ticket says just Keep draft', () => {
    const plan = { ...wrapUp, uploadType: { id: 'clock.plan', version: 1, confirmSend: true } };
    expect(exitSheetCopy(initFlow('r1', { entry: 'record', context: plan })).keep).toBe(
      'Keep draft (you’re still clocked out)',
    );
    expect(exitSheetCopy(recorded()).keep).toBe('Keep draft');
  });

  it('Keep draft on Export (after a failed confirm) ends closed with the draft, no sheet', () => {
    const s = run(clockRecorded(), { type: 'edit' }, { type: 'export' }, { type: 'keepDraft' });
    expect(s.end).toEqual({ status: 'closed', reason: 'user', draftId: 'd1' });
    expect(s).toMatchObject({ sheet: null, deleteDraft: null });
    expect(flowResult(s, 5)).toMatchObject({ status: 'closed', draftId: 'd1', endedOn: 'export' });
  });

  it('Keep draft counts only on Export', () => {
    const s = run(clockRecorded(), { type: 'edit' });
    expect(flowReducer(s, { type: 'keepDraft' })).toBe(s);
  });
});

describe('X with zero clips', () => {
  it('ends canceled with no draft and nothing to delete', () => {
    const s = run(initFlow('r1', recordNew), { type: 'mounted' }, { type: 'close' });
    expect(s.end).toEqual({ status: 'canceled', reason: 'user' });
    expect(s.deleteDraft).toBeNull();
  });

  it('after a dropped take, still canceled with no draft', () => {
    const s = run(
      initFlow('r1', recordNew),
      { type: 'record' },
      { type: 'stop' },
      { type: 'close' },
    );
    expect(s.end).toEqual({ status: 'canceled', reason: 'user' });
  });

  it('a new draft whose clips were all deleted is canceled and deleted, no sheet', () => {
    const s = run(
      recorded(),
      { type: 'edit' },
      { type: 'edited', clipCount: 0 },
      { type: 'close' },
    );
    expect(s.end).toEqual({ status: 'canceled', reason: 'user' });
    expect(s.deleteDraft).toBe('d1');
    expect(s.stage).toBe('none');
  });
});

describe('X on a draft the flow opened', () => {
  const opened = () =>
    run(initFlow('r1', { entry: 'edit', draftId: 'd1' }, { context, clipCount: 2 }), {
      type: 'mounted',
    });

  it('unchanged: canceled with its draftId, nothing deleted, no sheet', () => {
    const s = run(opened(), { type: 'close' });
    expect(s.end).toEqual({ status: 'canceled', reason: 'user', draftId: 'd1' });
    expect(s.deleteDraft).toBeNull();
  });

  it('changed: closed (kept), no sheet', () => {
    const s = run(opened(), { type: 'edited', clipCount: 2 }, { type: 'close' });
    expect(s.end).toEqual({ status: 'closed', reason: 'user', draftId: 'd1' });
  });

  it('a merge alone is not a change', () => {
    const s = run(
      initFlow('r1', { entry: 'export', draftId: 'd1' }, { context, clipCount: 1 }),
      { type: 'merged' },
      { type: 'close' },
    );
    expect(s.end).toEqual({ status: 'canceled', reason: 'user', draftId: 'd1' });
    expect(s.stage).toBe('exported');
  });

  it('record continue with a new clip closes kept', () => {
    const s = run(
      initFlow('r1', { ...recordNew, draft: { continue: 'd9' } }, { context, clipCount: 1 }),
      { type: 'record' },
      { type: 'stop', draftId: 'd9', clipCount: 2 },
      { type: 'close' },
    );
    expect(s.end).toEqual({ status: 'closed', reason: 'user', draftId: 'd9' });
  });
});

describe('completion', () => {
  it('Use this video completes in file mode from Export', () => {
    const s = run(
      recorded(),
      { type: 'edit' },
      { type: 'export' },
      { type: 'useVideo', export: exportRef, durationMs: 4200 },
    );
    expect(s.end).toEqual({
      status: 'completed',
      mode: 'file',
      draftId: 'd1',
      export: exportRef,
      durationMs: 4200,
    });
    expect(s.stage).toBe('exported');
  });

  it('Send completes in pulse mode from Export', () => {
    const s = run(
      recorded(),
      { type: 'edit' },
      { type: 'export' },
      { type: 'send', sentAt: 1000, clientKey: 'i:d1:abcd', draftKey: 'i:d1' },
    );
    expect(s.end).toEqual({
      status: 'completed',
      mode: 'pulse',
      draftId: 'd1',
      sentAt: 1000,
      clientKey: 'i:d1:abcd',
      draftKey: 'i:d1',
    });
  });

  it('a confirmed Send is CompletedSent with confirmedAt, as the result file carries it', () => {
    const s = run(
      recorded(),
      { type: 'edit' },
      { type: 'export' },
      { type: 'merged' },
      {
        type: 'send',
        sentAt: 1_790_000_000_000,
        clientKey: 'i:d1:0123456789abcdef',
        draftKey: 'i:d1',
        confirmedAt: 1_790_000_000_400,
      },
    );
    expect(s.end).toEqual({
      status: 'completed',
      mode: 'pulse',
      draftId: 'd1',
      sentAt: 1_790_000_000_000,
      clientKey: 'i:d1:0123456789abcdef',
      draftKey: 'i:d1',
      confirmedAt: 1_790_000_000_400,
    });
    expect(s.deleteDraft).toBeNull();
    expect(flowResult(s, 1_790_000_000_900.4)).toEqual({
      requestId: 'r1',
      entry: 'record',
      endedOn: 'export',
      stage: 'exported',
      context,
      endedAt: 1_790_000_000_900,
      status: 'completed',
      mode: 'pulse',
      draftId: 'd1',
      sentAt: 1_790_000_000_000,
      clientKey: 'i:d1:0123456789abcdef',
      draftKey: 'i:d1',
      confirmedAt: 1_790_000_000_400,
    });
  });

  it('an unconfirmed Send has no confirmedAt key at all (plain JSON)', () => {
    const s = run(
      recorded(),
      { type: 'edit' },
      { type: 'export' },
      { type: 'send', sentAt: 1000, clientKey: 'i:d1:abcd', draftKey: 'i:d1' },
    );
    expect(Object.keys(flowResult(s, 2000) ?? {})).not.toContain('confirmedAt');
  });

  it('completes only from Export', () => {
    const s = run(recorded(), { type: 'edit' });
    expect(flowReducer(s, { type: 'useVideo', export: exportRef, durationMs: 1 })).toBe(s);
    expect(flowReducer(s, { type: 'send', sentAt: 1, clientKey: 'k', draftKey: 'd' })).toBe(s);
  });
});

describe('host close', () => {
  it('without discard keeps the take: closed{host}, even over the sheet', () => {
    expect(run(recorded(), { type: 'hostClose' }).end).toEqual({
      status: 'closed',
      reason: 'host',
      draftId: 'd1',
    });
    expect(run(recorded(), { type: 'close' }, { type: 'hostClose' }).end).toMatchObject({
      status: 'closed',
    });
  });

  it('with discard deletes the take: canceled{host}', () => {
    const s = run(recorded(), { type: 'hostClose', discard: true });
    expect(s.end).toEqual({ status: 'canceled', reason: 'host' });
    expect(s.deleteDraft).toBe('d1');
  });

  it('with no clip: canceled{host}, no draft, with or without discard', () => {
    for (const discard of [false, true]) {
      const s = run(initFlow('r1', recordNew), { type: 'hostClose', discard });
      expect(s.end).toEqual({ status: 'canceled', reason: 'host' });
      expect(s.deleteDraft).toBeNull();
    }
  });

  it('on an opened draft: kept if changed, untouched if not, never deleted', () => {
    const opened = initFlow('r1', { entry: 'edit', draftId: 'd1' }, { context, clipCount: 2 });
    expect(run(opened, { type: 'hostClose' }).end).toEqual({
      status: 'canceled',
      reason: 'host',
      draftId: 'd1',
    });
    expect(run(opened, { type: 'edited', clipCount: 2 }, { type: 'hostClose' }).end).toEqual({
      status: 'closed',
      reason: 'host',
      draftId: 'd1',
    });
    const discarded = run(opened, { type: 'hostClose', discard: true });
    expect(discarded.end).toEqual({ status: 'canceled', reason: 'host', draftId: 'd1' });
    expect(discarded.deleteDraft).toBeNull();
    const continued = run(
      initFlow('r1', { ...recordNew, draft: { continue: 'd9' } }, { context, clipCount: 3 }),
      { type: 'record' },
      { type: 'stop', draftId: 'd9', clipCount: 4 },
      { type: 'hostClose', discard: true },
    );
    expect(continued.end).toEqual({ status: 'closed', reason: 'host', draftId: 'd9' });
    expect(continued.deleteDraft).toBeNull();
  });
});

describe('host close or error during a take', () => {
  const firstTake = () => run(initFlow('r1', recordNew), { type: 'mounted' }, { type: 'record' });

  it('waits for the take to stop: no end yet, and the take keeps running', () => {
    const s = run(firstTake(), { type: 'hostClose' });
    expect(s).toMatchObject({ recording: true, end: null, pending: { type: 'hostClose' } });
  });

  it('first take, host close: the landed take is kept, closed{host} with its draft', () => {
    const s = run(
      firstTake(),
      { type: 'hostClose' },
      { type: 'stop', draftId: 'd1', clipCount: 1 },
    );
    expect(s.end).toEqual({ status: 'closed', reason: 'host', draftId: 'd1' });
    expect(s).toMatchObject({ stage: 'recorded', recording: false, pending: null });
    expect(s.deleteDraft).toBeNull();
  });

  it('first take, host close with discard: canceled{host} and the landed draft is deleted', () => {
    const s = run(
      firstTake(),
      { type: 'hostClose', discard: true },
      { type: 'stop', draftId: 'd1', clipCount: 1 },
    );
    expect(s.end).toEqual({ status: 'canceled', reason: 'host' });
    expect(s.deleteDraft).toBe('d1');
  });

  it('a later discard is not lost behind an earlier plain host close', () => {
    const s = run(
      firstTake(),
      { type: 'hostClose' },
      { type: 'hostClose', discard: true },
      { type: 'stop', draftId: 'd1', clipCount: 1 },
    );
    expect(s.end).toEqual({ status: 'canceled', reason: 'host' });
    expect(s.deleteDraft).toBe('d1');
  });

  it('first take dropped (a bare stop): canceled{host}, no draft', () => {
    const s = run(firstTake(), { type: 'hostClose' }, { type: 'stop' });
    expect(s.end).toEqual({ status: 'canceled', reason: 'host' });
    expect(s.deleteDraft).toBeNull();
  });

  it('first take, error: failed with the draft the take landed in', () => {
    const s = run(
      firstTake(),
      { type: 'error', error: failure },
      { type: 'stop', draftId: 'd1', clipCount: 1 },
    );
    expect(s.end).toEqual({ status: 'failed', error: failure, draftId: 'd1' });
    expect(s.deleteDraft).toBeNull();
  });

  it('first take, error, nothing landed: failed with no draft', () => {
    const s = run(firstTake(), { type: 'error', error: failure }, { type: 'stop' });
    expect(s.end).toEqual({ status: 'failed', error: failure });
  });

  it('a later take on a draft with clips: closed{host} with the new count', () => {
    const s = run(
      recorded(),
      { type: 'record' },
      { type: 'hostClose' },
      { type: 'stop', draftId: 'd1', clipCount: 2 },
    );
    expect(s.end).toEqual({ status: 'closed', reason: 'host', draftId: 'd1' });
    expect(s.clipCount).toBe(2);
  });
});

describe('error', () => {
  it('fails keeping a draft that had a clip', () => {
    const s = run(recorded(), { type: 'error', error: failure });
    expect(s.end).toEqual({ status: 'failed', error: failure, draftId: 'd1' });
    expect(s.deleteDraft).toBeNull();
  });

  it('fails with no draft when nothing was recorded', () => {
    const s = run(initFlow('r1', recordNew), { type: 'error', error: failure });
    expect(s.end).toEqual({ status: 'failed', error: failure });
    expect(s.mounted).toBe(false);
  });

  it('keeps an opened draft', () => {
    const s = run(initFlow('r1', { entry: 'export', draftId: 'd1' }), {
      type: 'error',
      error: failure,
    });
    expect(s.end).toEqual({ status: 'failed', error: failure, draftId: 'd1' });
  });

  it('ends even over the sheet', () => {
    const s = run(recorded(), { type: 'close' }, { type: 'error', error: failure });
    expect(s).toMatchObject({ sheet: null, end: { status: 'failed' } });
  });
});

describe('after the end', () => {
  it('ignores every event: one result per flow', () => {
    const ended = run(recorded(), { type: 'close' }, { type: 'keep' });
    const events: FlowEvent[] = [
      { type: 'hostClose', discard: true },
      { type: 'error', error: failure },
      { type: 'record' },
      { type: 'close' },
      { type: 'discard' },
    ];
    for (const e of events) expect(flowReducer(ended, e)).toBe(ended);
  });
});

describe('a Send in progress holds the host’s close', () => {
  const onExport = () => run(recorded(), { type: 'edit' }, { type: 'export' }, { type: 'merged' });

  it('a close during the merge or the confirm waits; a Send that goes completes', () => {
    const held = run(onExport(), { type: 'sendStarted' }, { type: 'hostClose' });
    expect(held).toMatchObject({ sending: true, end: null, pending: { type: 'hostClose' } });
    const s = run(held, {
      type: 'send',
      sentAt: 1000,
      clientKey: 'i:d1:abcd',
      draftKey: 'i:d1',
      confirmedAt: 1001,
    });
    expect(s.end).toMatchObject({ status: 'completed', mode: 'pulse', confirmedAt: 1001 });
    expect(s).toMatchObject({ sending: false, pending: null });
  });

  it('a Send that stops lets the waiting close (or failure) through', () => {
    const closed = run(
      onExport(),
      { type: 'sendStarted' },
      { type: 'hostClose', discard: true },
      { type: 'sendStopped' },
    );
    expect(closed.end).toEqual({ status: 'canceled', reason: 'host' });
    expect(closed.deleteDraft).toBe('d1');
    const failed = run(onExport(), { type: 'sendStarted' }, { type: 'error', error: failure });
    expect(failed.end).toBeNull();
    expect(run(failed, { type: 'sendStopped' }).end).toMatchObject({ status: 'failed' });
  });

  it('nothing else moves while it runs; with nothing waiting, it just stops', () => {
    const sending = run(onExport(), { type: 'sendStarted' });
    for (const e of [{ type: 'close' }, { type: 'back' }, { type: 'keepDraft' }] as const) {
      expect(flowReducer(sending, e)).toBe(sending);
    }
    expect(run(sending, { type: 'sendStopped' })).toMatchObject({ sending: false, end: null });
    // Only Export sends.
    expect(run(recorded(), { type: 'sendStarted' }).sending).toBe(false);
  });
});

import { describe, expect, it } from '@jest/globals';
import type { FlowResult, PulseContext, PulseErrorInfo } from '@mieweb/pulse-embed';

import { flowReducer, initFlow, type FlowEvent, type FlowState } from './reducer';
import { flowResult } from './result';

const context: PulseContext = {
  key: 'clock:e1',
  kind: 'clock',
  id: 'E1',
  label: 'Mon 9:02 session',
  data: { type: 'clock.session', target: { kind: 'clock', eventId: 'E1' } },
};
const exportRef = { rel: 'results/r1.mp4', path: '/docs/results/r1.mp4', webUrl: 'x://r1.mp4' };
const projectRef = { rel: 'results/r1.project.json', path: '/p', webUrl: 'x://p' };
const ENDED_AT = 1_763_500_000_000;

function run(state: FlowState, ...events: FlowEvent[]): FlowState {
  return events.reduce(flowReducer, state);
}

const toExport = (): FlowState =>
  run(
    initFlow('r1', { entry: 'record', context }),
    { type: 'mounted' },
    { type: 'record' },
    { type: 'stop', draftId: 'd1', clipCount: 1 },
    { type: 'edit' },
    { type: 'export' },
    { type: 'merged' },
  );

/** The result survives the trip through results/<id>.json unchanged: plain JSON, no undefined. */
function expectPlainJson(r: FlowResult | null) {
  expect(r).not.toBeNull();
  expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  const undefinedKeys = Object.entries(r as object).filter(([, v]) => v === undefined);
  expect(undefinedKeys).toEqual([]);
}

describe('flowResult', () => {
  it('is null while the flow is open', () => {
    expect(flowResult(toExport(), ENDED_AT)).toBeNull();
  });

  it('completed, file mode', () => {
    const r = flowResult(
      run(toExport(), {
        type: 'useVideo',
        export: exportRef,
        durationMs: 4200.4,
        project: projectRef,
      }),
      ENDED_AT,
    );
    expect(r).toEqual({
      requestId: 'r1',
      entry: 'record',
      endedOn: 'export',
      stage: 'exported',
      context,
      endedAt: ENDED_AT,
      status: 'completed',
      mode: 'file',
      draftId: 'd1',
      export: exportRef,
      durationMs: 4200,
      project: projectRef,
    });
    expectPlainJson(r);
  });

  it('completed, file mode without a project has no project key', () => {
    const r = flowResult(
      run(toExport(), { type: 'useVideo', export: exportRef, durationMs: 1 }),
      ENDED_AT,
    );
    expect(r).not.toHaveProperty('project');
    expectPlainJson(r);
  });

  it('completed, pulse mode carries sentAt, clientKey and draftKey', () => {
    const r = flowResult(
      run(toExport(), {
        type: 'send',
        sentAt: ENDED_AT - 5,
        clientKey: 'inst:d1:0123456789abcdef',
        draftKey: 'inst:d1',
        confirmedAt: ENDED_AT - 2,
      }),
      ENDED_AT,
    );
    expect(r).toEqual({
      requestId: 'r1',
      entry: 'record',
      endedOn: 'export',
      stage: 'exported',
      context,
      endedAt: ENDED_AT,
      status: 'completed',
      mode: 'pulse',
      draftId: 'd1',
      sentAt: ENDED_AT - 5,
      clientKey: 'inst:d1:0123456789abcdef',
      draftKey: 'inst:d1',
      confirmedAt: ENDED_AT - 2,
    });
    expectPlainJson(r);
  });

  it('closed (Keep) names the draft and the screen it ended on', () => {
    const r = flowResult(
      run(toExport(), { type: 'back' }, { type: 'close' }, { type: 'keep' }),
      ENDED_AT,
    );
    expect(r).toEqual({
      requestId: 'r1',
      entry: 'record',
      endedOn: 'editor',
      stage: 'exported',
      context,
      endedAt: ENDED_AT,
      status: 'closed',
      reason: 'user',
      draftId: 'd1',
    });
    expectPlainJson(r);
  });

  it('canceled with nothing recorded has no draftId and stage none', () => {
    const r = flowResult(
      run(initFlow('r2', { entry: 'record', context }), { type: 'mounted' }, { type: 'close' }),
      ENDED_AT,
    );
    expect(r).toEqual({
      requestId: 'r2',
      entry: 'record',
      endedOn: 'recorder',
      stage: 'none',
      context,
      endedAt: ENDED_AT,
      status: 'canceled',
      reason: 'user',
    });
    expectPlainJson(r);
  });

  it('canceled on an untouched opened draft keeps its draftId; host reason passes through', () => {
    const r = flowResult(
      run(
        initFlow('r3', { entry: 'edit', draftId: 'd7' }, { context, clipCount: 1 }),
        { type: 'mounted' },
        { type: 'hostClose' },
      ),
      ENDED_AT,
    );
    expect(r).toMatchObject({
      entry: 'edit',
      endedOn: 'editor',
      status: 'canceled',
      reason: 'host',
      draftId: 'd7',
      context,
    });
    expectPlainJson(r);
  });

  it('failed before the first frame has endedOn null and a context of null for an unknown draft', () => {
    const error: PulseErrorInfo = {
      code: 'storage.damaged',
      message: 'damaged',
      recoverable: false,
      callId: 'c9',
      requestId: 'r4',
      draftId: undefined,
    };
    const r = flowResult(
      run(initFlow('r4', { entry: 'export', draftId: 'd1' }), { type: 'error', error }),
      ENDED_AT,
    );
    expect(r).toEqual({
      requestId: 'r4',
      entry: 'export',
      endedOn: null,
      stage: 'none',
      context: null,
      endedAt: ENDED_AT,
      status: 'failed',
      error: {
        code: 'storage.damaged',
        message: 'damaged',
        recoverable: false,
        callId: 'c9',
        requestId: 'r4',
      },
      draftId: 'd1',
    });
    expectPlainJson(r);
    expect(r).toHaveProperty('error');
    expect((r as { error: object }).error).not.toHaveProperty('draftId');
  });

  it('failed with nothing recorded has no draftId', () => {
    const error: PulseErrorInfo = {
      code: 'permission.camera',
      message: 'no',
      recoverable: false,
      callId: 'c1',
    };
    const r = flowResult(
      run(
        initFlow('r5', { entry: 'record', context }),
        { type: 'mounted' },
        { type: 'error', error },
      ),
      ENDED_AT,
    );
    expect(r).toMatchObject({ status: 'failed', endedOn: 'recorder', error });
    expect(r).not.toHaveProperty('draftId');
    expectPlainJson(r);
  });

  it('rounds endedAt to whole milliseconds', () => {
    const r = flowResult(
      run(initFlow('r6', { entry: 'record', context }), { type: 'close' }),
      ENDED_AT + 0.6,
    );
    expect(r?.endedAt).toBe(ENDED_AT + 1);
  });
});

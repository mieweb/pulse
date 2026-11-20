import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { FileRef, OpenRequest, PulseContext } from '@mieweb/pulse-embed';

import type { DraftSeen } from './draft-sync';
import { createFlowController, FAIL_SETTLE_MS } from './flow-controller';
import { createFlowStore } from './flow-store';

// The library, the recorders on screen and the results folder, as the controller sees them.
const mockDrafts = new Map<string, DraftSeen>();
let mockOnScreen: { place: null; draftId: string | null } | null = null;
let mockFinalize: () => Promise<void> = async () => {};
const mockSave =
  jest.fn<(opts: { requestId: string; exportPath: string }) => Promise<Record<string, FileRef>>>();

jest.mock('@/features/editor/draft-writes', () => ({ flushDraftWrites: async () => {} }));
jest.mock('@/features/recorder/recorder-presence', () => ({
  finalizeRecorders: () => mockFinalize(),
  recorderOnScreen: () => mockOnScreen,
}));
jest.mock('./library', () => ({
  readDraft: (id: string) => mockDrafts.get(id) ?? null,
  onDraftsChanged: () => () => {},
  projectDocument: () => ({ version: 2 }),
}));
jest.mock('./results', () => ({
  saveExportForHost: (opts: { requestId: string; exportPath: string }) => mockSave(opts),
}));

const context: PulseContext = { key: 'ticket:t-1', kind: 'ticket', id: 'T-1', label: 'One' };
const record: OpenRequest = { entry: 'record', context };
const draft = (draftId: string, clipCount: number): DraftSeen => ({
  draftId,
  clipCount,
  lastModified: clipCount,
  mergedSignature: null,
});
const ref = (rel: string): FileRef => ({ rel, path: `/docs/${rel}`, webUrl: '', bytes: 1 });

function flow() {
  const store = createFlowStore({ requestId: 'r1', request: record, onEnd: () => {} });
  const controller = createFlowController(store, 'r1');
  controller.attach(null);
  store.dispatch({ type: 'mounted' });
  return { store, controller };
}

/** A take the recorder is still saving: it lands in the library when `mockFinalize` is done. */
function takeInFlight(draftId: string) {
  mockOnScreen = { place: null, draftId: null };
  let land!: () => void;
  const landed = new Promise<void>((resolve) => (land = resolve));
  mockFinalize = async () => {
    await landed;
    mockDrafts.set(draftId, draft(draftId, 1));
    mockOnScreen = { place: null, draftId };
  };
  return land;
}

beforeEach(() => {
  mockDrafts.clear();
  mockOnScreen = null;
  mockFinalize = async () => {};
  mockSave.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('a failure', () => {
  it('waits for the take in flight, so the result keeps the draft it landed in', async () => {
    const { store, controller } = flow();
    const land = takeInFlight('d1');
    const failing = controller.fail({ code: 'runtime.error', message: 'boom' });
    expect(store.state().end).toBeNull();
    land();
    await failing;
    expect(store.state().end).toMatchObject({
      status: 'failed',
      draftId: 'd1',
      error: { code: 'runtime.error', requestId: 'r1', recoverable: false },
    });
  });

  it('ends the flow anyway when the recorder never finishes', async () => {
    jest.useFakeTimers();
    const { store, controller } = flow();
    takeInFlight('d1'); // never lands
    const failing = controller.fail({ code: 'storage.damaged', message: 'gone' });
    await jest.advanceTimersByTimeAsync(FAIL_SETTLE_MS - 1);
    expect(store.state().end).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    await failing;
    expect(store.state().end).toMatchObject({ status: 'failed' });
    expect(store.state().end).not.toHaveProperty('draftId');
  });
});

describe("the host's close", () => {
  it('saves the take first; with discard the new draft goes', async () => {
    const { store, controller } = flow();
    const land = takeInFlight('d1');
    const closing = controller.hostClose(true);
    land();
    await closing;
    expect(store.state().end).toMatchObject({ status: 'canceled', reason: 'host' });
    expect(store.state().deleteDraft).toBe('d1');
  });

  it('keeps the take without discard', async () => {
    const { store, controller } = flow();
    const land = takeInFlight('d1');
    const closing = controller.hostClose(false);
    land();
    await closing;
    expect(store.state().end).toMatchObject({ status: 'closed', reason: 'host', draftId: 'd1' });
  });

  it('waits while Export sends; the Send that goes completes the flow', async () => {
    const { store, controller } = flow();
    mockDrafts.set('d1', draft('d1', 1));
    controller.observe('d1');
    store.dispatch({ type: 'edit' });
    store.dispatch({ type: 'export' });
    controller.sending(true);
    await controller.hostClose(false);
    expect(store.state().end).toBeNull();
    controller.sent({ draftId: 'd1', sentAt: 5, clientKey: 'i:d1:ab', draftKey: 'i:d1' });
    expect(store.state().end).toMatchObject({ status: 'completed', mode: 'pulse' });
  });

  it('a Send that stops lets the waiting close end the flow', async () => {
    const { store, controller } = flow();
    mockDrafts.set('d1', draft('d1', 1));
    controller.observe('d1');
    store.dispatch({ type: 'edit' });
    store.dispatch({ type: 'export' });
    controller.sending(true);
    await controller.hostClose(false);
    controller.sending(false);
    expect(store.state().end).toMatchObject({ status: 'closed', reason: 'host', draftId: 'd1' });
  });
});

describe('Use this video', () => {
  /** A flow on Export with draft d1. */
  function onExport() {
    const f = flow();
    mockDrafts.set('d1', draft('d1', 1));
    f.controller.observe('d1');
    f.store.dispatch({ type: 'edit' });
    f.store.dispatch({ type: 'export' });
    expect(f.store.state().stack.at(-1)).toBe('export');
    return f;
  }
  const video = { draftId: 'd1', path: '/mockDrafts/d1/export.mp4', durationMs: 4000 };

  it('copies the export once for a double tap, then completes', async () => {
    const { store, controller } = onExport();
    let copied!: () => void;
    mockSave.mockImplementation(
      () =>
        new Promise((resolve) => {
          copied = () => resolve({ export: ref('results/r1.mp4'), project: ref('results/r1.pj') });
        }),
    );
    const first = controller.useVideo(video);
    const second = controller.useVideo(video);
    copied();
    await Promise.all([first, second]);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(store.state().end).toMatchObject({
      status: 'completed',
      mode: 'file',
      draftId: 'd1',
      durationMs: 4000,
      export: { rel: 'results/r1.mp4' },
    });
  });

  it('ends failed{export.failed} with the draft when the copy fails', async () => {
    const { store, controller } = onExport();
    mockSave.mockRejectedValue(new Error('disk full'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await controller.useVideo(video);
    expect(store.state().end).toMatchObject({
      status: 'failed',
      draftId: 'd1',
      error: { code: 'export.failed', message: 'disk full' },
    });
  });
});

describe('attach', () => {
  it("is false for a draft the library doesn't have", () => {
    const store = createFlowStore({
      requestId: 'r2',
      request: { entry: 'edit', draftId: 'nope' },
      onEnd: () => {},
    });
    expect(createFlowController(store, 'r2').attach('nope')).toBe(false);
  });
});

describe('back and native pops', () => {
  function deep() {
    mockDrafts.set('d1', draft('d1', 1));
    mockOnScreen = { place: null, draftId: 'd1' };
    const f = flow();
    f.store.dispatch({ type: 'record' });
    f.store.dispatch({ type: 'stop', draftId: 'd1', clipCount: 1 });
    f.store.dispatch({ type: 'edit' });
    f.store.dispatch({ type: 'export' });
    return f;
  }
  const screens = (f: ReturnType<typeof flow>) => f.store.getSnapshot().items.map((i) => i.screen);

  it('moves one level for a double tap', async () => {
    const f = deep();
    expect(screens(f)).toEqual(['recorder', 'editor', 'export']);
    await Promise.all([f.controller.back(), f.controller.back()]);
    expect(screens(f)).toEqual(['recorder', 'editor']);
  });

  it('folds a native pop of the top screens back into the reducer', async () => {
    const f = deep();
    const editorKey = f.store.getSnapshot().items[1].key;
    await f.controller.nativePopped(editorKey);
    expect(screens(f)).toEqual(['recorder']);
  });

  it('ignores a native pop of a screen the reducer already removed', async () => {
    const f = deep();
    const exportKey = f.store.getSnapshot().items[2].key;
    await f.controller.back();
    await f.controller.nativePopped(exportKey);
    expect(screens(f)).toEqual(['recorder', 'editor']);
  });
});

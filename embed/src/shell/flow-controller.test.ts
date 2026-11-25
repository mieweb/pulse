import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { FileRef, OpenRequest, PulseContext } from '@mieweb/pulse-embed';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import migrations from '../../../drizzle/migrations';
import { env } from '@/test-support/expo-fs-node';

import { flowResult } from '../flow/result';
import { createFlowController, FAIL_SETTLE_MS } from './flow-controller';
import { createFlowStore } from './flow-store';
import type { DraftRead } from './library';
import { createUiSender, type UiFields } from './messaging';

// The library, the recorders on screen and the results folder, as the controller sees them. A
// test that needs the real library (on node:sqlite) sets `mockLibrary`.
const mockDrafts = new Map<string, DraftRead>();
let mockLibrary: typeof import('./library') | null = null;
let mockOnScreen: { place: null; draftId: string | null } | null = null;
let mockFinalize: () => Promise<void> = async () => {};
let mockUndoCheckpoint: () => Promise<void> = async () => {};
const mockSave =
  jest.fn<(opts: { requestId: string; exportPath: string }) => Promise<Record<string, FileRef>>>();

jest.mock('@/features/editor/draft-writes', () => ({ flushDraftWrites: async () => {} }));
jest.mock('@/core/undo-write-barrier', () => ({
  waitForUndoHistory: () => mockUndoCheckpoint(),
}));
jest.mock('@/features/recorder/recorder-presence', () => ({
  finalizeRecorders: () => mockFinalize(),
  recorderOnScreen: () => mockOnScreen,
}));
jest.mock('./library', () => ({
  readDraft: (id: string) =>
    mockLibrary ? mockLibrary.readDraft(id) : (mockDrafts.get(id) ?? null),
  onDraftsChanged: () => () => {},
  projectDocument: () => ({ version: 2 }),
}));
jest.mock('./results', () => ({
  saveExportForHost: (opts: { requestId: string; exportPath: string }) => mockSave(opts),
}));
// What the real library needs off the phone: the file system and SQLite stand-ins.
jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
jest.mock(
  'expo-sqlite',
  () =>
    jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
      '@/test-support/expo-sqlite-node',
    ).mockModule,
);
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@/utils/video', () => ({}));
jest.mock('@/features/transcription/clip-queue', () => ({ dropClipJobs: () => {} }));
jest.mock('@/db/secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));

const context: PulseContext = { key: 'ticket:t-1', kind: 'ticket', id: 'T-1', label: 'One' };
const record: OpenRequest = { entry: 'record', context };
const draft = (
  draftId: string,
  clipCount: number,
  place: PulseContext | null = null,
): DraftRead => ({
  draftId,
  clipCount,
  lastModified: clipCount,
  context: place,
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
  mockUndoCheckpoint = async () => {};
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
  it('waits for an addition Undo checkpoint before observing the final draft and ending', async () => {
    const { store, controller } = flow();
    mockDrafts.set('d1', draft('d1', 2));
    mockOnScreen = { place: null, draftId: 'd1' };
    controller.observe();
    let finishUndo!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishUndo = resolve;
    });
    mockUndoCheckpoint = async () => {
      await pending;
      mockDrafts.set('d1', { ...draft('d1', 0), retainedUndo: true });
    };
    const closing = controller.hostClose(false);
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(store.state().end).toBeNull();
    expect(store.state().clipCount).toBe(2);

    finishUndo();
    await closing;
    expect(store.state().clipCount).toBe(0);
    expect(store.state().retainedUndo).toBe(true);
    expect(store.state().end).toMatchObject({ status: 'closed', draftId: 'd1' });
    expect(store.state().deleteDraft).toBeNull();
  });

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

  it('tells the facade a Send is running, and when it stops (pulse.ui sending)', () => {
    const store = createFlowStore({ requestId: 'r1', request: record, onEnd: () => {} });
    const sent: UiFields[] = [];
    const controller = createFlowController(
      store,
      'r1',
      createUiSender((fields) => sent.push(fields)),
    );
    controller.attach(null);
    store.dispatch({ type: 'mounted' });
    mockDrafts.set('d1', draft('d1', 1));
    controller.observe('d1');
    controller.sending(true); // not on Export: the reducer holds no Send, and says so
    expect(sent).toEqual([{ sending: false }]);
    store.dispatch({ type: 'edit' });
    store.dispatch({ type: 'export' });
    controller.sending(true);
    controller.sending(false);
    expect(sent).toEqual([{ sending: false }, { sending: true }, { sending: false }]);
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
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
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

  it('waits for the Undo checkpoint before building the file-mode project', async () => {
    const { store, controller } = onExport();
    let checkpointed!: () => void;
    mockUndoCheckpoint = () =>
      new Promise<void>((resolve) => {
        checkpointed = resolve;
      });
    mockSave.mockResolvedValue({ export: ref('results/r1.mp4'), project: ref('results/r1.pj') });
    const using = controller.useVideo(video);
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    expect(mockSave).not.toHaveBeenCalled();
    expect(store.state().end).toBeNull();

    checkpointed();
    await using;
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(store.state().end).toMatchObject({ status: 'completed', mode: 'file' });
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

describe("Export's ready video", () => {
  it('an export entry on a draft whose saved export still matches ends exported', async () => {
    // A saved export used as is writes nothing: the draft reads the same before and after.
    mockDrafts.set('d1', draft('d1', 2));
    const store = createFlowStore({
      requestId: 'r6',
      request: { entry: 'export', draftId: 'd1' },
      onEnd: () => {},
    });
    const controller = createFlowController(store, 'r6');
    controller.attach('d1');
    store.dispatch({ type: 'mounted' });
    controller.observe();
    controller.exportReady('d1');
    await controller.close();
    expect(flowResult(store.state(), 9)).toMatchObject({ stage: 'exported', draftId: 'd1' });
  });

  it('back on the editor with nothing changed, the stage stays exported', async () => {
    const { store, controller } = flow();
    mockDrafts.set('d1', draft('d1', 1));
    controller.observe('d1');
    store.dispatch({ type: 'edit' });
    mockDrafts.set('d1', { ...draft('d1', 1), lastModified: 50 }); // a trim
    controller.observe();
    expect(store.state().stage).toBe('edited');
    store.dispatch({ type: 'export' });
    controller.exportReady('d1');
    await controller.back();
    expect(store.getSnapshot().items.at(-1)?.screen).toBe('editor');
    expect(store.state().stage).toBe('exported');
  });

  it("ignores another draft's video", () => {
    const { store, controller } = flow();
    mockDrafts.set('d1', draft('d1', 1));
    controller.observe('d1');
    store.dispatch({ type: 'edit' });
    store.dispatch({ type: 'export' });
    controller.exportReady('d2');
    expect(store.state().stage).toBe('recorded');
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

  it.each(['edit', 'export'] as const)(
    "a reopened draft's %s flow carries the draft's context into its result",
    async (entry) => {
      mockDrafts.set('d1', draft('d1', 2, context));
      const store = createFlowStore({
        requestId: 'r3',
        request: { entry, draftId: 'd1' },
        onEnd: () => {},
      });
      const controller = createFlowController(store, 'r3');
      expect(controller.attach('d1')).toBe(true);
      store.dispatch({ type: 'mounted' });
      await controller.hostClose(false);
      expect(flowResult(store.state(), 9)).toMatchObject({ draftId: 'd1', context });
    },
  );
});

describe('record → Keep draft → edit, on the real library', () => {
  // One "device": the library as the embed opens it (`@/db/client` opens it on import), migrated.
  const ROOT = mkdtempSync(join(tmpdir(), 'pulse-flow-controller-'));
  let lib!: { client: typeof import('@/db/client'); drafts: typeof import('@/db/drafts') };

  beforeAll(async () => {
    const docs = join(ROOT, 'Documents');
    Object.assign(env, {
      docDir: docs,
      cacheDir: join(ROOT, 'Caches'),
      dbDir: join(docs, 'SQLite'),
    });
    for (const dir of [env.docDir, env.cacheDir, env.dbDir]) mkdirSync(dir, { recursive: true });
    lib = { client: jest.requireActual('@/db/client'), drafts: jest.requireActual('@/db/drafts') };
    await migrate(lib.client.db, migrations);
    mockLibrary = jest.requireActual('./library');
  });
  afterAll(() => {
    mockLibrary = null;
    lib?.client.expoDb.closeSync();
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('returns the place and host data the recording stored, not null', async () => {
    const placed: PulseContext = {
      key: 'huddle:c-9',
      kind: 'huddle',
      id: 'C-9',
      label: 'Platform',
      uploadType: { id: 'huddle.post', version: 1, title: 'Post' },
      data: {
        type: 'huddle.post',
        target: { kind: 'huddle', teamId: 't1', conversationId: 'c-9' },
      },
    };
    // The draft a record flow's recorder makes for `placed` (flow-stack.tsx's newDraft), kept.
    const id = await lib.drafts.createDraft({
      name: null,
      context: null,
      hostContext: { ...placed },
      createdVia: 'host',
    });

    const store = createFlowStore({
      requestId: 'r4',
      request: { entry: 'edit', draftId: id },
      onEnd: () => {},
    });
    const controller = createFlowController(store, 'r4');
    expect(controller.attach(id)).toBe(true);
    store.dispatch({ type: 'mounted' });
    await controller.hostClose(false);
    expect(flowResult(store.state(), 9)?.context).toEqual(placed);
  });

  it('is null for a draft the Pulse app made, with no host place', async () => {
    const id = await lib.drafts.createDraft({ name: 'Walkthrough' });
    const store = createFlowStore({
      requestId: 'r5',
      request: { entry: 'edit', draftId: id },
      onEnd: () => {},
    });
    expect(createFlowController(store, 'r5').attach(id)).toBe(true);
    expect(store.state().context).toBeNull();
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

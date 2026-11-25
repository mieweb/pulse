import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SharedValue } from 'react-native-reanimated';

import {
  expectClipsAdded,
  noteClipsAdded,
  takeClipsAdded,
  takeClipSplits,
  type ClipAnchor,
} from '@/core/clip-anchor';
import type { SplitReceipt } from '@/db/drafts';

import { useEditorAdditions } from './use-editor-additions';

// Keep refs, state and effect lifetimes while driving the actual hook's menu callbacks and the
// real clips-added journal. Native picker/conversion work is controlled by promises below.
type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
let mockSlots: Slot[] = [];
let mockIndex = 0;
let mockEffects: (() => void)[] = [];
function mockUseRef<T>(initial: T) {
  const index = mockIndex++;
  mockSlots[index] ??= { value: { current: initial } };
  return mockSlots[index].value as { current: T };
}
function mockUseState<T>(initial: T) {
  const index = mockIndex++;
  mockSlots[index] ??= { value: initial };
  return [
    mockSlots[index].value as T,
    (value: T) => {
      mockSlots[index].value = value;
    },
  ] as const;
}
function mockUseEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
  const index = mockIndex++;
  const slot = mockSlots[index];
  if (
    slot &&
    deps &&
    deps.length === slot.deps?.length &&
    deps.every((value, i) => Object.is(value, slot.deps?.[i]))
  )
    return;
  mockEffects.push(() => {
    slot?.cleanup?.();
    mockSlots[index] = { deps, cleanup: effect() || undefined };
  });
}
function mockUseEffectEvent<T extends (...args: never[]) => unknown>(callback: T): T {
  const ref = mockUseRef(callback);
  ref.current = callback;
  return ((...args: never[]) => ref.current(...args)) as T;
}
jest.mock('react', () => ({
  useRef: mockUseRef,
  useState: mockUseState,
  useEffect: mockUseEffect,
  useLayoutEffect: mockUseEffect,
  useEffectEvent: mockUseEffectEvent,
}));
let mockId = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${++mockId}` }));
const mockDrop = jest.fn<(taken: SplitReceipt['before']) => Promise<void>>(async () => {});
jest.mock('@/db/drafts', () => ({
  dropTakenOut: (taken: SplitReceipt['before']) => mockDrop(taken),
}));
jest.mock('@/features/recorder/from-another-pulse', () => ({
  useFromAnotherPulse: () => ({ action: null, sheet: null }),
}));
jest.mock('@/features/recorder/screen-take', () => ({
  useScreenTake: () => ({ phase: 'idle', importing: false }),
}));
jest.mock('@/features/recorder/use-import-video', () => ({
  useImportVideo: () => ({ importing: false, importVideo: () => {} }),
}));
type ImportOptions = { onWriting: (id: string) => void };
const mockImport =
  jest.fn<(id: string, anchor: () => ClipAnchor, options: ImportOptions) => Promise<void>>();
jest.mock('@/features/recorder/use-import-images', () => ({
  // Deliberately never changes importing: classification must use the owned promise/ref.
  useImportImages: () => ({ importing: false, importImages: mockImport }),
}));

function gate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const mockBegin = jest.fn<(key: string) => Promise<void>>();
const mockEnd = jest.fn<(key: string) => void>();
const mockRecord =
  jest.fn<(ids: string[], splits?: readonly SplitReceipt[], key?: string) => void>();
const mockSeek = jest.fn();
const clip = (id: string) => ({
  id,
  edit: {
    startMs: 0,
    endMs: 4000,
    speed: 1,
    rotation: 0,
    flipped: false,
    muted: false,
    crop: null,
  },
  sourceKey: id,
});
type Props = Parameters<typeof useEditorAdditions>[0];
let props: Props;
let converting: ReturnType<typeof gate>;
let cleanups: (() => void)[];
const split = (id = 'p1'): SplitReceipt => ({
  before: { draftId: 'd', rows: [], transcripts: [], order: ['a'] },
  rightId: 'right',
  firstInsertedId: id,
});
function render() {
  mockIndex = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Controlled hook harness, without a native renderer.
  const result = useEditorAdditions(props);
  for (const effect of mockEffects.splice(0)) effect();
  return result;
}
function unmount() {
  for (const slot of mockSlots) slot.cleanup?.();
  mockSlots.forEach((slot) => {
    slot.cleanup = undefined;
  });
}
async function tick() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
async function start() {
  render()
    .actions.find((action) => action.key === 'images')!
    .onPress();
  await tick();
  return mockImport.mock.calls[0][2];
}
function commit(options: ImportOptions, id: string, receipt?: SplitReceipt) {
  options.onWriting(id);
  noteClipsAdded({ draftId: 'd', segmentIds: [id], ...(receipt && { split: receipt }) });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockSlots = [];
  mockIndex = 0;
  mockEffects = [];
  mockId = 0;
  cleanups = [];
  converting = gate();
  mockImport.mockImplementation(() => converting.promise);
  mockBegin.mockResolvedValue();
  props = {
    draftId: 'd',
    clips: [clip('a')],
    layout: { starts: [0], totalMs: 4000 },
    timeMs: { get: () => 1000 } as unknown as SharedValue<number>,
    focused: true,
    view: 'timeline',
    previewReady: true,
    pause: () => {},
    seekTo: mockSeek,
    recordAdded: mockRecord,
    beginBatch: mockBegin,
    endBatch: mockEnd,
    leaveEditMode: () => {},
    openOver: () => {},
  };
});
afterEach(() => {
  unmount();
  for (const cleanup of cleanups) cleanup();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('editor image batch ownership', () => {
  it('registers the first split before an intervening edit and extends the same batch', async () => {
    const options = await start();
    const key = mockBegin.mock.calls[0][0];
    const receipt = split();
    const order: string[] = [];
    mockRecord.mockImplementation((ids) => {
      order.push(`add:${ids}`);
    });
    commit(options, 'p1', receipt);
    expect(mockRecord).toHaveBeenLastCalledWith(['p1'], [receipt], key);
    order.push('rotate-left');
    commit(options, 'p2');
    expect(mockRecord).toHaveBeenLastCalledWith(['p2'], [], key);
    expect(order).toEqual(['add:p1', 'rotate-left', 'add:p2']);
    expect(mockEnd).not.toHaveBeenCalled();
    props = {
      ...props,
      clips: ['a', 'p1', 'p2', 'right'].map(clip),
      layout: { starts: [0, 1000, 4000, 7000], totalMs: 10000 },
    };
    render();
    expect(mockSeek).not.toHaveBeenCalled();
    converting.resolve();
    await tick();
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledWith(key);
    expect(mockSeek).toHaveBeenCalledWith(7000);
  });

  it('keeps other additions separate from an open batch', async () => {
    const options = await start();
    const key = mockBegin.mock.calls[0][0];
    commit(options, 'p1', split());
    noteClipsAdded({ draftId: 'd', segmentIds: ['screen'] });
    expect(mockRecord.mock.calls.map(([ids, , batch]) => [ids, batch])).toEqual([
      [['p1'], key],
      [['screen'], undefined],
    ]);
    converting.resolve();
    await tick();
  });

  it('canceled before any commit seals the reservation without creating an empty step', async () => {
    await start();
    converting.resolve();
    await tick();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockSeek).not.toHaveBeenCalled();
  });

  it('seals only committed images after a partial conversion failure', async () => {
    const options = await start();
    commit(options, 'p1', split());
    options.onWriting('failed');
    converting.reject(new Error('conversion failed'));
    await tick();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toEqual(['p1']);
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(render().busy).toBe(false);
  });

  it('waits for running history before starting the picker and ignores a duplicate press', async () => {
    const waiting = gate();
    mockBegin.mockReturnValue(waiting.promise);
    const action = render().actions.find((a) => a.key === 'images')!;
    action.onPress();
    action.onPress();
    await tick();
    expect(mockBegin).toHaveBeenCalledTimes(1);
    expect(mockImport).not.toHaveBeenCalled();
    waiting.resolve();
    await tick();
    expect(mockImport).toHaveBeenCalledTimes(1);
    converting.resolve();
    await tick();
  });

  it('registers while covered, deferring batch placement until the editor returns', async () => {
    const options = await start();
    props = { ...props, focused: false };
    render();
    commit(options, 'p1', split());
    expect(mockRecord).toHaveBeenCalledTimes(1);
    props = {
      ...props,
      clips: ['a', 'p1', 'right'].map(clip),
      layout: { starts: [0, 1000, 4000], totalMs: 7000 },
    };
    render();
    converting.resolve();
    await tick();
    expect(mockSeek).not.toHaveBeenCalled();
    jest.advanceTimersByTime(10000);
    props = { ...props, focused: true };
    render();
    expect(mockSeek).toHaveBeenCalledWith(4000);
  });

  it('unmount seals its batch and never drains another armed editor’s journal later', async () => {
    await start();
    cleanups.push(expectClipsAdded('d'));
    unmount();
    const other = split('other');
    noteClipsAdded({ draftId: 'd', segmentIds: ['other'], split: other });
    converting.resolve();
    await tick();
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockDrop).not.toHaveBeenCalled();
    expect(takeClipsAdded('d')).toEqual(['other']);
    expect(takeClipSplits('d')).toEqual([other]);
  });

  it('unmount while waiting for history does not start a late import or seal twice', async () => {
    const waiting = gate();
    mockBegin.mockReturnValue(waiting.promise);
    render()
      .actions.find((a) => a.key === 'images')!
      .onPress();
    unmount();
    waiting.resolve();
    await tick();
    expect(mockImport).not.toHaveBeenCalled();
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('reusing the screen for another draft closes the old batch without leaving busy state', async () => {
    const waiting = gate();
    mockBegin.mockReturnValue(waiting.promise);
    render()
      .actions.find((a) => a.key === 'images')!
      .onPress();
    expect(render().busy).toBe(true);
    props = { ...props, draftId: 'different' };
    expect(render().busy).toBe(false);
    props = { ...props, draftId: 'd' };
    expect(render().busy).toBe(false);
    waiting.resolve();
    await tick();
    expect(mockImport).not.toHaveBeenCalled();
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });
});

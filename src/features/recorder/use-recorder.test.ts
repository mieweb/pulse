import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { CameraRef } from 'react-native-vision-camera';

import type { ClipAnchor } from '@/core/clip-anchor';

import { useRecorder } from './use-recorder';

// Run the recorder's save flow through its public controls. Native effects are intentionally
// absent; these tests cover file ownership and insertion failures, not camera capture.
let mockSlots: unknown[] = [];
let mockSlot = 0;
function mockUseState<T>(initial: T | (() => T)) {
  const index = mockSlot++;
  if (!(index in mockSlots)) {
    mockSlots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
  }
  return [
    mockSlots[index] as T,
    (next: T | ((before: T) => T)) => {
      mockSlots[index] =
        typeof next === 'function' ? (next as (before: T) => T)(mockSlots[index] as T) : next;
    },
  ] as const;
}
function mockUseRef<T>(initial: T) {
  const index = mockSlot++;
  if (!(index in mockSlots)) mockSlots[index] = { current: initial };
  return mockSlots[index] as { current: T };
}
jest.mock('react', () => ({
  useState: mockUseState,
  useRef: mockUseRef,
  useEffect: () => {},
}));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('drizzle-orm/expo-sqlite', () => ({ useLiveQuery: () => ({ data: [] }) }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('@mieweb/pulse-editor', () => ({}), { virtual: true });

const mockCreateRecorder = jest.fn<() => Promise<unknown>>();
jest.mock('react-native-vision-camera', () => ({
  CommonResolutions: { FHD_16_9: {} },
  useVideoOutput: () => ({ createRecorder: mockCreateRecorder }),
}));
const mockAddSegment = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockAddSegmentCover = jest.fn<() => Promise<void>>();
const mockExpectCover = jest.fn();
jest.mock('@/db/drafts', () => ({
  addSegment: (...args: unknown[]) => mockAddSegment(...args),
  addSegmentCover: () => mockAddSegmentCover(),
  expectSegmentCover: (...args: unknown[]) => mockExpectCover(...args),
  segmentsForDraft: () => [],
}));
jest.mock('@/db/settings', () => ({}));
const mockShowToast = jest.fn();
jest.mock('@/features/toast/toast-provider', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));
jest.mock('@/features/transcription/clip-queue', () => ({}));
const mockPersistRecording =
  jest.fn<(uri: string, draftId: string, segmentId: string) => Promise<string>>();
const mockDeleteQuietly = jest.fn();
jest.mock('@/utils/file-store', () => ({
  absolutize: (relative: string) => `file:///documents/${relative}`,
  persistRecording: (...args: [string, string, string]) => mockPersistRecording(...args),
  deleteQuietly: (...args: unknown[]) => mockDeleteQuietly(...args),
}));
const mockDuration = jest.fn<() => Promise<number>>();
const mockCoverFailed = jest.fn();
jest.mock('@/utils/video', () => ({
  getDurationMs: () => mockDuration(),
  coverFailed: (...args: unknown[]) => mockCoverFailed(...args),
}));
jest.mock('../../../modules/expo-call-detector/src/CallDetectorModule', () => ({}));
jest.mock('./add-external-clip', () => ({}));
jest.mock('./photos-access', () => ({ usePhotosAccess: () => () => true }));
jest.mock('./recorder-format', () => ({ learnRecorderFormat: async () => {} }));
jest.mock('./screen-take', () => ({ useScreenTake: () => ({ phase: 'idle' }) }));
jest.mock('./use-import-images', () => ({ useImportImages: () => ({ importing: false }) }));
jest.mock('./use-call-state', () => ({
  useCallState: () => ({ callActive: false, appActive: true }),
}));

const relative = 'drafts/draft/segments/new.mp4';
const savedUri = `file:///documents/${relative}`;
const nativeUri = 'file:///camera/new.mov';
const anchor: ClipAnchor = {
  before: 'original',
  split: { sourceMs: 1500, offsetMs: 1500, sourceKey: 'original.mp4', rightId: 'right' },
};

function renderRecorder() {
  mockSlot = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Controlled hook harness, without a native renderer.
  return useRecorder('draft', undefined, undefined, { insertAnchor: anchor });
}

async function recordTake() {
  let recorder = renderRecorder();
  recorder.cameraRef.current = {} as CameraRef;
  recorder.onCameraReady();
  recorder = renderRecorder();
  recorder.toggleRecording();
  await recorder.finalizeRecording();
  return renderRecorder();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockSlots = [];
  mockCreateRecorder.mockResolvedValue({
    filePath: '/camera/new.mov',
    startRecording: async (finished: (path: string) => void) => finished('/camera/new.mov'),
    stopRecording: async () => {},
  });
  mockPersistRecording.mockResolvedValue(relative);
  mockDuration.mockResolvedValue(1000);
  mockAddSegment.mockResolvedValue();
  mockAddSegmentCover.mockResolvedValue();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('saving a camera take at the insertion point', () => {
  it('reports a stale split target and removes only the uncommitted saved recording', async () => {
    const message = 'The clip at the insertion point changed. Choose the position again.';
    mockAddSegment.mockRejectedValueOnce(new Error(message));

    const recorder = await recordTake();

    const getAnchor = mockAddSegment.mock.calls[0][2] as () => ClipAnchor;
    expect(getAnchor()).toEqual(anchor);
    expect(mockShowToast).toHaveBeenCalledWith({
      kind: 'error',
      title: 'Couldn’t save the recording',
      message,
    });
    expect(mockDeleteQuietly.mock.calls).toEqual([[savedUri]]);
    expect(mockCoverFailed).toHaveBeenCalledWith(savedUri);
    expect(mockAddSegmentCover).not.toHaveBeenCalled();
    expect(recorder.isRecording).toBe(false);
  });

  it('leaves camera-owned media alone when moving it into the draft fails', async () => {
    mockPersistRecording.mockRejectedValueOnce(new Error('No space left'));

    await recordTake();

    expect(mockPersistRecording).toHaveBeenCalledWith(nativeUri, 'draft', expect.any(String));
    expect(mockDeleteQuietly).not.toHaveBeenCalled();
    expect(mockCoverFailed).not.toHaveBeenCalled();
    expect(mockAddSegment).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalled();
  });

  it('retains a successfully inserted recording and starts its cover', async () => {
    await recordTake();

    expect(mockAddSegment).toHaveBeenCalledTimes(1);
    expect(mockExpectCover).toHaveBeenCalledWith(relative);
    expect(mockAddSegmentCover).toHaveBeenCalledTimes(1);
    expect(mockDeleteQuietly).not.toHaveBeenCalled();
    expect(mockCoverFailed).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });
});

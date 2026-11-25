import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../../../modules/expo-ai-editor/src/AiEditorModule', () => ({
  __esModule: true,
  default: { availability: jest.fn(), selectPassages: jest.fn(), cancel: jest.fn() },
}));
jest.mock('@/db/ai-edits', () => ({
  createAiEdit: jest.fn(),
  aiEditSourceSignature: jest.fn(),
  assertAiEditAudioSupported: jest.fn(),
}));
jest.mock('@/db/clip-transcripts', () => ({
  getClipTranscripts: jest.fn(),
  saveClipTranscript: jest.fn(),
}));
jest.mock('@/db/drafts', () => ({ getDraftName: jest.fn(), segmentsForDraft: jest.fn() }));
jest.mock('@/db/settings', () => ({ getSetting: jest.fn() }));
jest.mock('@/features/transcription/clip-queue', () => ({ pauseClipQueueForAiEdit: jest.fn() }));
jest.mock('@/features/transcription/compose', () => ({ clipWords: jest.fn() }));
jest.mock('@/features/transcription/model', () => ({ isModelReady: jest.fn() }));
jest.mock('@/features/transcription/models', () => ({
  getModel: jest.fn(),
  resolveSelectedModel: jest.fn(),
}));
jest.mock('@/features/transcription/whisper', () => ({
  releaseWhisper: jest.fn(),
  transcribeWords: jest.fn(),
}));
jest.mock('@/utils/file-store', () => ({ absolutize: (file: string) => `file:///test/${file}` }));
jest.mock('./enabled', () => ({ isAiEditingEnabled: jest.fn() }));

/* eslint-disable import/first -- native mocks precede the service imports */
import aiEditor from '../../../modules/expo-ai-editor/src/AiEditorModule';
import { aiEditSourceSignature, assertAiEditAudioSupported, createAiEdit } from '@/db/ai-edits';
import { getClipTranscripts, saveClipTranscript } from '@/db/clip-transcripts';
import { getDraftName, segmentsForDraft } from '@/db/drafts';
import type { Segment } from '@/db/schema';
import { getSetting } from '@/db/settings';
import { pauseClipQueueForAiEdit } from '@/features/transcription/clip-queue';
import { clipWords } from '@/features/transcription/compose';
import { isModelReady } from '@/features/transcription/model';
import { getModel, resolveSelectedModel, type WhisperModel } from '@/features/transcription/models';
import { releaseWhisper, transcribeWords } from '@/features/transcription/whisper';
import { isAiEditingEnabled } from './enabled';
import { AiEditSetupError, runAiEdit } from './run-ai-edit';
/* eslint-enable import/first */

const native = jest.mocked(aiEditor);
const pause = jest.mocked(pauseClipQueueForAiEdit);
const release = jest.mocked(releaseWhisper);
const create = jest.mocked(createAiEdit);
const transcribe = jest.mocked(transcribeWords);
const resume = jest.fn();
const words = [
  { text: 'Keep', t0: 10, t1: 60 },
  { text: 'this thought.', t0: 70, t1: 150 },
];
const model: WhisperModel = {
  id: 'parakeet',
  engine: 'parakeet',
  platforms: ['ios'],
  label: 'Parakeet',
  name: 'Parakeet',
  filename: 'speech.bin',
  approxBytes: 1,
  bytes: 1,
  note: 'English',
  lang: 'en',
};
let segment: Segment;

beforeEach(() => {
  jest.resetAllMocks();
  segment = {
    id: 'source-clip',
    draftId: 'source',
    order: 0,
    addedAt: 1000,
    label: '1',
    originalFilename: 'drafts/source/segments/source.mp4',
    durationMs: 10_000,
    editedFilename: null,
    editedDurationMs: null,
    editState: null,
    thumbnail: null,
    captionEdit: null,
  };
  jest.mocked(isAiEditingEnabled).mockReturnValue(true);
  native.availability.mockResolvedValue({ available: true, reason: 'available', message: 'Ready' });
  native.selectPassages.mockImplementation(async (passages) => ({ selectedIds: [passages[0].id] }));
  native.cancel.mockResolvedValue();
  jest.mocked(getSetting).mockResolvedValue(model.id);
  jest.mocked(resolveSelectedModel).mockReturnValue(model);
  jest.mocked(getModel).mockReturnValue(model);
  jest.mocked(isModelReady).mockReturnValue(true);
  jest.mocked(segmentsForDraft).mockResolvedValue([segment]);
  jest.mocked(getDraftName).mockResolvedValue('Source');
  jest.mocked(getClipTranscripts).mockResolvedValue(new Map());
  jest.mocked(clipWords).mockReturnValue({ words, edited: false, failed: false });
  jest.mocked(saveClipTranscript).mockResolvedValue();
  jest.mocked(aiEditSourceSignature).mockReturnValue('analysis-snapshot');
  pause.mockResolvedValue(resume);
  release.mockResolvedValue();
  transcribe.mockResolvedValue(words);
  create.mockResolvedValue({ draftId: 'result', clipCount: 1, durationMs: 1700 });
});

const run = (signal = new AbortController().signal) => runAiEdit('source', () => {}, signal);

describe('foreground offline AI edit service', () => {
  it('stops an unavailable system model before speech work or any database writes', async () => {
    native.availability.mockResolvedValue({
      available: false,
      reason: 'model_not_ready',
      message: 'Model not ready',
    });
    await expect(run()).rejects.toThrow('Model not ready');
    expect(pause).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(saveClipTranscript).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('requires already-downloaded speech weights and exposes model setup without starting inference', async () => {
    jest.mocked(isModelReady).mockReturnValue(false);
    await expect(run()).rejects.toMatchObject({ openModels: true });
    await expect(run()).rejects.toBeInstanceOf(AiEditSetupError);
    expect(pause).not.toHaveBeenCalled();
    expect(native.selectPassages).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('uses cached timed speech, saves a separate validated cut and resumes captions after freeing speech memory', async () => {
    const before = JSON.stringify(segment);
    await expect(run()).resolves.toMatchObject({ draftId: 'result' });
    expect(transcribe).not.toHaveBeenCalled();
    expect(saveClipTranscript).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDraftId: 'source',
        name: 'Source · AI cut',
        expectedSourceSignature: 'analysis-snapshot',
        intervals: [
          expect.objectContaining({ segmentId: segment.id, file: segment.originalFilename }),
        ],
      }),
    );
    expect(JSON.stringify(segment)).toBe(before);
    expect(assertAiEditAudioSupported).toHaveBeenCalledWith('source');
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      native.selectPassages.mock.invocationCallOrder[0],
    );
    expect(resume).toHaveBeenCalledTimes(1);
    expect(release.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      resume.mock.invocationCallOrder[0],
    );
  });

  it('uses the no-download speech path and persists source-time words when its cache is missing', async () => {
    jest.mocked(clipWords).mockReturnValue(null);
    const controller = new AbortController();
    await run(controller.signal);
    expect(transcribe).toHaveBeenCalledWith(`file:///test/${segment.originalFilename}`, model, {
      signal: controller.signal,
      allowModelDownload: false,
    });
    expect(saveClipTranscript).toHaveBeenCalledWith(
      segment.id,
      model.id,
      segment.originalFilename,
      words,
    );
  });

  it('cancels speech without writing partial words or a result and releases the queue', async () => {
    jest.mocked(clipWords).mockReturnValue(null);
    const controller = new AbortController();
    transcribe.mockImplementationOnce(async () => {
      controller.abort();
      return words;
    });
    await expect(run(controller.signal)).rejects.toThrow('cancelled');
    expect(native.cancel).toHaveBeenCalled();
    expect(saveClipTranscript).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1);
    // The singleton guard is cleared after cancellation; a fresh request can run.
    jest.mocked(clipWords).mockReturnValue({ words, edited: false, failed: false });
    await expect(run()).resolves.toMatchObject({ draftId: 'result' });
  });

  it('surfaces native failure without heuristic edits and restores the shared speech queue', async () => {
    native.selectPassages.mockRejectedValueOnce(new Error('The on-device model declined'));
    await expect(run()).rejects.toThrow('declined');
    expect(create).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('blocks overlapping requests while the first native availability request is pending', async () => {
    let ready!: (value: Awaited<ReturnType<typeof aiEditor.availability>>) => void;
    native.availability.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    const first = run();
    await expect(run()).rejects.toThrow('already running');
    ready({ available: true, reason: 'available', message: 'Ready' });
    await expect(first).resolves.toMatchObject({ draftId: 'result' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('captures the complete analysis context before filtering clips and passes the frozen signature to save', async () => {
    const empty = { ...segment, id: 'empty', order: 1, durationMs: 0 };
    jest.mocked(segmentsForDraft).mockResolvedValue([segment, empty]);
    native.selectPassages.mockImplementationOnce(async (passages) => {
      segment.captionEdit = 'changed during selection';
      return { selectedIds: [passages[0].id] };
    });
    create.mockRejectedValueOnce(new Error('The source project changed during analysis'));
    await expect(run()).rejects.toThrow('changed during analysis');
    expect(aiEditSourceSignature).toHaveBeenCalledWith([segment, empty]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSourceSignature: 'analysis-snapshot' }),
    );
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

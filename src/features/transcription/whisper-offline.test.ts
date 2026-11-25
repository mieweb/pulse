import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { extractAudio } from '@mieweb/pulse-editor';
import {
  initWhisper,
  initWhisperVad,
  type WhisperContext,
  type WhisperVadContext,
} from 'whisper.rn';

import { isModelReady } from './model';
import { MODELS } from './models';
import { hasSpeech, releaseVad } from './vad';
import { deleteDownload, downloadWhole, isWholeFile } from './verified-download';
import { releaseWhisper, transcribeWords } from './whisper';

jest.mock('@mieweb/pulse-editor', () => ({ extractAudio: jest.fn() }), { virtual: true });
jest.mock(
  'whisper.rn',
  () => ({ initWhisper: jest.fn(), initParakeet: jest.fn(), initWhisperVad: jest.fn() }),
  { virtual: true },
);
jest.mock('expo-file-system', () => ({
  Directory: class {
    create() {}
  },
  File: class {
    uri = 'file:///documents/vad/cached-model.bin';
  },
}));
jest.mock('@/utils/storage-root', () => ({ documentDir: () => 'file:///documents' }));
jest.mock('./model', () => ({
  isModelReady: jest.fn(),
  modelFileUri: () => 'file:///documents/models/cached-speech-model.bin',
}));
jest.mock('./verified-download', () => ({
  isWholeFile: jest.fn(),
  deleteDownload: jest.fn(),
  downloadWhole: jest.fn(),
}));
jest.mock('./whisper-jsi', () => ({ whisperJsiReady: async () => {} }));

const model = MODELS.find((candidate) => candidate.engine === 'whisper')!;
const pcm = new ArrayBuffer(320);
const words = [{ text: 'Hello.', t0: 0, t1: 50 }];
const detectSpeech = jest.fn<WhisperVadContext['detectSpeechData']>();
const transcribe = jest.fn<WhisperContext['transcribeData']>();

beforeEach(async () => {
  await releaseWhisper();
  await releaseVad();
  jest.clearAllMocks();
  jest.mocked(isModelReady).mockReturnValue(true);
  jest.mocked(isWholeFile).mockReturnValue(false);
  jest.mocked(extractAudio).mockResolvedValue({ data: pcm, sampleRate: 16_000, durationMs: 10 });
  detectSpeech.mockResolvedValue([{ t0: 0, t1: 50 }]);
  transcribe.mockReturnValue({
    stop: async () => {},
    promise: Promise.resolve({
      result: 'Hello.',
      language: 'en',
      segments: words,
      isAborted: false,
    }),
  });
  jest.mocked(initWhisper).mockResolvedValue({
    transcribeData: transcribe,
    release: async () => {},
  } as unknown as WhisperContext);
  jest.mocked(initWhisperVad).mockResolvedValue({
    detectSpeechData: detectSpeech,
    release: async () => {},
  } as unknown as WhisperVadContext);
  jest.mocked(downloadWhole).mockReturnValue({
    task: { cancel: () => {} },
    promise: Promise.resolve('file:///documents/vad/cached-model.bin'),
  });
});

afterEach(async () => {
  await releaseWhisper();
  await releaseVad();
});

describe('transcription without model downloads', () => {
  it('transcribes with cached speech weights when VAD is absent, without starting a download', async () => {
    await expect(
      transcribeWords('file:///source.mp4', model, { allowModelDownload: false }),
    ).resolves.toEqual(words);

    expect(downloadWhole).not.toHaveBeenCalled();
    expect(deleteDownload).not.toHaveBeenCalled();
    expect(initWhisperVad).not.toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledWith(pcm, expect.any(Object));
  });

  it('uses a whole cached VAD model to reject silence without downloads', async () => {
    jest.mocked(isWholeFile).mockReturnValue(true);
    detectSpeech.mockResolvedValue([]);

    await expect(
      transcribeWords('file:///source.mp4', model, { allowModelDownload: false }),
    ).resolves.toEqual([]);

    expect(initWhisperVad).toHaveBeenCalledWith({
      filePath: 'file:///documents/vad/cached-model.bin',
      useGpu: false,
    });
    expect(downloadWhole).not.toHaveBeenCalled();
    expect(initWhisper).not.toHaveBeenCalled();
  });

  it('reuses loaded VAD even if its cached file has since disappeared', async () => {
    jest.mocked(isWholeFile).mockReturnValue(true);
    await hasSpeech(pcm, { allowModelDownload: false });
    jest.mocked(isWholeFile).mockReturnValue(false).mockClear();

    await expect(
      transcribeWords('file:///source.mp4', model, { allowModelDownload: false }),
    ).resolves.toEqual(words);

    expect(initWhisperVad).toHaveBeenCalledTimes(1);
    expect(detectSpeech).toHaveBeenCalledTimes(2);
    expect(isWholeFile).not.toHaveBeenCalled();
    expect(downloadWhole).not.toHaveBeenCalled();
  });

  it('does not wait for a VAD download already started by captions', async () => {
    let finishDownload!: (uri: string) => void;
    jest.mocked(downloadWhole).mockReturnValue({
      task: { cancel: () => {} },
      promise: new Promise((resolve) => {
        finishDownload = resolve;
      }),
    });
    const captionsVad = hasSpeech(pcm);
    const offline = transcribeWords('file:///source.mp4', model, { allowModelDownload: false });

    try {
      // Give the local asynchronous pipeline a turn, but keep the captions download unresolved.
      const result = await Promise.race([
        offline,
        new Promise<'waiting'>((resolve) => setImmediate(() => resolve('waiting'))),
      ]);
      expect(result).toEqual(words);
      expect(downloadWhole).toHaveBeenCalledTimes(1);
      expect(initWhisperVad).not.toHaveBeenCalled();
    } finally {
      finishDownload('file:///documents/vad/cached-model.bin');
      await captionsVad;
      await offline;
    }
  });

  it('preserves first-use VAD downloading for ordinary captions by default', async () => {
    await expect(transcribeWords('file:///source.mp4', model)).resolves.toEqual(words);

    expect(downloadWhole).toHaveBeenCalledTimes(1);
    expect(initWhisperVad).toHaveBeenCalledTimes(1);
    expect(detectSpeech).toHaveBeenCalledWith(pcm);
  });
});

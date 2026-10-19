import { clearClipQueue } from './clip-queue';
import { cancelModelDownloadsExcept, deleteModelsExcept, ensureModel, isModelReady } from './model';
import type { ModelProgress } from './model';
import type { WhisperModel } from './models';
import { setTranscriptionStatus } from './transcription-status';
import { releaseVad } from './vad';
import { releaseWhisper } from './whisper';

export { ensureModel, isModelReady };
export type { ModelProgress, WhisperModel };

/**
 * Apply a model selection change (or clearing, with `null`). Lifted out of the old always-on
 * background loop: frees the previous model's whisper/VAD contexts and deletes every model except
 * the newly-selected one so only one set of weights is ever kept on disk. Downloading the new model
 * is the editor's Captions tool's job (`downloadModel`), so selecting a model here only records
 * intent + frees space — it never blocks on a (possibly large) download.
 */
export async function applyModelSelection(model: WhisperModel | null): Promise<void> {
  // Stop any in-flight download for a now-unselected model before touching disk, and any clip
  // transcription running with the old one — waiting for it to stop, so it can't load the old
  // model again after the release below.
  cancelModelDownloadsExcept(model);
  setTranscriptionStatus({ kind: 'deleting' });
  try {
    await clearClipQueue();
    // The previously-loaded context holds a file handle on weights we're about to delete.
    await releaseWhisper();
    if (!model) await releaseVad();
    deleteModelsExcept(model);
  } finally {
    setTranscriptionStatus({ kind: 'idle' });
  }
}

/**
 * Download `model`'s weights, its progress published as the transcription status (the editor's
 * Captions tool and the On-device AI sheet show it). Shared with a download already running.
 */
export async function downloadModel(model: WhisperModel): Promise<void> {
  if (isModelReady(model)) return;
  setTranscriptionStatus({ kind: 'downloading', bytesWritten: 0, totalBytes: model.approxBytes });
  try {
    await ensureModel(model, ({ bytesWritten, totalBytes }) =>
      setTranscriptionStatus({ kind: 'downloading', bytesWritten, totalBytes }),
    );
  } finally {
    setTranscriptionStatus({ kind: 'idle' });
  }
}

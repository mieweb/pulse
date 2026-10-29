import { clearClipQueue } from './clip-queue';
import { cancelModelDownloadsExcept, deleteModelsExcept, ensureModel, isModelReady } from './model';
import type { ModelProgress } from './model';
import type { WhisperModel } from './models';
import { clearTranscriptionStatus, setTranscriptionStatus } from './transcription-status';
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
    clearTranscriptionStatus('deleting');
  }
}

/** Downloads started, counting up (the newest owns the downloading status). */
let downloads = 0;

/**
 * Download `model`'s weights, its progress published as the transcription status (the editor's
 * Captions tool and the On-device AI sheet show it). Shared with a download already running.
 * Every other model's weights go first: a retired selection resolves to its replacement without
 * a selection change (models.ts), so the retired model's weights would otherwise stay.
 */
export async function downloadModel(model: WhisperModel): Promise<void> {
  if (isModelReady(model)) return;
  deleteModelsExcept(model);
  // Only the newest download clears the status: one cancelled by a switch settles later, after
  // the next one has started showing its progress.
  const mine = ++downloads;
  setTranscriptionStatus({ kind: 'downloading', bytesWritten: 0, totalBytes: model.approxBytes });
  // Published once per whole percent (what's shown), not per chunk, so the screens showing it
  // don't re-render for nothing.
  let shown = '';
  try {
    await ensureModel(model, ({ bytesWritten, totalBytes }) => {
      const at = `${Math.floor((100 * bytesWritten) / Math.max(1, totalBytes))}/${totalBytes}`;
      if (at === shown) return;
      shown = at;
      setTranscriptionStatus({ kind: 'downloading', bytesWritten, totalBytes });
    });
  } finally {
    if (mine === downloads) clearTranscriptionStatus('downloading');
  }
}

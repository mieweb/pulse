import { segmentsForDraft } from '@/db/drafts';
import { getRecorderFormat } from '@/features/recorder/recorder-format';

import { exportAudio, mergeWithEditor } from './editor-merge';
import { loadMergedExport, resolveMergedExport } from './merged-export';

/**
 * A Send's merge, the same from Export's Send and the host's `upload(id)`: the draft's saved
 * export when it still matches its clips in this device's audio layout, else a fresh merge (which
 * becomes the saved export). The Send uploads the saved `export.mp4` (`writeSendFiles`), so a
 * merge that couldn't be saved over an earlier cut's file fails the Send instead of queuing
 * those older bytes under this cut's key.
 */
export async function mergeForSend(draftId: string): Promise<{ durationMs: number }> {
  const segments = await segmentsForDraft(draftId);
  const recorder = await getRecorderFormat();
  const audio = exportAudio(recorder);
  await resolveMergedExport(draftId, segments, audio, (voiceover) =>
    mergeWithEditor(segments, recorder, new AbortController().signal, () => {}, voiceover),
  );
  const saved = await loadMergedExport(draftId, segments, audio);
  if (!saved) throw new Error(`Draft ${draftId}: the merged video couldn't be saved for sending.`);
  return { durationMs: saved.durationMs };
}

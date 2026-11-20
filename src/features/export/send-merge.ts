import { segmentsForDraft } from '@/db/drafts';
import { getRecorderFormat } from '@/features/recorder/recorder-format';

import { exportAudio, mergeWithEditor } from './editor-merge';
import { resolveMergedExport } from './merged-export';

/**
 * A Send's merge, the same from Export's Send and the host's `upload(id)`: the draft's saved
 * export when it still matches its clips in this device's audio layout, else a fresh merge (which
 * becomes the saved export).
 */
export async function mergeForSend(draftId: string): Promise<{ durationMs: number }> {
  const segments = await segmentsForDraft(draftId);
  const recorder = await getRecorderFormat();
  const { durationMs } = await resolveMergedExport(draftId, segments, exportAudio(recorder), () =>
    mergeWithEditor(segments, recorder, new AbortController().signal, () => {}),
  );
  return { durationMs };
}

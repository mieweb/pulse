import { Platform } from 'react-native';

import { getCaptionY } from '@/db/captions';
import { getClipTranscripts } from '@/db/clip-transcripts';
import { segmentsForDraft } from '@/db/drafts';
import { adoptMergedCaptionEdit } from '@/db/transcripts';
import { selectedModelQuery } from '@/db/settings';
import { effMs } from '@/utils/segment-window';

import { composeCaptions, type CaptionLine } from './compose';
import { resolveSelectedModel } from './models';

/**
 * A draft's captions as they're uploaded: composed from its clips as they are now (compose.ts),
 * and where they sit. Empty while a clip that speaks is still to be transcribed with the selected
 * model (a half-captioned video reads as broken); with no model, the edited captions there are.
 */
export async function getDraftCaptions(
  draftId: string,
): Promise<{ lines: CaptionLine[]; y: number | null }> {
  // A hand edit from the old merged-video subtitle editor moves onto the clips first (once; the
  // editor and export screens do it too), so an upload never leaves it behind.
  await adoptMergedCaptionEdit(draftId).catch((e: unknown) =>
    console.warn('[captions] could not carry over the edited captions', e),
  );
  const [row] = await selectedModelQuery;
  const model = resolveSelectedModel(row?.value ?? null, Platform.OS);
  const segments = (await segmentsForDraft(draftId)).filter((s) => effMs(s) > 0);
  const clips = model
    ? await getClipTranscripts(
        segments.map((s) => s.id),
        model.id,
      )
    : new Map();
  const composed = composeCaptions(segments, clips);
  const complete = !model || composed.missing.length === 0;
  return { lines: complete ? composed.lines : [], y: await getCaptionY(draftId) };
}

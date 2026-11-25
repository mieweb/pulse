import { Platform } from 'react-native';

import aiEditor from '../../../modules/expo-ai-editor/src/AiEditorModule';
import { aiEditSourceSignature, assertAiEditAudioSupported, createAiEdit } from '@/db/ai-edits';
import { getClipTranscripts, saveClipTranscript } from '@/db/clip-transcripts';
import { getDraftName, segmentsForDraft } from '@/db/drafts';
import { getSetting } from '@/db/settings';
import { pauseClipQueueForAiEdit } from '@/features/transcription/clip-queue';
import { clipWords } from '@/features/transcription/compose';
import { isModelReady } from '@/features/transcription/model';
import { getModel, resolveSelectedModel } from '@/features/transcription/models';
import { releaseWhisper, transcribeWords } from '@/features/transcription/whisper';
import { absolutize } from '@/utils/file-store';
import { clipRender, effMs, renderKey } from '@/utils/segment-window';

import { isAiEditingEnabled } from './enabled';
import { buildPassages, type AiEditSource } from './planner';
import { selectCut } from './selection';

export class AiEditSetupError extends Error {
  constructor(
    message: string,
    readonly openModels = false,
  ) {
    super(message);
  }
}

let editing = false;

/** No networking: media and speech weights must already be available locally. */
export async function runAiEdit(
  draftId: string,
  onProgress: (message: string) => void,
  signal: AbortSignal,
) {
  if (!isAiEditingEnabled()) throw new AiEditSetupError('AI editing is a developer experiment.');
  if (editing) throw new Error('An AI edit is already running.');
  editing = true;
  let resumeCaptions: (() => void) | undefined;
  const checkCancelled = () => {
    if (signal.aborted) throw new Error('AI edit cancelled.');
  };
  const cancelNative = () => void aiEditor.cancel().catch(() => {});
  signal.addEventListener('abort', cancelNative);
  try {
    checkCancelled();
    onProgress('Checking on-device AI…');
    const availability = await aiEditor.availability();
    checkCancelled();
    if (!availability.available) throw new AiEditSetupError(availability.message);
    const selected = resolveSelectedModel(await getSetting('transcription.model'), Platform.OS);
    const model = selected ?? getModel('parakeet-tdt-0.6b-v3-q4_0');
    if (!model || !isModelReady(model))
      throw new AiEditSetupError(
        'Download a speech model in On-device AI, then return and try AI edit again.',
        true,
      );
    const allSegments = await segmentsForDraft(draftId);
    const expectedSourceSignature = aiEditSourceSignature(allSegments);
    assertAiEditAudioSupported(draftId);
    const segments = allSegments.filter((segment) => effMs(segment) > 0);
    if (!segments.length) throw new Error('Add a spoken video to this project first.');
    if (segments.some((segment) => clipRender(segment).muted))
      throw new Error('Unmute the source clips before creating an AI cut.');
    if (segments.reduce((total, segment) => total + effMs(segment), 0) > 20 * 60_000)
      throw new Error('Try a recording under twenty minutes for this AI editing experiment.');

    // Captions and this foreground action share the same native speech context.
    resumeCaptions = await pauseClipQueueForAiEdit();
    checkCancelled();
    const transcripts = await getClipTranscripts(
      segments.map((segment) => segment.id),
      model.id,
    );
    const sources: AiEditSource[] = [];
    for (const [index, segment] of segments.entries()) {
      checkCancelled();
      onProgress(`Reading the speech… ${index + 1} of ${segments.length}`);
      const rendered = clipRender(segment);
      let transcript = clipWords(segment, transcripts);
      if (!transcript || transcript.failed) {
        const words = await transcribeWords(absolutize(rendered.file), model, {
          signal,
          allowModelDownload: false,
        });
        checkCancelled();
        await saveClipTranscript(segment.id, model.id, rendered.file, words);
        transcript = { words, edited: false, failed: false };
      }
      sources.push({
        segmentId: segment.id,
        file: rendered.file,
        sourceKey: renderKey(segment),
        startMs: rendered.inMs,
        endMs: rendered.outMs,
        speed: rendered.speed,
        words: transcript.words,
      });
    }
    // Free the speech model before asking the system language model for its working memory.
    await releaseWhisper();
    checkCancelled();
    const passages = buildPassages(sources);
    const plan = await selectCut(passages, aiEditor.selectPassages, onProgress, signal);
    checkCancelled();
    onProgress('Saving your editable cut…');
    const sourceName = await getDraftName(draftId);
    checkCancelled();
    return await createAiEdit({
      sourceDraftId: draftId,
      name: `${sourceName || 'Untitled'} · AI cut`,
      intervals: plan.intervals,
      expectedSourceSignature,
      signal,
    });
  } finally {
    signal.removeEventListener('abort', cancelNative);
    if (signal.aborted) await aiEditor.cancel().catch(() => {});
    if (resumeCaptions) {
      await releaseWhisper().catch(() => {});
      resumeCaptions();
    }
    editing = false;
  }
}

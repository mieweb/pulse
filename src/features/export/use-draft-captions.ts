import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useMemo, useState } from 'react';

import { clipWordsOf, draftClipTranscriptsQuery } from '@/db/clip-transcripts';
import type { Segment } from '@/db/schema';
import { selectedModelQuery } from '@/db/settings';
import { getDraftTranscriptRow, saveComposedTranscript } from '@/db/transcripts';
import { requestClipTranscripts } from '@/features/transcription/clip-queue';
import { composeCaptions } from '@/features/transcription/compose';
import { ensureModel, isModelReady } from '@/features/transcription/model-manager';
import { resolveSelectedModel } from '@/features/transcription/models';
import { setTranscriptionStatus } from '@/features/transcription/transcription-status';
import { useDraftTranscript } from '@/features/transcription/use-draft-transcripts';
import type { TranscriptLine } from '@/features/transcription/whisper';
import { segmentSignature } from '@/utils/segment-window';

export type CaptionsState =
  | { status: 'no-model' } // no on-device model selected — prompt to download one
  | { status: 'downloading'; progress: number } // fetching the selected model's weights
  | { status: 'transcribing' } // clips still being transcribed
  | { status: 'ready' } // captions available (or the clips have no speech)
  | { status: 'error'; message: string };

export type DraftCaptions = {
  state: CaptionsState;
  /** Effective captions for the overlay (hand-edit if present, else the composed lines). */
  lines: TranscriptLine[];
};

/**
 * The draft's captions on the export screen: composed from its clips' own transcripts through
 * their edits (compose.ts), so nothing waits for the merge and an edit never re-runs the model.
 * Asks the queue for any clip still missing (downloading the selected model first, as the export
 * screen is where a download is offered), and stores the composed lines as the draft's transcript
 * once every clip that speaks has one: the subtitle editor and the upload read them from there.
 */
export function useDraftCaptions(draftId: string, clips: Segment[]): DraftCaptions {
  const { data: modelRows } = useLiveQuery(selectedModelQuery, []);
  const model = resolveSelectedModel(modelRows[0]?.value ?? null);
  const { data: clipRows } = useLiveQuery(draftClipTranscriptsQuery(draftId, model?.id ?? ''), [
    draftId,
    model?.id,
  ]);

  const transcript = useDraftTranscript(draftId);
  const lines = transcript?.lines ?? [];

  const signature = useMemo(() => segmentSignature(clips), [clips]);
  const composed = useMemo(() => composeCaptions(clips, clipWordsOf(clipRows)), [clips, clipRows]);
  const [download, setDownload] = useState<
    { status: 'downloading'; progress: number } | { status: 'error'; message: string } | null
  >(null);

  // The model: downloaded here if it isn't yet, then every clip missing a transcript is queued.
  const missingKey = composed.ready ? '' : composed.missing.join('|');
  useEffect(() => {
    if (!model || !missingKey) return;
    let current = true;
    void (async () => {
      try {
        if (!isModelReady(model)) {
          setDownload({ status: 'downloading', progress: 0 });
          setTranscriptionStatus({ kind: 'downloading', bytesWritten: 0, totalBytes: model.approxBytes });
          await ensureModel(model, ({ bytesWritten, totalBytes }) => {
            if (!current) return;
            setDownload({ status: 'downloading', progress: totalBytes ? bytesWritten / totalBytes : 0 });
            setTranscriptionStatus({ kind: 'downloading', bytesWritten, totalBytes });
          });
          setTranscriptionStatus({ kind: 'idle' });
        }
        if (!current) return;
        setDownload(null);
        await requestClipTranscripts(clips, model);
      } catch (e) {
        if (!current) return;
        setTranscriptionStatus({ kind: 'idle' });
        setDownload({
          status: 'error',
          message: e instanceof Error ? e.message : 'Couldn’t download the captions model.',
        });
      }
    })();
    return () => {
      current = false;
    };
    // `clips` is read for the request; `missingKey` is what decides to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.id, missingKey]);

  // Every clip done: store the composed captions for these clips and this model, once.
  const composedLines = composed.ready ? composed : null;
  useEffect(() => {
    if (!model || !composedLines) return;
    let current = true;
    void (async () => {
      const row = await getDraftTranscriptRow(draftId);
      if (!current) return;
      const json = JSON.stringify(composedLines.lines);
      if (row && row.signature === signature && row.status === 'done' && row.lines === json) return;
      await saveComposedTranscript(draftId, signature, model.id, composedLines.lines, composedLines.durationMs);
    })().catch((e) => console.warn('[captions] could not store the draft captions', e));
    return () => {
      current = false;
    };
  }, [draftId, signature, model, composedLines]);

  const state: CaptionsState = !model
    ? { status: 'no-model' }
    : download
      ? download
      : composed.ready
        ? { status: 'ready' }
        : { status: 'transcribing' };
  return { state, lines };
}

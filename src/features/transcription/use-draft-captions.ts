import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import {
  clearClipTranscriptFailures,
  clipWordsOf,
  draftClipTranscriptsQuery,
  type ClipWords,
} from '@/db/clip-transcripts';
import type { Segment } from '@/db/schema';
import { selectedModelQuery } from '@/db/settings';
import { adoptMergedCaptionEdit } from '@/db/transcripts';
import { userMessage } from '@/utils/user-message';

import { requestClipTranscripts } from './clip-queue';
import { composeCaptions, type CaptionLine, type ClipLayout } from './compose';
import { downloadModel, isModelReady } from './model-manager';
import { resolveSelectedModel, type WhisperModel } from './models';
import { useTranscriptionStatus } from './transcription-status';

export type CaptionsState =
  | { status: 'no-model' } // no on-device model selected
  | { status: 'needs-download' } // selected, its weights not on the phone yet
  | { status: 'downloading'; progress: number }
  | { status: 'transcribing' } // clips still being transcribed
  | { status: 'ready' }; // every clip that speaks has its words (some may have failed)

export type DraftCaptions = {
  model: WhisperModel | null;
  state: CaptionsState;
  /** The draft's captions, on its timeline (centiseconds), as far as they're known. */
  lines: CaptionLine[];
  /** Clip transcripts by clip, for edits (compose.ts `clipWords`). */
  clipRows: ReadonlyMap<string, ClipWords>;
  /** Clips the model couldn't transcribe. */
  failed: string[];
  /** The last download's error, until the next try. */
  downloadError: string | null;
  /** Download the selected model (the person asked for captions). */
  download: () => void;
  /** Transcribe the failed clips again. */
  retry: () => void;
};

/**
 * A draft's captions, composed from its clips' words through their edits (compose.ts) whenever
 * the clips change — nothing stored, so they're never stale, and an edit never re-runs the
 * model. `segments` are the draft's clips in order, as they play now (the editor passes its
 * pending edits). Any clip still missing words is queued while the selected model is on the
 * phone. Shared by the editor (where captions are made and edited) and the export screen.
 */
export function useDraftCaptions(
  draftId: string,
  segments: readonly Segment[],
  /** Where the clips sit (the editor's preview positions); summed lengths without it. */
  layout?: ClipLayout,
): DraftCaptions {
  const { data: modelRows } = useLiveQuery(selectedModelQuery, []);
  const model = resolveSelectedModel(modelRows[0]?.value ?? null, Platform.OS);
  const { data: rows } = useLiveQuery(draftClipTranscriptsQuery(draftId, model?.id ?? ''), [
    draftId,
    model?.id,
  ]);
  const status = useTranscriptionStatus();
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // A hand-edit from the old merged-video subtitle editor moves onto the clips, once.
  useEffect(() => {
    void adoptMergedCaptionEdit(draftId).catch((e) =>
      console.warn('[captions] could not carry over the edited captions', e),
    );
  }, [draftId]);

  const clipRows = useMemo(() => clipWordsOf(rows), [rows]);
  const composed = useMemo(
    () => composeCaptions(segments, clipRows, layout),
    [segments, clipRows, layout],
  );
  const ready = !!model && isModelReady(model);

  // The clips still missing words, asked for whenever that set changes (or the model arrives).
  const missingKey = composed.missing.join('|');
  // `segments` is read for the request (the latest); `missingKey` is what decides to ask again.
  const request = useEffectEvent((key: string, m: WhisperModel) => {
    const ids = new Set(key.split('|'));
    requestClipTranscripts(
      segments.filter((s) => ids.has(s.id)),
      m,
    );
  });
  useEffect(() => {
    if (!model || !ready || !missingKey) return;
    request(missingKey, model);
  }, [model, ready, missingKey]);

  const state: CaptionsState = !model
    ? { status: 'no-model' }
    : composed.missing.length === 0
      ? { status: 'ready' }
      : status.kind === 'downloading'
        ? {
            status: 'downloading',
            progress: status.totalBytes ? status.bytesWritten / status.totalBytes : 0,
          }
        : !ready
          ? { status: 'needs-download' }
          : { status: 'transcribing' };

  const download = () => {
    if (!model) return;
    setDownloadError(null);
    downloadModel(model).catch((e) =>
      setDownloadError(userMessage(e, 'Check your connection and try again.', 'download model')),
    );
  };

  const retry = () => {
    if (!model) return;
    void clearClipTranscriptFailures(composed.failed, model.id).catch(() => {});
  };

  return {
    model,
    state,
    lines: composed.lines,
    clipRows,
    failed: composed.failed,
    downloadError,
    download,
    retry,
  };
}

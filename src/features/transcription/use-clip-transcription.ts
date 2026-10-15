import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect } from 'react';

import type { Segment } from '@/db/schema';
import { selectedModelQuery } from '@/db/settings';

import { requestClipTranscripts } from './clip-queue';
import { resolveSelectedModel } from './models';

/** How long after the clips last changed the queue is asked (a burst of takes asks once). */
const SETTLE_MS = 2000;

/**
 * Keep a draft's clips transcribed in the background while a screen showing them is `active`
 * (the recorder between takes, the editor): a moment after the clips change, any clip without a
 * transcript of its file for the selected model is queued (clip-queue.ts). Nothing happens without
 * a selected, downloaded model.
 */
export function useClipTranscription(segments: Segment[], active: boolean): void {
  const { data: modelRows } = useLiveQuery(selectedModelQuery, []);
  const model = resolveSelectedModel(modelRows[0]?.value ?? null);
  useEffect(() => {
    if (!active || !model || segments.length === 0) return;
    const timer = setTimeout(() => void requestClipTranscripts(segments, model), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [active, model, segments]);
}

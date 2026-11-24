import {
  launchImageLibraryAsync,
  UIImagePickerPreferredAssetRepresentationMode,
} from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

import type { ClipAnchor } from '@/core/clip-anchor';
import { useToast } from '@/features/toast/toast-provider';
import { describeError, formatSeconds } from '@/features/upload/core/upload-log';
import { deleteQuietly } from '@/utils/file-store';
import {
  imageBatchFailureTitle,
  imageBatchNotice,
  imageFailureCopy,
  imageStepCount,
  imageStepText,
  imageStoppedMessage,
  isOutOfSpace,
} from '@/utils/import-copy';
import { userMessage } from '@/utils/user-message';

import { addImageClips, type ImageBatchStep } from './add-image-clips';
import { importLog } from './import-log';
import { usePhotosAccess } from './photos-access';

/** The most images one pick adds: a run of screenshots, not a whole album. */
export const IMAGE_SELECTION_LIMIT = 20;

/**
 * Import images or screenshots into a draft, at an anchor: the system picker (several at once, in
 * the order picked; Photos access asked for on iOS, as the video import does), then
 * `addImageClips`, one 3 s clip per image, with its busy state and progress for the "+" that
 * started it. The editor's "+" and the recorder's both use it.
 *
 * The progress is the whole batch's (image 2 of 5 half done is 0.3), and `step` says which image
 * ("Adding 2 of 5"). An image that can't be read is skipped and the rest go on; a toast says which
 * weren't added. Leaving Pulse mid-batch stops it (the images added so far stay; an alert says so
 * on return), and so does the screen closing.
 */
export function useImportImages() {
  const { showToast } = useToast();
  const ensurePhotosAccess = usePhotosAccess();
  const [importing, setImporting] = useState(false);
  const [step, setStep] = useState<ImageBatchStep | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const unmounted = useRef(false);
  useEffect(
    () => () => {
      unmounted.current = true;
      abortRef.current?.abort();
    },
    [],
  );

  async function importImages(
    draftId: string | (() => Promise<string>),
    anchor: () => ClipAnchor,
    {
      onWriting,
      onAdded,
    }: {
      /** A clip's id just before its row is written (`addImageClips`). */
      onWriting?: (segmentId: string) => void;
      /** A clip's id once it's in the draft. */
      onAdded?: (segmentId: string) => void;
    } = {},
  ): Promise<void> {
    if (abortRef.current) return;
    // The screen may have closed while the system asked.
    if (!(await ensurePhotosAccess('images')) || unmounted.current) return;
    const abort = new AbortController();
    abortRef.current = abort;
    let picked: string[] = [];
    // Counted as they go in, for a batch that throws part-way (the clips before it stay).
    let added = 0;
    let appStateSub: ReturnType<typeof AppState.addEventListener> | null = null;
    try {
      const result = await launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: IMAGE_SELECTION_LIMIT,
        // iOS: numbered badges, and the images come back in the order they were picked.
        orderedSelection: true,
        // The original file (a HEIC stays HEIC), copied to a local file in the cache dir: no
        // `quality` and no editing, so the picker never re-encodes it; imageClip decodes it.
        preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      if (result.canceled || !result.assets?.length) return;
      picked = result.assets.map((a) => a.uri);
      if (unmounted.current) abort.abort(); // the picker returned to a closed screen
      setStep({ index: 0, total: picked.length, fraction: 0 });
      setImporting(true);
      const started = Date.now();
      importLog.info(`picked ${picked.length} image${picked.length === 1 ? '' : 's'}`);
      // Only a real move to the background stops it; Control Center or Face ID ('inactive') don't.
      appStateSub = AppState.addEventListener('change', (state) => {
        if (state === 'background') abort.abort();
      });
      const outcome = await addImageClips(picked, draftId, {
        signal: abort.signal,
        anchor,
        onProgress: setStep,
        onWriting,
        onAdded: (id) => {
          added++;
          onAdded?.(id);
        },
      });
      if (outcome.cancelled) {
        const after = formatSeconds(Date.now() - started);
        if (unmounted.current) {
          importLog.warn(`images cancelled after ${after}: the screen was closed`);
          return;
        }
        importLog.warn(`images cancelled after ${after}: Pulse left the screen`);
        // An alert, not a toast: this fires while Pulse is in the background.
        Alert.alert(
          'Import stopped',
          imageStoppedMessage({
            total: picked.length,
            added: outcome.added.length,
            skipped: outcome.skipped.length,
          }),
        );
        return;
      }
      const notice = imageBatchNotice({ total: picked.length, skipped: outcome.skipped });
      if (notice && !unmounted.current) showToast(notice);
    } catch (e) {
      const why = describeError(e);
      importLog.warn(`images failed after ${added} of ${picked.length}: ${why}`);
      if (!unmounted.current) {
        showToast({
          kind: 'error',
          // The clips added before it stay: say how many went in.
          title: imageBatchFailureTitle(picked.length, added),
          message: isOutOfSpace(why)
            ? imageFailureCopy(why)
            : userMessage(e, 'Try again.', 'import'),
        });
      }
    } finally {
      appStateSub?.remove();
      abortRef.current = null;
      // The picker's copies in the cache dir: the clips are in the draft (or were skipped).
      for (const uri of picked) deleteQuietly(uri);
      if (!unmounted.current) {
        setStep(null);
        setImporting(false);
      }
    }
  }

  return {
    /**
     * Pick images and add them to `draftId` (or the draft it resolves to, once one is made) at
     * `anchor` (read as the first clip is written). Resolves once the batch is over.
     */
    importImages,
    importing,
    /** The batch's progress (0–1), null while idle. */
    progress: step ? (step.index + step.fraction) / step.total : null,
    /** "Adding 2 of 5" while a batch runs, for screen readers. */
    stepText: step ? imageStepText(step.index, step.total) : undefined,
    /** "2/5" while a batch of several runs, shown by the "+"; undefined otherwise. */
    stepCount: (step && imageStepCount(step.index, step.total)) ?? undefined,
  };
}

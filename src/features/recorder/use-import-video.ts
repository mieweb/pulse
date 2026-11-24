import {
  launchImageLibraryAsync,
  UIImagePickerPreferredAssetRepresentationMode,
} from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

import type { ClipAnchor } from '@/core/clip-anchor';
import { useToast } from '@/features/toast/toast-provider';
import { describeError, formatBytes, formatSeconds } from '@/features/upload/core/upload-log';
import { deleteQuietly } from '@/utils/file-store';
import { importFailureCopy, isOutOfSpace } from '@/utils/import-copy';
import { userMessage } from '@/utils/user-message';

import { addExternalClip } from './add-external-clip';
import { importLog } from './import-log';
import { usePhotosAccess } from './photos-access';

/**
 * Import video into an existing draft, at an anchor: the system picker (Photos access asked for
 * on iOS, `usePhotosAccess`), then `addExternalClip`, with its busy state and progress for the
 * "+" that started it. The editor's "+" uses it; the recorder's own import (use-recorder.ts) does
 * the same steps around its take state and its draft made on demand.
 *
 * Leaving Pulse mid-import cancels it (nothing is added; an alert says so on return), and so does
 * the screen closing (no toast then: the person has left it).
 */
export function useImportVideo() {
  const { showToast } = useToast();
  const ensurePhotosAccess = usePhotosAccess();
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const unmounted = useRef(false);
  useEffect(
    () => () => {
      unmounted.current = true;
      abortRef.current?.abort();
    },
    [],
  );

  async function importVideo(draftId: string, anchorAtPick: () => ClipAnchor) {
    if (abortRef.current) return;
    // Where it goes is decided now, as Import video is picked, like every "+" item: scrubbing,
    // trimming or reordering during a long conversion doesn't move it.
    const anchor = anchorAtPick();
    // The screen may have closed while the system asked.
    if (!(await ensurePhotosAccess('videos')) || unmounted.current) return;
    const abort = new AbortController();
    abortRef.current = abort;
    let pickedUri: string | null = null;
    let appStateSub: ReturnType<typeof AppState.addEventListener> | null = null;
    try {
      const result = await launchImageLibraryAsync({
        mediaTypes: ['videos'],
        // The original, never a picker transcode: addExternalClip owns the conversion.
        preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      const picked = result.assets?.[0];
      if (result.canceled || !picked) return;
      pickedUri = picked.uri;
      if (unmounted.current) abort.abort(); // the picker returned to a closed screen
      setProgress(null);
      setImporting(true);
      const started = Date.now();
      importLog.info(
        `picked ${picked.fileName ?? 'a video'}` +
          (picked.fileSize ? ` (${formatBytes(picked.fileSize)})` : '') +
          (picked.duration ? `, ${formatSeconds(picked.duration)}` : '') +
          ' (editor)',
      );
      // Only a real move to the background cancels; Control Center or Face ID ('inactive') don't.
      appStateSub = AppState.addEventListener('change', (state) => {
        if (state === 'background') abort.abort();
      });
      const outcome = await addExternalClip(picked.uri, draftId, null, {
        signal: abort.signal,
        onProgress: setProgress,
        anchor: () => anchor,
      });
      if (outcome.status === 'cancelled') {
        const after = formatSeconds(Date.now() - started);
        if (unmounted.current) {
          importLog.warn(`cancelled after ${after}: the editor was closed`);
          return;
        }
        importLog.warn(`cancelled after ${after}: Pulse left the screen`);
        // An alert, not a toast: this fires while Pulse is in the background.
        Alert.alert(
          'Import cancelled',
          'Pulse left the screen before the video finished converting. Try again and keep Pulse open until it’s done.',
        );
      } else if (outcome.status === 'rejected' && !unmounted.current) {
        showToast({
          kind: 'error',
          title: 'Couldn’t import the video',
          message: importFailureCopy(outcome.why),
        });
      }
    } catch (e) {
      const why = describeError(e);
      importLog.warn(`failed: ${why}`);
      if (!unmounted.current) {
        showToast({
          kind: 'error',
          title: 'Couldn’t import the video',
          message: isOutOfSpace(why)
            ? importFailureCopy(why)
            : userMessage(e, 'Try again.', 'import'),
        });
      }
    } finally {
      appStateSub?.remove();
      abortRef.current = null;
      // The picker's full-size copy in the cache dir: the clip is in the draft (or was rejected).
      if (pickedUri) deleteQuietly(pickedUri);
      if (!unmounted.current) {
        setProgress(null);
        setImporting(false);
      }
    }
  }

  return {
    /** Pick a video and add it to `draftId` at `anchor`, read once, as this is called. */
    importVideo: (draftId: string, anchor: () => ClipAnchor) => void importVideo(draftId, anchor),
    importing,
    /** The conversion's progress (0–1); null until it reports. */
    progress,
  };
}

import { useEffect, useRef } from 'react';
import VideoTrim, { showEditor, type Spec } from 'react-native-video-trim';

import { setEditState } from '@/db/drafts';
import type { Segment } from '@/db/schema';
import { Accent } from '@/constants/theme';
import { useToast } from '@/features/toast/toast-provider';
import { absolutize } from '@/utils/file-store';
import { userMessage } from '@/utils/user-message';

import {
  editStateSpeed,
  loadCustomSpeeds,
  saveCustomSpeeds,
  speedMenu,
  withCustomSpeed,
} from './editor-speeds';

const Native = VideoTrim as Spec;

/**
 * Drives react-native-video-trim's full-screen editor (trim + crop/rotate/flip/mute/speed).
 * Tap a clip → `openTrim` opens the editor on the PRISTINE original with the clip's saved
 * `editState` applied (settings and undo/redo history), so it reopens where the user left off.
 * Save encodes nothing (`renderOnSave: false`): the editor closes at once and hands back the new
 * `editState`, stored via `setEditState` — the preview applies it live and the export's merge
 * renders it, once. The editor's trash button hands the clip to `onDelete`, the recorder's own
 * delete, so it behaves exactly like the preview's 🗑 and drag-to-trash.
 */
export function useVideoTrim(draftId: string | null, onDelete: (segmentId: string) => void) {
  // The editor is fire-and-forget (showEditor) and its events carry no correlation id, so we
  // stash which segment/draft the current session belongs to and read it back in the events.
  const pendingSegmentId = useRef<string | null>(null);
  const draftIdRef = useRef(draftId);
  // The listeners below are attached once; they reach the recorder's current delete through this.
  const onDeleteRef = useRef(onDelete);
  useEffect(() => {
    draftIdRef.current = draftId;
    onDeleteRef.current = onDelete;
  }, [draftId, onDelete]);

  const { showToast } = useToast();

  // Recent custom speeds, offered in the editor's speed menu next time (#222).
  const customSpeeds = useRef<readonly number[]>([]);
  useEffect(() => {
    void loadCustomSpeeds().then((speeds) => {
      customSpeeds.current = speeds;
    });
  }, []);

  useEffect(() => {
    const subs = [
      Native.onSaveEditState(({ editState }) => {
        const segmentId = pendingSegmentId.current;
        pendingSegmentId.current = null;
        if (!segmentId || !draftIdRef.current) return;
        void (async () => {
          try {
            await setEditState(segmentId, editState);
          } catch (e) {
            showToast({
              kind: 'error',
              title: 'Couldn’t save the edit',
              message: userMessage(e, 'Try again.', 'trim'),
            });
            return;
          }
          const speeds = withCustomSpeed(customSpeeds.current, editStateSpeed(editState));
          if (speeds !== customSpeeds.current) {
            customSpeeds.current = speeds;
            void saveCustomSpeeds(speeds).catch(() => {});
          }
        })();
      }),
      // The trash was tapped and the editor has closed. No confirm on either side: the recorder
      // deletes it at once with its toast, like every other delete.
      Native.onDelete(() => {
        const segmentId = pendingSegmentId.current;
        pendingSegmentId.current = null;
        if (segmentId) onDeleteRef.current(segmentId);
      }),
      Native.onCancel(() => {
        pendingSegmentId.current = null;
      }),
      Native.onError(({ message }) => {
        pendingSegmentId.current = null;
        showToast({
          kind: 'error',
          title: 'Couldn’t edit the clip',
          message: userMessage(message, 'The editor reported an error.', 'trim'),
        });
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [showToast]);

  const openTrim = (segment: Segment) => {
    if (!draftIdRef.current) return;
    pendingSegmentId.current = segment.id;
    showEditor(absolutize(segment.originalFilename), {
      theme: 'dark',
      trimmerColor: Accent,
      handleIconColor: '#FFFFFF',
      headerText: 'Edit clip',
      headerTextColor: '#FFFFFF',
      enableCancelDialog: false, // Cancel/Save dismiss immediately — no "are you sure?" prompts
      enableSaveDialog: false,
      renderOnSave: false, // Save = store the settings; the export's merge renders them
      // enableEditTools defaults true (crop/rotate/flip/mute/speed exposed).
      editState: segment.editState ?? undefined,
      speedOptions: speedMenu(customSpeeds.current),
      // Deletes at once with a toast, like the preview's 🗑 and drag-to-trash (see onDelete).
      enableDeleteButton: true,
      enableDeleteDialog: false,
    });
  };

  return { openTrim };
}

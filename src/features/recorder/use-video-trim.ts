import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import VideoTrim, { showEditor, type Spec } from 'react-native-video-trim';

import { deleteSegment, setEditState } from '@/db/drafts';
import type { Segment } from '@/db/schema';
import { Accent } from '@/constants/theme';
import { absolutize } from '@/utils/file-store';

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
 * renders it, once. The editor's trash button deletes the clip.
 */
export function useVideoTrim(draftId: string | null) {
  // The editor is fire-and-forget (showEditor) and its events carry no correlation id, so we
  // stash which segment/draft the current session belongs to and read it back in the events.
  const pendingSegmentId = useRef<string | null>(null);
  const draftIdRef = useRef(draftId);
  useEffect(() => {
    draftIdRef.current = draftId;
  }, [draftId]);

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
            console.warn('[trim] failed to save edit', e);
            Alert.alert('Edit failed', 'Could not save the edit. Please try again.');
            return;
          }
          const speeds = withCustomSpeed(customSpeeds.current, editStateSpeed(editState));
          if (speeds !== customSpeeds.current) {
            customSpeeds.current = speeds;
            void saveCustomSpeeds(speeds).catch(() => {});
          }
        })();
      }),
      // The editor confirmed the delete itself and has closed.
      Native.onDelete(() => {
        const segmentId = pendingSegmentId.current;
        pendingSegmentId.current = null;
        if (!segmentId) return;
        deleteSegment(segmentId).catch((e) => {
          console.warn('[trim] failed to delete clip', e);
          Alert.alert('Delete failed', 'Could not delete the clip. Please try again.');
        });
      }),
      Native.onCancel(() => {
        pendingSegmentId.current = null;
      }),
      Native.onError(({ message }) => {
        pendingSegmentId.current = null;
        console.warn('[trim] editor error', message);
        Alert.alert('Edit failed', message || 'The editor reported an error.');
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

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
      // Deleting is the one irreversible action here, so it keeps its confirm (same copy as the
      // preview's 🗑).
      enableDeleteButton: true,
      deleteDialogTitle: 'Delete clip?',
      deleteDialogMessage: 'This clip will be removed from the draft.',
      deleteDialogCancelText: 'Cancel',
      deleteDialogConfirmText: 'Delete',
    });
  };

  return { openTrim };
}

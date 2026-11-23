// Which buttons Export shows and what the main one says, from the shell's props and the host's
// policy. Pure, so the rule lives in one place and is tested without rendering.
import type { ExportPolicy } from './contract';

export const USE_VIDEO_LABEL = 'Use this video';
export const UPLOAD_LABEL = 'Upload';
export const PREPARING_LABEL = 'Preparing video…';

export type ExportActionsInput = {
  /** The shell's primary action (`onUse` isn't needed here). */
  primaryAction: { kind: 'upload-pool' } | { kind: 'use-video'; label: string };
  policy: ExportPolicy;
  /** The app declares the Photos-add purpose string (see `ExportScreenProps.photosAddPurpose`). */
  photosAddPurpose: boolean;
  /** The merge is still running (the upload button says so). */
  merging: boolean;
  /** The pool's selected destination: the name on the button and the one read out. */
  destination: { name: string; spokenName: string } | null;
};

export type ExportActions = {
  /**
   * 'upload': the pool's destination picker and Upload button (and what follows an upload).
   * 'use-video': one button that hands the video back.
   */
  primary: { kind: 'upload' | 'use-video'; label: string; accessibilityLabel: string };
  share: boolean;
  saveToPhotos: boolean;
};

export function exportActions(input: ExportActionsInput): ExportActions {
  const { primaryAction, policy, photosAddPurpose, merging, destination } = input;
  let primary: ExportActions['primary'];
  if (primaryAction.kind === 'use-video') {
    const label = primaryAction.label.trim() || USE_VIDEO_LABEL;
    primary = { kind: 'use-video', label, accessibilityLabel: label };
  } else {
    primary = {
      kind: 'upload',
      // The place's own name when its link gave one, else the server's host (the caller's pick).
      label: merging ? PREPARING_LABEL : destination?.name || UPLOAD_LABEL,
      accessibilityLabel: destination ? `Upload to ${destination.spokenName}` : UPLOAD_LABEL,
    };
  }
  return {
    primary,
    share: policy.allowShare,
    // Without the purpose string the save would crash the app, so no policy can turn it on.
    saveToPhotos: policy.allowSaveToPhotos && photosAddPurpose,
  };
}

import type { LiveUploadState } from './types';

type UploadingState = Extract<LiveUploadState, { status: 'uploading' }>;

/**
 * Human-readable label for an in-flight upload. Only `video` has real progress
 * and shows a byte percent, so the label never sits at a misleading 0% while
 * pre-video work runs.
 */
export function uploadPhaseLabel(state: UploadingState): string {
  switch (state.phase) {
    case 'preparing':
      return 'Preparing…';
    case 'captions':
      return 'Uploading captions…';
    case 'manifest':
      return 'Uploading manifest…';
    case 'thumbnail':
      return 'Uploading thumbnail…';
    case 'video': {
      const percent = Math.round(Math.min(1, Math.max(0, state.progress)) * 100);
      return `Uploading video… ${percent}%`;
    }
  }
}

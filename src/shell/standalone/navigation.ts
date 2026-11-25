import { router } from 'expo-router';

import { anchorToRouteParam } from '@/core/clip-anchor';
import type { RecorderEditAt } from '@/features/recorder/contract';

/**
 * Close a presented screen (recorder / export) reliably.
 *
 * `router.back()` dispatches GO_BACK, which throws "The action 'GO_BACK' was not
 * handled by any navigator" when the screen is the ROOT of the stack — e.g. a cold
 * start or dev fast-refresh that lands straight on /recorder, with no /index beneath
 * it to pop to. Guard on canGoBack() and otherwise reset to home so the X always works.
 */
export function closeToHome() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/**
 * The params of an editor the recorder's Edit opens (src/app/editor.tsx reads them): on the clip
 * tapped, else at the insert cursor (`anchorToRouteParam`).
 */
export function editorParams(draftId: string, at: RecorderEditAt): Record<string, string> {
  return 'clipId' in at
    ? { draftId, clipId: at.clipId }
    : { draftId, anchor: anchorToRouteParam(at.anchor) };
}

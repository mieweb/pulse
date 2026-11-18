import * as Linking from 'expo-linking';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import { ScreenFocusProvider } from '@/core/navigation/focus';
import { finishWithVideo, useEmbedded } from '@/features/embed/host';
import type { ExportCloseResult, ExportPrimaryAction } from '@/features/export/contract';
import { ExportScreen } from '@/features/export/export-screen';
import { closeToHome } from '@/shell/standalone/navigation';

const POLICY = { allowShare: true, allowSaveToPhotos: true };
const UPLOAD_POOL: ExportPrimaryAction = { kind: 'upload-pool' };
// The M1 embed (V0) runs these routes too: there the video goes back to the host.
const USE_VIDEO: ExportPrimaryAction = {
  kind: 'use-video',
  label: 'Use this video',
  onUse: (v) => void finishWithVideo(v.draftId, v.path, v.durationMs),
};

/** The export route: params in, ✕ back (home, while an upload holds the draft). */
export default function ExportRoute() {
  const focused = useIsFocused();
  const { draftId } = useLocalSearchParams<{ draftId?: string }>();
  const embedded = useEmbedded();
  const onClose = useCallback(({ draftLocked }: ExportCloseResult) => {
    // Locked: skip the recorder underneath (an editable timeline under a locked draft).
    if (!draftLocked) closeToHome();
    else if (router.canDismiss()) router.dismissAll();
    else router.replace('/');
  }, []);
  return (
    <ScreenFocusProvider focused={focused}>
      <ExportScreen
        draftId={draftId ?? ''}
        primaryAction={embedded ? USE_VIDEO : UPLOAD_POOL}
        policy={POLICY}
        onClose={onClose}
        onBackToHost={(url) => void Linking.openURL(url).catch(() => {})}
      />
    </ScreenFocusProvider>
  );
}

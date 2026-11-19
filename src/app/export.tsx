import * as Linking from 'expo-linking';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import { ScreenFocusProvider } from '@/core/navigation/focus';
import type { ExportCloseResult, ExportPrimaryAction } from '@/features/export/contract';
import { ExportScreen } from '@/features/export/export-screen';
import { uploads } from '@/features/upload/upload-manager';
import { closeToHome } from '@/shell/standalone/navigation';
import { copyToClipboard } from '@/utils/clipboard';

const POLICY = { allowShare: true, allowSaveToPhotos: true };
const UPLOAD_POOL: ExportPrimaryAction = { kind: 'upload-pool' };

// The Pulse app copies a finished upload's link to the clipboard (Export is where uploads start).
// The embed has no clipboard, so the upload manager only gets one here, from the app's own route.
uploads.setCopyLink(copyToClipboard);

/** The export route: params in, ✕ back (home, while an upload holds the draft). */
export default function ExportRoute() {
  const focused = useIsFocused();
  const { draftId } = useLocalSearchParams<{ draftId?: string }>();
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
        primaryAction={UPLOAD_POOL}
        policy={POLICY}
        onClose={onClose}
        onBackToHost={(url) => void Linking.openURL(url).catch(() => {})}
      />
    </ScreenFocusProvider>
  );
}

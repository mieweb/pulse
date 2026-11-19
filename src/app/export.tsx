import * as Linking from 'expo-linking';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import { ScreenFocusProvider } from '@/core/navigation/focus';
import type { ExportCloseResult, ExportPrimaryAction } from '@/features/export/contract';
import { ExportScreen } from '@/features/export/export-screen';
import { closeToHome } from '@/shell/standalone/navigation';

const POLICY = { allowShare: true, allowSaveToPhotos: true };
const UPLOAD_POOL: ExportPrimaryAction = { kind: 'upload-pool' };

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

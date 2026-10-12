import * as DocumentPicker from 'expo-document-picker';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { useState } from 'react';

import { useToast } from '@/features/toast/toast-provider';
import { formatCount } from '@/utils/format';
import { userMessage } from '@/utils/user-message';

import { exportDrafts } from './pack';
import { importPulseFile } from './unpack';

type TransferState = 'idle' | 'exporting' | 'importing';

/**
 * Drives `.pulse` export (multi-select → share sheet) and import (document picker → disk + DB).
 * A single `state` gates re-entry so a slow pack/unpack can't be triggered twice.
 */
export function useDraftTransfer() {
  const [state, setState] = useState<TransferState>('idle');
  const { showToast } = useToast();
  const busy = state !== 'idle';

  /** Pack the selected drafts into a `.pulse` file and hand it to the system share sheet. */
  async function shareDrafts(draftIds: string[]): Promise<void> {
    if (busy || draftIds.length === 0) return;
    setState('exporting');
    try {
      if (!(await isAvailableAsync())) {
        throw new Error('Sharing isn’t available on this device.');
      }
      const uri = await exportDrafts(draftIds, Date.now());
      await shareAsync(uri, {
        mimeType: 'application/zip',
        UTI: 'public.data',
        dialogTitle: draftIds.length === 1 ? 'Share draft' : 'Share drafts',
      });
    } catch (e) {
      showToast({
        kind: 'error',
        title: 'Couldn’t export drafts',
        message: userMessage(e, 'Try again.', 'export'),
      });
    } finally {
      setState('idle');
    }
  }

  /** Pick a `.pulse` file and import its drafts. Returns the new draft ids (empty if cancelled). */
  async function importDrafts(): Promise<string[]> {
    if (busy) return [];
    // Open the picker before flipping to busy so the system sheet appears immediately.
    const picked = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
    });
    const asset = picked.canceled ? null : picked.assets?.[0];
    if (!asset) return [];

    setState('importing');
    try {
      const { draftIds } = await importPulseFile(asset.uri);
      showToast(`${formatCount(draftIds.length, 'draft', 'drafts')} imported`);
      return draftIds;
    } catch (e) {
      showToast({
        kind: 'error',
        title: 'Couldn’t import drafts',
        message: userMessage(e, 'Try again.', 'import'),
      });
      return [];
    } finally {
      setState('idle');
    }
  }

  return { state, busy, shareDrafts, importDrafts };
}

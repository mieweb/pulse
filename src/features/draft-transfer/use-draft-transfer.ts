import { reloadAppAsync } from 'expo';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { useState } from 'react';
import { Alert } from 'react-native';

import { expoDb } from '@/db/client';
import { useToast } from '@/features/toast/toast-provider';
import { formatCount } from '@/utils/format';
import { userMessage } from '@/utils/user-message';

import { restoreLibraryBackup } from './library-backup';
import { exportDrafts } from './pack';
import { importPulseFile, skippedSummary } from './unpack';
import { importProjectFile, pulseFileKind } from './unpack-project';

/** Delete a file if it's there; never throws (a clean-up must not fail its caller). */
function deleteQuietly(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {}
}

/** Ask before a library backup replaces the library. */
const confirmRestore = () =>
  new Promise<boolean>((resolve) =>
    Alert.alert(
      'Replace your library?',
      'Your drafts become the ones in this backup, and Pulse reopens to finish.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Replace', style: 'destructive', onPress: () => resolve(true) },
      ],
    ),
  );

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
      const uri = exportDrafts(expoDb, draftIds, Date.now());
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
      const kind = await pulseFileKind(asset.uri);
      if (kind === 'library-backup') {
        if (!(await confirmRestore())) return [];
        await restoreLibraryBackup(expoDb, asset.uri, Date.now());
        deleteQuietly(asset.uri); // the picker's copy; it can be as large as the library
        try {
          await reloadAppAsync('Restoring a library backup'); // the next launch swaps it in
        } catch {
          showToast({
            kind: 'warning',
            title: 'Backup ready to restore',
            message: 'Close Pulse and open it again to finish.',
          });
        }
        return [];
      }
      if (kind === 'project') {
        const ids = importProjectFile(expoDb, asset.uri, Crypto.randomUUID);
        showToast(`${formatCount(ids.length, 'draft', 'drafts')} imported`);
        return ids;
      }
      const { draftIds, skipped } = await importPulseFile(asset.uri);
      const imported = `${formatCount(draftIds.length, 'draft', 'drafts')} imported`;
      // Clips the phone couldn't take are left out, not fatal: say so, without a dialog.
      if (skipped.length > 0) {
        showToast({ kind: 'warning', title: imported, message: skippedSummary(skipped) });
      } else {
        showToast(imported);
      }
      return draftIds;
    } catch (e) {
      showToast({
        kind: 'error',
        title: 'Couldn’t import drafts',
        message: userMessage(e, 'Try again.', 'import'),
      });
      return [];
    } finally {
      deleteQuietly(asset.uri); // the picker's copy in the cache
      setState('idle');
    }
  }

  return { state, busy, shareDrafts, importDrafts };
}

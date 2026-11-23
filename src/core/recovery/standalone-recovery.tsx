import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useState } from 'react';

import { PrimaryButton } from '@/components/primary-button';
import { StateMessage } from '@/components/state-message';
import { userMessage } from '@/utils/user-message';

import { RecoveryScreen } from './screen';

/**
 * The Pulse app's screen for a library that failed its check and couldn't be recovered: the
 * library screen (and its import) never mounts while the library is unusable, so restoring a
 * backup has to be offered here. `restore` stages the picked backup and restarts the app to swap
 * it in (the standalone shell passes it: the backup code is a feature, and the restart is only
 * the Pulse app's to make). It resolves only if the restart didn't happen.
 */
export function StandaloneRecovery({ restore }: { restore: (fileUri: string) => Promise<void> }) {
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const restoreFromRecovery = async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
    });
    const asset = picked.canceled ? null : picked.assets?.[0];
    if (!asset) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await restore(asset.uri); // there's no sound library to snapshot first
    } catch (e) {
      setRestoreError(userMessage(e, 'Pick a Pulse library backup and try again.', 'restore'));
    } finally {
      try {
        const copy = new File(asset.uri);
        if (copy.exists) copy.delete(); // the picker's copy in the cache
      } catch {}
      setRestoring(false);
    }
  };

  return (
    <RecoveryScreen>
      <StateMessage
        icon="exclamationmark.triangle.fill"
        tone="accent"
        title="Couldn’t open your drafts"
        message={
          restoreError ??
          'Free up some space, then close Pulse and open it again. Your videos are still on this phone. If you have a library backup, you can restore it.'
        }>
        <PrimaryButton
          label="Restore a library backup"
          busy={restoring}
          disabled={restoring}
          onPress={() => void restoreFromRecovery()}
        />
      </StateMessage>
    </RecoveryScreen>
  );
}

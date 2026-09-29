import { useState } from 'react';
import { Alert } from 'react-native';
import { saveToDocuments } from 'react-native-video-trim';

import { useToast } from '@/features/toast/toast-provider';

export type SaveStatus = 'idle' | 'saving' | 'saved';

/**
 * Saves an exported video to a user-chosen location via the system document picker
 * (RNVT `saveToDocuments`). No photo-library permission needed. A cancelled picker resolves
 * unsuccessfully and quietly returns to idle.
 */
export function useSaveToDocuments() {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const { showToast } = useToast();

  async function save(fileUri: string) {
    if (status !== 'idle') return;
    setStatus('saving');
    try {
      const res = await saveToDocuments(fileUri);
      if (res.success) {
        setStatus('saved');
        // A toast, not an Alert — the button itself already flips to "Saved".
        showToast('Saved to Files');
      } else {
        setStatus('idle');
      }
    } catch (e) {
      setStatus('idle');
      Alert.alert('Couldn’t save the video', e instanceof Error ? e.message : 'Try again.');
    }
  }

  return { status, save };
}

import { usePermissions } from 'expo-media-library';
// The new class API's Asset.create() requires FULL library access (it re-fetches the created
// asset), so it throws under the write-only "Add Photos Only" grant we ask for. The legacy
// save path only needs NSPhotoLibraryAddUsageDescription and works write-only.
import { saveToLibraryAsync } from 'expo-media-library/legacy';
import { useState } from 'react';
import { Alert, Linking } from 'react-native';

import { useToast } from '@/features/toast/toast-provider';

export type SaveStatus = 'idle' | 'saving' | 'saved';

/**
 * Saves an exported video into the device Photos library. Permission is requested
 * just-in-time on the first save (§2.3) — write-only access, so iOS shows the lighter
 * "Add Photos Only" prompt and Android 13+ asks for the granular media permissions.
 */
export function useSaveToPhotos() {
  const [permission, requestPermission] = usePermissions({
    writeOnly: true,
    granularPermissions: ['photo', 'video'],
  });
  const [status, setStatus] = useState<SaveStatus>('idle');
  const { showToast } = useToast();

  async function save(fileUri: string) {
    if (status !== 'idle') return;

    if (!permission?.granted) {
      if (permission && !permission.canAskAgain) {
        Alert.alert(
          'Photos access needed',
          'Allow Pulse to add videos to your photo library in Settings.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => void Linking.openSettings() },
          ],
        );
        return;
      }
      const next = await requestPermission();
      if (!next.granted) return;
    }

    setStatus('saving');
    try {
      await saveToLibraryAsync(fileUri);
      setStatus('saved');
      // A toast, not an Alert — the button itself already flips to "Saved".
      showToast('Saved to Photos');
    } catch (e) {
      setStatus('idle');
      Alert.alert('Couldn’t save the video', e instanceof Error ? e.message : 'Try again.');
    }
  }

  return { status, save };
}

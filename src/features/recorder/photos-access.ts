import { usePermissions } from 'expo-media-library';
import { Alert, Linking, Platform } from 'react-native';

/**
 * Photos access for the "+" imports (videos, images), asked for just in time, on the tap (§2.3):
 * granular (photo+video) like the camera/mic gate. Granting it also lets the picker's passthrough
 * fast path stream originals instead of prompting mid-import. iOS only: Android imports through
 * the system photo picker, which needs no permission, and Play's photo/video policy rejects
 * READ_MEDIA_* for that. With those out of the manifest, even checking the photo/video permission
 * throws on Android 13+, so the hook doesn't check there.
 *
 * Returns `ensurePhotosAccess(what)`: true once access is there (asked for if it can be); false
 * when it's refused, after pointing to Settings when it can't be asked again.
 */
export function usePhotosAccess() {
  const [permission, request] = usePermissions({
    granularPermissions: ['photo', 'video'],
    get: Platform.OS === 'ios',
  });
  return async function ensurePhotosAccess(what: 'videos' | 'images'): Promise<boolean> {
    if (Platform.OS !== 'ios' || permission?.granted) return true;
    if (permission && !permission.canAskAgain) {
      Alert.alert(
        'Photos access needed',
        `Allow Pulse to access your photo library in Settings to import ${what}.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ],
      );
      return false;
    }
    return (await request()).granted;
  };
}

import { requireNativeModule } from "expo";

const AudioFocusModule = requireNativeModule("AudioFocus");

/**
 * Requests Android audio focus with AUDIOFOCUS_GAIN.
 * This causes other apps (Spotify, podcasts, YouTube Music) to pause.
 * No-op on iOS (handled by expo-audio's setAudioModeAsync).
 */
export async function requestAudioFocus(): Promise<void> {
  return AudioFocusModule.requestAudioFocus();
}

/**
 * Abandons Android audio focus so other apps can resume.
 * No-op on iOS.
 */
export async function abandonAudioFocus(): Promise<void> {
  return AudioFocusModule.abandonAudioFocus();
}

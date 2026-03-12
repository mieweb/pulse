import { useCallback } from "react";
import { Platform } from "react-native";
import { setAudioModeAsync } from "expo-audio";
import { requestAudioFocus, abandonAudioFocus } from "@/modules/audio-focus/src/AudioFocusModule";

/**
 * Manages the iOS/Android audio session for video recording.
 *
 * ─── ANDROID ──────────────────────────────────────────────────────────────
 *
 * Uses the local `audio-focus` native module which calls
 * AudioManager.requestAudioFocus(AUDIOFOCUS_GAIN) directly.
 * This is the OS-level signal that causes Spotify / YouTube Music / podcasts
 * to pause immediately.
 *
 * Why not expo-audio's setIsAudioActiveAsync?
 * → It is a NO-OP on Android (only sets an internal flag, never calls
 *   requestAudioFocus). Confirmed from AudioModule.kt lines 183-195.
 *
 * ─── iOS ───────────────────────────────────────────────────────────────────
 *
 * setAudioModeAsync configures the AVAudioSession category (doNotMix + mic).
 * The native AudioFocusModule then calls:
 *   requestAudioFocus  → AVAudioSession.setActive(true)          (stops Spotify)
 *   abandonAudioFocus  → AVAudioSession.setActive(false,          (resumes Spotify)
 *                          options: .notifyOthersOnDeactivation)
 *
 * Without .notifyOthersOnDeactivation, iOS does NOT signal other apps to resume.
 *
 * ─── expo-audio BUG (still in v1.0.13) ────────────────────────────────────
 *
 * https://github.com/expo/expo/issues/34025
 * Passing both `interruptionMode` (iOS) and `interruptionModeAndroid` in the
 * same setAudioModeAsync call crashes Android. We spread only the
 * platform-relevant interruption key using Platform.OS.
 */
export function useAudioSession() {
  /**
   * Claim audio focus so background apps stop playing.
   *
   * Android: calls AudioManager.requestAudioFocus(AUDIOFOCUS_GAIN) directly.
   * iOS:     configures AVAudioSession with DoNotMix and enables the mic.
   */
  const activateRecordingSession = useCallback(async () => {
    try {
      // Configure the audio mode first (sets AVAudioSession category on iOS,
      // sets interruptionMode on Android) before claiming focus.
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        ...(Platform.OS === "ios"
          ? { interruptionMode: "doNotMix" }
          : { interruptionModeAndroid: "doNotMix" }),
        shouldPlayInBackground: false,
      });

      // Claim audio focus on both platforms:
      // Android → AudioManager.requestAudioFocus(AUDIOFOCUS_GAIN_TRANSIENT)
      // iOS     → AVAudioSession.setActive(true)
      // Both signals cause Spotify/podcasts to pause.
      await requestAudioFocus();

      console.log("[AudioSession] Recording session activated — background audio stopped.");
    } catch (error) {
      console.warn("[AudioSession] Failed to activate recording session:", error);
    }
  }, []);

  /**
   * Release audio focus after recording ends or on screen unmount.
   * Allows background apps to resume their playback.
   */
  const deactivateRecordingSession = useCallback(async () => {
    try {
      // Release focus on both platforms:
      // Android → AudioManager.abandonAudioFocus()
      // iOS     → AVAudioSession.setActive(false, options: .notifyOthersOnDeactivation)
      // The notifyOthersOnDeactivation flag is what tells Spotify/podcasts to resume.
      await abandonAudioFocus();

      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: false,
        ...(Platform.OS === "ios"
          ? { interruptionMode: "mixWithOthers" }
          : { interruptionModeAndroid: "duckOthers" }),
        shouldPlayInBackground: false,
      });

      console.log("[AudioSession] Recording session deactivated — background audio restored.");
    } catch (error) {
      console.warn("[AudioSession] Failed to deactivate recording session:", error);
    }
  }, []);

  return { activateRecordingSession, deactivateRecordingSession };
}

import ExpoModulesCore
import AVFoundation

public class AudioFocusModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AudioFocus")

    // Activate the AVAudioSession so other apps (Spotify, podcasts) are interrupted.
    // setAudioModeAsync has already set the category/options via expo-audio;
    // we just flip the session active here.
    AsyncFunction("requestAudioFocus") {
      try AVAudioSession.sharedInstance().setActive(true)
    }

    // Deactivate with .notifyOthersOnDeactivation — the iOS equivalent of
    // abandonAudioFocus on Android. This is the signal that tells Spotify /
    // podcasts / music apps that they can resume playback.
    AsyncFunction("abandonAudioFocus") {
      try AVAudioSession.sharedInstance().setActive(
        false,
        options: .notifyOthersOnDeactivation
      )
    }
  }
}

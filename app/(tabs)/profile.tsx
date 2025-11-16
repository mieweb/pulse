import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import React, { useState } from "react";
import { Button, Platform, Alert, StyleSheet, View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";

// Import the screen recorder module only on iOS
let ScreenRecorder: any = null;
if (Platform.OS === "ios") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ScreenRecorder = require("@/modules/screen-recorder").default;
  } catch (e) {
    console.log("Screen recorder module not available:", e);
  }
}

export default function ProfileScreen() {
  const [lastRecordingPath, setLastRecordingPath] = useState<string | null>(null);
  const [videoSource, setVideoSource] = useState<string | null>(null);
  
  const player = useVideoPlayer(videoSource || undefined, (player) => {
    player.loop = true;
  });

  const handleStartRecording = async () => {
    if (Platform.OS !== "ios" || !ScreenRecorder) {
      Alert.alert("Not Available", "Screen recording is only available on iOS");
      return;
    }

    try {
      await ScreenRecorder.startScreenRecording();
      Alert.alert(
        "Recording Started",
        "Select Pulse Screen Recorder from the list and start recording. Speak to record video - silent periods will be skipped!"
      );
    } catch (error) {
      console.error("Error starting recording:", error);
      Alert.alert("Error", "Failed to start screen recording");
    }
  };

  const handleCheckLastRecording = async () => {
    if (Platform.OS !== "ios" || !ScreenRecorder) {
      Alert.alert("Not Available", "Screen recording is only available on iOS");
      return;
    }

    try {
      const path = await ScreenRecorder.getLastRecordingPath();
      if (path) {
        setLastRecordingPath(path);
        Alert.alert("Recording Found", `Last recording: ${path}`);
      } else {
        Alert.alert("No Recording", "No recordings found yet");
      }
    } catch (error) {
      console.error("Error getting last recording:", error);
      Alert.alert("Error", "Failed to get last recording");
    }
  };

  const handlePlayLastRecording = async () => {
    if (Platform.OS !== "ios" || !ScreenRecorder) {
      Alert.alert("Not Available", "Screen recording is only available on iOS");
      return;
    }

    try {
      const path = await ScreenRecorder.getLastRecordingPath();
      if (path) {
        // Convert file path to file:// URI
        const fileUri = path.startsWith("file://") ? path : `file://${path}`;
        setVideoSource(fileUri);
        setLastRecordingPath(path);
      } else {
        Alert.alert("No Recording", "No recordings found yet. Record something first!");
      }
    } catch (error) {
      console.error("Error playing last recording:", error);
      Alert.alert("Error", "Failed to play last recording");
    }
  };

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Profile</ThemedText>
      <ThemedText>This is your profile page.</ThemedText>

      {Platform.OS === "ios" && ScreenRecorder && (
        <View style={styles.recordingSection}>
          <ThemedText type="subtitle" style={styles.sectionTitle}>
            Screen Recording (PoC)
          </ThemedText>
          <ThemedText style={styles.description}>
            Audio-gated screen recording: Only records when you speak!
          </ThemedText>

          <Button
            title="📹 Start Screen Recording"
            onPress={handleStartRecording}
            color="#007AFF"
          />

          <View style={styles.buttonSpacing} />

          <Button
            title="📂 Check Last Recording"
            onPress={handleCheckLastRecording}
            color="#34C759"
          />

          <View style={styles.buttonSpacing} />

          <Button
            title="▶️ Play Last Recording"
            onPress={handlePlayLastRecording}
            color="#5856D6"
          />

          {lastRecordingPath && (
            <ThemedText style={styles.pathText}>
              Last: {lastRecordingPath.split("/").pop()}
            </ThemedText>
          )}

          {videoSource && (
            <View style={styles.videoContainer}>
              <VideoView
                style={styles.video}
                player={player}
                allowsFullscreen
                allowsPictureInPicture
              />
            </View>
          )}
        </View>
      )}

      {Platform.OS !== "ios" && (
        <ThemedText style={styles.notAvailable}>
          Screen recording is only available on iOS
        </ThemedText>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  recordingSection: {
    marginTop: 30,
    width: "100%",
    maxWidth: 400,
  },
  sectionTitle: {
    marginBottom: 10,
    textAlign: "center",
  },
  description: {
    marginBottom: 20,
    textAlign: "center",
    fontSize: 14,
    opacity: 0.8,
  },
  buttonSpacing: {
    height: 10,
  },
  pathText: {
    marginTop: 15,
    fontSize: 12,
    opacity: 0.6,
    textAlign: "center",
  },
  notAvailable: {
    marginTop: 20,
    opacity: 0.6,
  },
  videoContainer: {
    marginTop: 20,
    width: "100%",
    aspectRatio: 9 / 16,
    backgroundColor: "#000",
    borderRadius: 10,
    overflow: "hidden",
  },
  video: {
    width: "100%",
    height: "100%",
  },
});

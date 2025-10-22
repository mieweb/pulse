import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { useVideoPlayer, VideoView } from "expo-video";
import * as Sharing from "expo-sharing";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import * as FileSystem from "expo-file-system";

export default function MergedVideoScreen() {
  const { videoUri, draftId } = useLocalSearchParams<{
    videoUri: string;
    draftId: string;
  }>();
  const insets = useSafeAreaInsets();
  const [isLoading, setIsLoading] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const player = useVideoPlayer(videoUri, (player) => {
    if (player) {
      player.loop = false;
      player.muted = false;
      player.currentTime = 0;
    }
  });

  useEffect(() => {
    const setupPlayer = async () => {
      if (videoUri) {
        try {
          setIsLoading(true);
          await player.replaceAsync(videoUri);
          // Don't auto-play in thumbnail mode
          player.pause();
        } catch (error) {
          console.error("Failed to load merged video:", error);
          Alert.alert("Error", "Failed to load merged video");
        } finally {
          setIsLoading(false);
        }
      }
    };

    setupPlayer();
  }, [videoUri, player]);

  // Pause video when not in fullscreen
  useEffect(() => {
    if (!isFullscreen) {
      player.pause();
    }
  }, [isFullscreen, player]);

  // Cleanup player on component unmount
  useEffect(() => {
    return () => {
      try {
        if (player && typeof player.pause === "function") {
          player.pause();
        }
      } catch (error) {
        // Silently ignore - player is already destroyed
      }
    };
  }, [player]);

  const handleBack = useCallback(() => {
    router.back();
  }, []);

  const toggleFullscreen = () => {
    if (!isFullscreen) {
      // Enter fullscreen and start playback
      setIsFullscreen(true);
      player.play();
    } else {
      // Exit fullscreen and pause
      setIsFullscreen(false);
      player.pause();
    }
  };

  const shareVideo = async () => {
    if (!videoUri) return;

    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert(
          "Sharing not available",
          "Sharing is not available on this device."
        );
        return;
      }

      await Sharing.shareAsync(videoUri, {
        mimeType: "video/mp4",
        dialogTitle: "Share your merged video",
      });
    } catch (error) {
      console.error("❌ Failed to share video:", error);
      Alert.alert("Share Failed", "Could not share the video.");
    }
  };


  if (isLoading) {
    return (
      <ThemedView style={styles.container}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
          <TouchableOpacity style={styles.backButton} onPress={handleBack}>
            <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
          </TouchableOpacity>
          <ThemedText style={styles.headerTitle}>Video Preview</ThemedText>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#ffffff" />
          <ThemedText style={styles.loadingText}>
            Loading merged video...
          </ThemedText>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <TouchableOpacity style={styles.backButton} onPress={handleBack}>
          <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
        </TouchableOpacity>
        <ThemedText style={styles.headerTitle}>Video Preview</ThemedText>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.content}>
        {/* Video Thumbnail */}
        <View style={styles.videoSection}>
          <TouchableOpacity
            style={styles.videoThumbnail}
            onPress={toggleFullscreen}
          >
            <VideoView
              player={player}
              style={styles.thumbnailVideo}
              allowsFullscreen={false}
              allowsPictureInPicture={false}
              showsTimecodes={false}
              requiresLinearPlayback={false}
              contentFit="cover"
              nativeControls={false}
            />
            <View style={styles.playOverlay}>
              <MaterialIcons name="play-arrow" size={40} color="#ffffff" />
            </View>
          </TouchableOpacity>
        </View>

        {/* Action Buttons */}
        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={styles.saveButton}
            onPress={shareVideo}
            activeOpacity={0.8}
          >
            <MaterialIcons name="download" size={20} color="#ffffff" />
            <ThemedText style={styles.buttonText}>Save to Device</ThemedText>
          </TouchableOpacity>
        </View>
      </View>

      {/* Fullscreen Video Overlay */}
      {isFullscreen && (
        <View style={styles.fullscreenOverlay}>
          <View style={styles.fullscreenVideo}>
            <VideoView
              player={player}
              style={styles.fullscreenVideoPlayer}
              allowsFullscreen={true}
              allowsPictureInPicture={false}
              showsTimecodes={false}
              requiresLinearPlayback={true}
              contentFit="cover"
              nativeControls={true}
            />
          </View>

          <TouchableOpacity
            style={styles.fullscreenCloseButton}
            onPress={toggleFullscreen}
          >
            <MaterialIcons name="close" size={24} color="#ffffff" />
          </TouchableOpacity>
        </View>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#333",
  },
  backButton: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#ffffff",
    flex: 1,
    textAlign: "center",
  },
  headerSpacer: {
    width: 40,
  },
  content: {
    flex: 1,
    paddingBottom: 20,
  },
  videoSection: {
    padding: 16,
  },
  videoThumbnail: {
    width: "100%",
    height: 200,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#333",
    position: "relative",
  },
  thumbnailVideo: {
    width: "100%",
    height: "100%",
  },
  staticThumbnail: {
    width: "100%",
    height: "100%",
    backgroundColor: "#333",
    justifyContent: "center",
    alignItems: "center",
  },
  playOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    justifyContent: "center",
    alignItems: "center",
  },
  inputSection: {
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  inputLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: "#ffffff",
    marginBottom: 8,
  },
  titleInput: {
    backgroundColor: "#1a1a1a",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: "#ffffff",
    borderWidth: 1,
    borderColor: "#333",
    minHeight: 50,
  },
  descriptionInput: {
    backgroundColor: "#1a1a1a",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: "#ffffff",
    borderWidth: 1,
    borderColor: "#333",
    minHeight: 100,
    textAlignVertical: "top",
  },
  actionButtons: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 12,
  },
  saveButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 50,
    backgroundColor: "#333",
    borderRadius: 8,
    gap: 8,
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "#ffffff",
    marginTop: 20,
    fontSize: 16,
    fontFamily: "Roboto-Regular",
  },
  fullscreenOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
    zIndex: 1000,
  },
  fullscreenVideo: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  fullscreenVideoPlayer: {
    width: "100%",
    height: "100%",
  },
  fullscreenCloseButton: {
    position: "absolute",
    top: 50,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1001,
  },
});

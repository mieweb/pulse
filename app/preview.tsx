import { ThemedText } from "@/components/ThemedText";
import VideoConcatModule from "@/modules/video-concat";
import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { useEventListener } from "expo";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  StyleSheet,
  TouchableOpacity,
  View,
  Alert,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function PreviewScreen() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>();
  const insets = useSafeAreaInsets();

  const [videoUris, setVideoUris] = useState<string[]>([]);
  const [currentVideoIndex, setCurrentVideoIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [useSecondPlayer, setUseSecondPlayer] = useState(false);
  const [isConcatenating, setIsConcatenating] = useState(false);
  const [concatProgress, setConcatProgress] = useState(0);
  const [concatPhase, setConcatPhase] = useState<string>("");
  const [draft, setDraft] = useState<any>(null);
  // Refs to store timeout IDs for proper cleanup
  const appStateResumeTimeoutRef = useRef<number | null>(null);
  const appStateResetTimeoutRef = useRef<number | null>(null);

  const player1 = useVideoPlayer(null, (player) => {
    if (player) {
      player.loop = false;
      player.muted = false;
      // Ensure player starts from beginning
      player.currentTime = 0;
    }
  });

  const player2 = useVideoPlayer(null, (player) => {
    if (player) {
      player.loop = false;
      player.muted = false;
      // Ensure player starts from beginning
      player.currentTime = 0;
    }
  });

  const _currentPlayer = useSecondPlayer ? player2 : player1; // eslint-disable-line @typescript-eslint/no-unused-vars
  const nextPlayer = useSecondPlayer ? player1 : player2;

  useEventListener(player1, "playToEnd", () => {
    // Handle segment cycling
    if (videoUris.length > 1) {
      // Switch to player2 and advance to next video
      setUseSecondPlayer(true);
      advanceToNextVideo();
      player2.play();
    }
  });

  useEventListener(player2, "playToEnd", () => {
    // Handle segment cycling
    if (videoUris.length > 1) {
      // Switch to player1 and advance to next video
      setUseSecondPlayer(false);
      advanceToNextVideo();
      player1.play();
    }
  });

  // Player state monitoring removed for cleaner experience

  const advanceToNextVideo = () => {
    setCurrentVideoIndex((prev) => {
      const nextIndex = prev < videoUris.length - 1 ? prev + 1 : 0;
      return nextIndex;
    });
  };

  // Function to reset both players to clean state
  const resetPlayers = async () => {
    try {
      if (player1 && typeof player1.pause === "function") {
        player1.pause();
        player1.currentTime = 0;
      }
      if (player2 && typeof player2.pause === "function") {
        player2.pause();
        player2.currentTime = 0;
      }
      // Small delay to ensure players are reset
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    } catch (error) {
      console.error("Error resetting players:", error);
    }
  };

  // Simple app state handling
  const handleAppStateChange = useCallback(
    (nextAppState: AppStateStatus) => {
      if (nextAppState === "active") {
        // Simple resume - just play the current active player
        const currentPlayer = useSecondPlayer ? player2 : player1;
        if (currentPlayer && !currentPlayer.playing) {
          currentPlayer.play();
        }
      }
    },
    [player1, player2, useSecondPlayer]
  );

  useEffect(() => {
    const loadDraft = async () => {
      if (!draftId) {
        router.back();
        return;
      }

      try {
        const draft = await DraftStorage.getDraftById(draftId);
        if (draft && draft.segments.length > 0) {
          setDraft(draft);
          // Convert relative paths to absolute paths for video playback
          const uris = draft.segments.map((segment) =>
            fileStore.toAbsolutePath(segment.uri)
          );
          setVideoUris(uris);
        } else {
          router.back();
        }
      } catch (error) {
        console.error("Draft load failed:", error);
        router.back();
      } finally {
        setIsLoading(false);
      }
    };

    loadDraft();
  }, [draftId]);

  // Set up AppState listener to handle app foreground/background
  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange
    );
    return () => subscription?.remove();
  }, [handleAppStateChange]);

  // Cleanup timeouts and pause players on component unmount
  useEffect(() => {
    return () => {
      // Clear all timeouts when component unmounts
      if (appStateResumeTimeoutRef.current) {
        clearTimeout(appStateResumeTimeoutRef.current);
      }
      if (appStateResetTimeoutRef.current) {
        clearTimeout(appStateResetTimeoutRef.current);
      }

      // Safely pause all players when component unmounts
      try {
        if (player1 && typeof player1.pause === "function") {
          player1.pause();
        }
      } catch (error) {
        // Silently ignore - player is already destroyed
      }

      try {
        if (player2 && typeof player2.pause === "function") {
          player2.pause();
        }
      } catch (error) {
        // Silently ignore - player is already destroyed
      }
    };
  }, [player1, player2]);

  // Pause players when screen loses focus
  useFocusEffect(
    useCallback(() => {
      // Screen is focused - resume playing if needed
      const currentPlayer = useSecondPlayer ? player2 : player1;
      if (currentPlayer && !currentPlayer.playing && videoUris.length > 0) {
        currentPlayer.play();
      }

      return () => {
        // Screen is losing focus - safely pause all players
        try {
          if (player1 && typeof player1.pause === "function") {
            player1.pause();
          }
        } catch (error) {
          // Silently ignore - player is already destroyed
        }

        try {
          if (player2 && typeof player2.pause === "function") {
            player2.pause();
          }
        } catch (error) {
          // Silently ignore - player is already destroyed
        }
      };
    }, [player1, player2, useSecondPlayer, videoUris.length])
  );

  useEffect(() => {
    const setupPlayers = async () => {
      if (videoUris.length > 0 && !isLoading) {
        try {
          // Reset players before setting up new videos
          await resetPlayers();

          // Load first video into player1 and start playing
          await player1.replaceAsync(videoUris[0]);
          player1.play();

          // Reset video index to start from beginning
          setCurrentVideoIndex(0);

          // If there are multiple videos, preload the second one into player2
          if (videoUris.length > 1) {
            await player2.replaceAsync(videoUris[1]);
          }
        } catch (error) {
          console.error("Player setup failed:", error);
        }
      }
    };

    setupPlayers();
  }, [videoUris, isLoading, player1, player2]);

  useEffect(() => {
    const preloadNext = async () => {
      if (videoUris.length <= 1) return;

      try {
        // Calculate the next video index
        const nextIndex =
          currentVideoIndex < videoUris.length - 1 ? currentVideoIndex + 1 : 0;
        const nextVideoUri = videoUris[nextIndex];

        // Load the next video into the inactive player
        const inactivePlayer = useSecondPlayer ? player1 : player2;
        await inactivePlayer.replaceAsync(nextVideoUri);
      } catch (error) {
        console.error("Preload failed:", error);
      }
    };

    if (videoUris.length > 0) {
      preloadNext();
    }
  }, [currentVideoIndex, videoUris, useSecondPlayer, player1, player2]);

  const handleClose = useCallback(async () => {
    // Dismiss the screen
    router.dismiss();
  }, []);

  if (isLoading || videoUris.length === 0) {
    return (
      <View style={styles.container}>
        <TouchableOpacity
          style={[styles.closeButton, { top: insets.top + 20 }]}
          onPress={handleClose}
        >
          <ThemedText style={styles.closeText}>×</ThemedText>
        </TouchableOpacity>
      </View>
    );
  }

  // Add concatenation handler
  const handleConcatenate = async () => {
    if (!draftId) return;

    try {
      setIsConcatenating(true);

      const draft = await DraftStorage.getDraftById(draftId);
      if (!draft) {
        console.error("❌ No draft found");
        return;
      }

      // Set up progress listener
      const progressListener = VideoConcatModule.addListener(
        "onProgress",
        (event: any) => {
          console.log("Progress event received:", event);
          const { progress, currentSegment, phase } = event;
          console.log("Progress values:", { progress, currentSegment, phase });
          setConcatProgress(progress);
          setConcatPhase(phase);
        }
      );

      // Convert relative paths to absolute paths for native module
      const segmentsWithAbsolutePaths = draft.segments.map((segment) => ({
        ...segment,
        uri: fileStore.toAbsolutePath(segment.uri),
      }));

      // Start concatenation
      const outputUri = await VideoConcatModule.export(
        segmentsWithAbsolutePaths
      );

      // Remove progress listener
      progressListener?.remove();

      // Pause all players before navigating
      try {
        if (player1 && typeof player1.pause === "function") {
          player1.pause();
        }
      } catch (error) {
        // Silently ignore - player is already destroyed
      }

      try {
        if (player2 && typeof player2.pause === "function") {
          player2.pause();
        }
      } catch (error) {
        // Silently ignore - player is already destroyed
      }

      // Navigate to merged video screen
      router.push({
        pathname: "/merged-video",
        params: { videoUri: outputUri },
      });
    } catch (error) {
      console.error("❌ Concatenation failed:", error);
      Alert.alert("Merge Failed", "Could not merge videos. Please try again.");
    } finally {
      setIsConcatenating(false);
    }
  };

  return (
    <View style={styles.container}>
      <VideoView
        player={player1}
        style={[styles.video, useSecondPlayer && styles.hiddenVideo]}
        allowsFullscreen={false}
        allowsPictureInPicture={false}
        showsTimecodes={false}
        requiresLinearPlayback={true}
        contentFit="cover"
        nativeControls={false}
      />

      <VideoView
        player={player2}
        style={[styles.video, !useSecondPlayer && styles.hiddenVideo]}
        allowsFullscreen={false}
        allowsPictureInPicture={false}
        showsTimecodes={false}
        requiresLinearPlayback={true}
        contentFit="cover"
        nativeControls={false}
      />

      <TouchableOpacity
        style={[styles.closeButton, { top: insets.top + 20 }]}
        onPress={handleClose}
      >
        <ThemedText style={styles.closeText}>{"×"}</ThemedText>
      </TouchableOpacity>

      {/* Add merge button - only show if multiple segments */}
      {videoUris.length > 1 && (
        <TouchableOpacity
          style={[styles.concatenateButton, { bottom: insets.bottom + 20 }]}
          onPress={handleConcatenate}
          disabled={isConcatenating}
          activeOpacity={0.8}
        >
          <View style={styles.buttonContent}>
            <MaterialIcons
              name={isConcatenating ? "hourglass-empty" : "merge-type"}
              size={20}
              color="#ffffff"
              style={styles.buttonIcon}
            />
            <ThemedText style={styles.buttonText}>
              {isConcatenating ? "Processing..." : "Merge Videos"}
            </ThemedText>
          </View>
        </TouchableOpacity>
      )}

      {/* Loading overlay */}
      {isConcatenating && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#ffffff" />
          <ThemedText style={styles.loadingText}>
            {concatPhase === "processing"
              ? `Processing segment ${
                  Math.round(concatProgress * draft?.segments.length || 0) + 1
                }...`
              : concatPhase === "finalizing"
              ? "Finalizing video..."
              : "Merging videos..."}
          </ThemedText>
          <ThemedText style={styles.progressText}>
            {Math.round(concatProgress * 100)}%
          </ThemedText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  video: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
  },
  hiddenVideo: {
    opacity: 0,
    zIndex: 0,
  },
  closeButton: {
    position: "absolute",
    left: 20,
    width: 40,
    height: 40,
    borderRadius: 25,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  closeText: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "600",
    fontFamily: "Roboto-Bold",
    textAlign: "center",
    textAlignVertical: "center",
    includeFontPadding: false,
  },
  concatenateButton: {
    position: "absolute",
    left: 20,
    right: 20,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#ff0000",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
    shadowColor: "#ff0000",
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  buttonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonIcon: {
    marginRight: 8,
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "700",
    fontFamily: "Roboto-Bold",
    letterSpacing: 0.5,
    textShadowColor: "rgba(0, 0, 0, 0.3)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 20,
  },
  loadingText: {
    color: "#ffffff",
    marginTop: 20,
    fontSize: 16,
  },
  progressText: {
    color: "#ffffff",
    marginTop: 10,
    fontSize: 24,
    fontWeight: "bold",
  },
});

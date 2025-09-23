import { ThemedText } from "@/components/ThemedText";
import VideoConcatModule from "@/modules/video-concat";
import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { useEventListener } from "expo";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import * as Sharing from "expo-sharing";
import * as MediaLibrary from "expo-media-library";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function PreviewScreen() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>();
  const insets = useSafeAreaInsets();

  const [videoUris, setVideoUris] = useState<string[]>([]);
  const [currentVideoIndex, setCurrentVideoIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [useSecondPlayer, setUseSecondPlayer] = useState(false);
  const [isConcatenating, setIsConcatenating] = useState(false);
  const [concatenatedVideoUri, setConcatenatedVideoUri] = useState<
    string | null
  >(null);
  const [concatProgress, setConcatProgress] = useState(0);
  const [concatPhase, setConcatPhase] = useState<string>("");
  const [draft, setDraft] = useState<any>(null);
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const [isSavingSegments, setIsSavingSegments] = useState(false);
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
    // Only handle segment cycling if we're not in merged video mode
    if (videoUris.length > 1 && !concatenatedVideoUri) {
      // Switch to player2 and advance to next video
      setUseSecondPlayer(true);
      advanceToNextVideo();
      player2.play();
    }
  });

  useEventListener(player2, "playToEnd", () => {
    // Only handle segment cycling if we're not in merged video mode
    if (videoUris.length > 1 && !concatenatedVideoUri) {
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
      player1.pause();
      player2.pause();
      player1.currentTime = 0;
      player2.currentTime = 0;
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
      if (nextAppState === "active" && !concatenatedVideoUri) {
        // Simple resume - just play the current active player
        const currentPlayer = useSecondPlayer ? player2 : player1;
        if (currentPlayer && !currentPlayer.playing) {
          currentPlayer.play();
        }
      }
    },
    [player1, player2, useSecondPlayer, concatenatedVideoUri]
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

  // Cleanup timeouts on component unmount
  useEffect(() => {
    return () => {
      // Clear all timeouts when component unmounts
      if (appStateResumeTimeoutRef.current) {
        clearTimeout(appStateResumeTimeoutRef.current);
      }
      if (appStateResetTimeoutRef.current) {
        clearTimeout(appStateResetTimeoutRef.current);
      }
    };
  }, []);

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

    if (videoUris.length > 0 && !concatenatedVideoUri) {
      preloadNext();
    }
  }, [
    currentVideoIndex,
    videoUris,
    useSecondPlayer,
    concatenatedVideoUri,
    player1,
    player2,
  ]);

  const handleClose = useCallback(() => {
    router.push("/preview");
  }, []);

  const shareVideo = async (videoUri: string) => {
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

  const saveSegmentsToCameraRoll = async () => {
    if (!draft || !draft.segments || draft.segments.length === 0) {
      Alert.alert("No Segments", "No video segments found to save.");
      return;
    }

    try {
      setIsSavingSegments(true);

      // Convert relative paths to absolute paths for saving
      const segmentsWithAbsolutePaths = draft.segments.map((segment: any) =>
        fileStore.toAbsolutePath(segment.uri)
      );

      let savedCount = 0;
      const totalSegments = segmentsWithAbsolutePaths.length;

      // Save each segment to camera roll
      for (let i = 0; i < segmentsWithAbsolutePaths.length; i++) {
        try {
          await MediaLibrary.saveToLibraryAsync(segmentsWithAbsolutePaths[i]);
          savedCount++;
        } catch (segmentError) {
          console.error(`❌ Failed to save segment ${i + 1}:`, segmentError);
          // Continue with other segments even if one fails
        }
      }

      if (savedCount === totalSegments) {
        Alert.alert(
          "Success",
          `All ${savedCount} video segments have been saved to your camera roll.`
        );
      } else if (savedCount > 0) {
        Alert.alert(
          "Partial Success",
          `${savedCount} out of ${totalSegments} video segments were saved to your camera roll.`
        );
      } else {
        Alert.alert(
          "Save Failed",
          "Could not save any video segments to your camera roll."
        );
      }
    } catch (error) {
      console.error("❌ Failed to save segments:", error);
      Alert.alert(
        "Save Failed",
        "An error occurred while saving the video segments."
      );
    } finally {
      setIsSavingSegments(false);
    }
  };

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
        (event) => {
          const { progress, currentSegment, phase } = event.progress;
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

      setConcatenatedVideoUri(outputUri);

      // Reset useSecondPlayer to false so player1 (with concatenated video) is visible
      setUseSecondPlayer(false);

      // Load concatenated video
      setIsLoadingVideo(true);

      try {
        // Stop and reset both players before loading concatenated video
        player1.pause();
        player2.pause();

        // Reset player positions to ensure clean state
        player1.currentTime = 0;
        player2.currentTime = 0;

        // Clear any existing video sources to prevent state conflicts
        await player1.replaceAsync(null);
        await player2.replaceAsync(null);

        // Small delay to ensure players are fully reset
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });

        // Load the concatenated video into player1
        await player1.replaceAsync(outputUri);

        // Wait a moment for the video to load its metadata and orientation
        await new Promise<void>((resolve) => {
          const timeoutId = setTimeout(resolve, 1000);
          // Note: This timeout is intentionally not stored in a ref since it's awaited
          // and will complete before the function returns
        });

        setIsLoadingVideo(false);
        player1.play();
      } catch (videoLoadError) {
        console.error("❌ Failed to load concatenated video:", videoLoadError);
        // Reset the concatenated video state if loading fails
        setConcatenatedVideoUri(null);
        setIsLoadingVideo(false);
        throw videoLoadError; // Re-throw to be caught by outer catch
      }
    } catch (error) {
      console.error("❌ Concatenation failed:", error);
      // Reset states on any error
      setConcatenatedVideoUri(null);
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
        nativeControls={concatenatedVideoUri ? true : false}
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
        <ThemedText style={styles.closeText}>×</ThemedText>
      </TouchableOpacity>

      {/* Add buttons - only show if not concatenated */}
      {!concatenatedVideoUri && (
        <View style={[styles.buttonContainer, { bottom: insets.bottom + 20 }]}>
          {/* Only show merge button if there are multiple segments */}
          {videoUris.length > 1 && (
            <TouchableOpacity
              style={[styles.concatenateButton, { flex: 1, marginRight: 10 }]}
              onPress={handleConcatenate}
              disabled={isConcatenating}
            >
              <ThemedText style={styles.buttonText}>
                {isConcatenating ? "Processing..." : "Merge Videos"}
              </ThemedText>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[
              styles.saveSegmentsButton,
              videoUris.length === 1
                ? styles.fullWidthButton
                : { flex: 1, marginLeft: videoUris.length > 1 ? 10 : 0 },
            ]}
            onPress={saveSegmentsToCameraRoll}
            disabled={isSavingSegments}
          >
            <ThemedText style={styles.buttonText}>
              {isSavingSegments
                ? "Saving..."
                : videoUris.length === 1
                ? "Save Video"
                : "Save Segments"}
            </ThemedText>
          </TouchableOpacity>
        </View>
      )}

      {/* Add share button - only show if concatenated */}
      {concatenatedVideoUri && (
        <TouchableOpacity
          style={[styles.shareButton, { bottom: insets.bottom + 20 }]}
          onPress={() => shareVideo(concatenatedVideoUri)}
        >
          <ThemedText style={styles.buttonText}>Share Video</ThemedText>
        </TouchableOpacity>
      )}

      {/* Loading overlay */}
      {(isConcatenating || isLoadingVideo || isSavingSegments) && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#ffffff" />
          <ThemedText style={styles.loadingText}>
            {isSavingSegments
              ? "Saving segments to camera roll..."
              : isLoadingVideo
              ? "Loading merged video..."
              : concatPhase === "processing"
              ? `Processing segment ${
                  Math.round(concatProgress * draft?.segments.length || 0) + 1
                }...`
              : concatPhase === "finalizing"
              ? "Finalizing video..."
              : "Merging videos..."}
          </ThemedText>
          {!isLoadingVideo && !isSavingSegments && (
            <ThemedText style={styles.progressText}>
              {Math.round(concatProgress * 100)}%
            </ThemedText>
          )}
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
  buttonContainer: {
    position: "absolute",
    left: 20,
    right: 20,
    flexDirection: "row",
    zIndex: 10,
  },
  concatenateButton: {
    height: 50,
    borderRadius: 25,
    backgroundColor: "#ff0000",
    justifyContent: "center",
    alignItems: "center",
  },
  saveSegmentsButton: {
    height: 50,
    borderRadius: 25,
    backgroundColor: "#34C759",
    justifyContent: "center",
    alignItems: "center",
  },
  fullWidthButton: {
    flex: 1,
  },
  shareButton: {
    position: "absolute",
    left: 20,
    right: 20,
    height: 50,
    borderRadius: 25,
    backgroundColor: "#007AFF",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
    fontFamily: "Roboto-Bold",
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

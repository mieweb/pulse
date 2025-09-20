import { ThemedText } from "@/components/ThemedText";
import VideoConcatModule from "@/modules/video-concat";
import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { useEventListener } from "expo";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import * as Sharing from "expo-sharing";
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
  const [isResumingPlayback, setIsResumingPlayback] = useState(false);

  // Refs to store timeout IDs for proper cleanup
  const player1ResumeTimeoutRef = useRef<number | null>(null);
  const player2ResumeTimeoutRef = useRef<number | null>(null);
  const appStateResumeTimeoutRef = useRef<number | null>(null);
  const appStateResetTimeoutRef = useRef<number | null>(null);

  const player1 = useVideoPlayer(null, (player) => {
    if (player) {
      player.loop = false;
      player.muted = false;
    }
  });

  const player2 = useVideoPlayer(null, (player) => {
    if (player) {
      player.loop = false;
      player.muted = false;
    }
  });

  const _currentPlayer = useSecondPlayer ? player2 : player1; // eslint-disable-line @typescript-eslint/no-unused-vars
  const nextPlayer = useSecondPlayer ? player1 : player2;

  useEventListener(player1, "playToEnd", () => {
    // Only handle segment cycling if we're not in merged video mode
    if (videoUris.length > 1 && !concatenatedVideoUri) {
      setUseSecondPlayer(true);
      player2.play();
      advanceToNextVideo();
    }
  });

  useEventListener(player2, "playToEnd", () => {
    // Only handle segment cycling if we're not in merged video mode
    if (videoUris.length > 1 && !concatenatedVideoUri) {
      setUseSecondPlayer(false);
      player1.play();
      advanceToNextVideo();
    }
  });

  // Monitor video player state to ensure continuous playback (only for segment cycling mode)
  useEventListener(player1, "playingChange", (event) => {
    if (
      !event.isPlaying &&
      !isResumingPlayback &&
      !isLoading &&
      !concatenatedVideoUri &&
      videoUris.length > 0
    ) {
      // Clear any existing timeout
      if (player1ResumeTimeoutRef.current) {
        clearTimeout(player1ResumeTimeoutRef.current);
      }

      // If video stopped playing unexpectedly, try to resume
      player1ResumeTimeoutRef.current = setTimeout(() => {
        if (player1 && !player1.playing) {
          player1.play();
        }
        player1ResumeTimeoutRef.current = null;
      }, 50);
    }
  });

  useEventListener(player2, "playingChange", (event) => {
    if (
      !event.isPlaying &&
      !isResumingPlayback &&
      !isLoading &&
      !concatenatedVideoUri &&
      videoUris.length > 1
    ) {
      // Clear any existing timeout
      if (player2ResumeTimeoutRef.current) {
        clearTimeout(player2ResumeTimeoutRef.current);
      }

      // If video stopped playing unexpectedly, try to resume
      player2ResumeTimeoutRef.current = setTimeout(() => {
        if (player2 && !player2.playing) {
          player2.play();
        }
        player2ResumeTimeoutRef.current = null;
      }, 50);
    }
  });

  const advanceToNextVideo = () => {
    setCurrentVideoIndex((prev) => {
      const nextIndex = prev < videoUris.length - 1 ? prev + 1 : 0;
      return nextIndex;
    });
  };

  // Handle app state changes to resume video playback (only for segment cycling mode)
  const handleAppStateChange = useCallback(
    (nextAppState: AppStateStatus) => {
      // Only handle app state changes for segment cycling mode, not merged videos
      if (
        nextAppState === "active" &&
        !isResumingPlayback &&
        !concatenatedVideoUri
      ) {
        setIsResumingPlayback(true);

        // Clear any existing timeouts
        if (appStateResumeTimeoutRef.current) {
          clearTimeout(appStateResumeTimeoutRef.current);
        }
        if (appStateResetTimeoutRef.current) {
          clearTimeout(appStateResetTimeoutRef.current);
        }

        // Add a small delay to ensure the app is fully active
        appStateResumeTimeoutRef.current = setTimeout(() => {
          try {
            // Resume the current active player for segment cycling mode
            const currentPlayer = useSecondPlayer ? player2 : player1;
            if (currentPlayer && !currentPlayer.playing) {
              currentPlayer.play();
            }
          } catch (error) {
            console.error("Error resuming video playback:", error);
          } finally {
            // Reset the flag after a delay to allow for future resumptions
            appStateResetTimeoutRef.current = setTimeout(() => {
              setIsResumingPlayback(false);
              appStateResetTimeoutRef.current = null;
            }, 500);
          }
          appStateResumeTimeoutRef.current = null;
        }, 50);
      }
    },
    [
      player1,
      player2,
      useSecondPlayer,
      concatenatedVideoUri,
      isResumingPlayback,
    ]
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
      if (player1ResumeTimeoutRef.current) {
        clearTimeout(player1ResumeTimeoutRef.current);
      }
      if (player2ResumeTimeoutRef.current) {
        clearTimeout(player2ResumeTimeoutRef.current);
      }
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
          await player1.replaceAsync(videoUris[0]);
          player1.play();

          if (videoUris.length > 1) {
            const nextIndex = videoUris.length > 1 ? 1 : 0;
            await player2.replaceAsync(videoUris[nextIndex]);
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
        const nextIndex =
          currentVideoIndex < videoUris.length - 1 ? currentVideoIndex + 1 : 0;
        const nextVideoUri = videoUris[nextIndex];

        await nextPlayer.replaceAsync(nextVideoUri);
      } catch (error) {
        console.error("Preload failed:", error);
      }
    };

    if (videoUris.length > 0) {
      preloadNext();
    }
  }, [currentVideoIndex, videoUris, nextPlayer]);

  const handleClose = useCallback(() => {
    router.back();
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
      console.log("🎬 Starting video concatenation...");
      setIsConcatenating(true);

      const draft = await DraftStorage.getDraftById(draftId);
      if (!draft) {
        console.error("❌ No draft found");
        return;
      }

      console.log("📝 Draft loaded:", {
        id: draft.id,
        segments: draft.segments.length,
        totalDuration: draft.totalDuration,
      });

      // Set up progress listener
      const progressListener = VideoConcatModule.addListener(
        "onProgress",
        (event) => {
          const { progress, currentSegment, phase } = event.progress;
          console.log(
            `📊 Progress: ${Math.round(progress * 100)}% - Segment ${
              currentSegment + 1
            } - ${phase}`
          );
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
      console.log("🚀 Calling native export function...");
      const outputUri = await VideoConcatModule.export(
        segmentsWithAbsolutePaths
      );
      console.log("✅ Concatenation completed:", outputUri);

      // Remove progress listener
      progressListener?.remove();

      setConcatenatedVideoUri(outputUri);

      // Reset useSecondPlayer to false so player1 (with concatenated video) is visible
      setUseSecondPlayer(false);

      // Load concatenated video
      console.log("📺 Loading concatenated video into player...");
      setIsLoadingVideo(true);

      try {
        await player1.replaceAsync(outputUri);

        // Wait a moment for the video to load its metadata and orientation
        await new Promise<void>((resolve) => {
          const timeoutId = setTimeout(resolve, 1000);
          // Note: This timeout is intentionally not stored in a ref since it's awaited
          // and will complete before the function returns
        });

        setIsLoadingVideo(false);
        player1.play();
        console.log("▶️ Video playback started");
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

      {/* Add concatenate button - only show if not concatenated */}
      {!concatenatedVideoUri && (
        <TouchableOpacity
          style={[styles.concatenateButton, { bottom: insets.bottom + 20 }]}
          onPress={handleConcatenate}
          disabled={isConcatenating}
        >
          <ThemedText style={styles.buttonText}>
            {isConcatenating ? "Processing..." : "Merge Videos"}
          </ThemedText>
        </TouchableOpacity>
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
      {(isConcatenating || isLoadingVideo) && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#ffffff" />
          <ThemedText style={styles.loadingText}>
            {isLoadingVideo
              ? "Loading merged video..."
              : concatPhase === "processing"
              ? `Processing segment ${
                  Math.round(concatProgress * draft?.segments.length || 0) + 1
                }...`
              : concatPhase === "finalizing"
              ? "Finalizing video..."
              : "Merging videos..."}
          </ThemedText>
          {!isLoadingVideo && (
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
  concatenateButton: {
    position: "absolute",
    left: 20,
    right: 20,
    height: 50,
    borderRadius: 25,
    backgroundColor: "#ff0000",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
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

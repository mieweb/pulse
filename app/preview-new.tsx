import { ThemedText } from "@/components/ThemedText";
import VideoConcatModule from "@/modules/video-concat";
import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ReportIssueButton from "@/components/ReportIssueButton";

export default function PreviewNewScreen() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>();
  const insets = useSafeAreaInsets();

  const [draft, setDraft] = useState<any>(null);
  const [isConcatenating, setIsConcatenating] = useState(false);
  const [concatProgress, setConcatProgress] = useState(0);
  const [concatPhase, setConcatPhase] = useState<string>("");
  const [mergedVideoUri, setMergedVideoUri] = useState<string | null>(null);
  const [hasStartedMerge, setHasStartedMerge] = useState(false);

  const player = useVideoPlayer(mergedVideoUri || null, (player) => {
    if (player) {
      player.loop = false;
      player.muted = false;
      player.staysActiveInBackground = true; 
      player.currentTime = 0;
    }
  });

  // Update player when merged video URI changes
  useEffect(() => {
    if (mergedVideoUri && player) {
      const updatePlayer = async () => {
        try {
          await player.replaceAsync(mergedVideoUri);
          player.play();
        } catch (error) {
          console.error("Error updating player:", error);
        }
      };
      updatePlayer();
    }
  }, [mergedVideoUri, player]);

  // Load draft on mount and auto-merge if multiple segments
  useEffect(() => {
    const loadDraft = async () => {
      if (!draftId) {
        router.back();
        return;
      }

      try {
        const loadedDraft = await DraftStorage.getDraftById(draftId);
        if (loadedDraft && loadedDraft.segments.length > 0) {
          setDraft(loadedDraft);
          
          // Auto-merge if multiple segments or single segment with trim points
          const singleSegment = loadedDraft.segments.length === 1 ? loadedDraft.segments[0] : null;
          const hasTrimPoints = singleSegment && 
            singleSegment.trimStartTimeMs !== undefined && 
            singleSegment.trimEndTimeMs !== undefined &&
            singleSegment.trimStartTimeMs >= 0 &&
            singleSegment.trimEndTimeMs > singleSegment.trimStartTimeMs;

          if (loadedDraft.segments.length > 1 && !hasStartedMerge) {
            // Multiple segments - merge them
            setHasStartedMerge(true);
            handleConcatenate(loadedDraft);
          } else if (loadedDraft.segments.length === 1 && hasTrimPoints && !hasStartedMerge) {
            // Single segment with trim points - process through merge to apply trim
            setHasStartedMerge(true);
            handleConcatenate(loadedDraft);
          } else if (loadedDraft.segments.length === 1 && !hasTrimPoints) {
            // Single segment without trim points - use it directly
            const singleSegmentUri = fileStore.toAbsolutePath(loadedDraft.segments[0].uri);
            setMergedVideoUri(singleSegmentUri);
          }
        } else {
          router.back();
        }
      } catch (error) {
        console.error("Draft load failed:", error);
        router.back();
      }
    };

    loadDraft();
  }, [draftId]);

  const handleClose = useCallback(() => {
    router.dismiss();
  }, []);

  const handleFinalize = useCallback(() => {
    if (mergedVideoUri && draftId) {
      router.push({
        pathname: "/merged-video",
        params: { videoUri: mergedVideoUri, draftId: draftId },
      });
    }
  }, [mergedVideoUri, draftId]);

  const handleConcatenate = async (draftToMerge?: any) => {
    if (!draftId) return;

    try {
      setIsConcatenating(true);

      const draftData = draftToMerge || await DraftStorage.getDraftById(draftId);
      if (!draftData) {
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
      // Explicitly include trim points to ensure they're passed to native merge
      const segmentsWithAbsolutePaths = draftData.segments.map((segment: any) => ({
        id: segment.id,
        uri: fileStore.toAbsolutePath(segment.uri),
        recordedDurationSeconds: segment.recordedDurationSeconds,
        trimStartTimeMs: segment.trimStartTimeMs,
        trimEndTimeMs: segment.trimEndTimeMs,
      }));

      // Start concatenation
      const outputUri = await VideoConcatModule.export(
        segmentsWithAbsolutePaths,
        draftId
      );

      // Remove progress listener
      progressListener?.remove();

      // Set merged video URI to show in player
      setMergedVideoUri(outputUri);
    } catch (error) {
      console.error("❌ Concatenation failed:", error);
      Alert.alert("Merge Failed", "Could not merge videos. Please try again.");
    } finally {
      setIsConcatenating(false);
    }
  };

  if (!draft) {
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

  // Show full-screen loader when concatenating
  if (isConcatenating) {
    return (
      <View style={styles.loadingScreen}>
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
        <ReportIssueButton top={insets.top + 20} />
      </View>
    );
  }

  // Show video player when merged video is ready
  if (mergedVideoUri && player) {
    return (
      <View style={styles.container}>
        <TouchableOpacity
          style={[styles.closeButton, { top: insets.top + 20 }]}
          onPress={handleClose}
        >
          <ThemedText style={styles.closeText}>×</ThemedText>
        </TouchableOpacity>

        <ReportIssueButton top={insets.top + 20} right={20} />

        {/* Video Preview */}
        <View style={styles.videoPreviewContainer}>
          <VideoView
            player={player}
            style={styles.videoPreview}
            allowsFullscreen={false}
            allowsPictureInPicture={false}
            showsTimecodes={false}
            requiresLinearPlayback={false}
            contentFit="contain"
            nativeControls={true}
          />
        </View>

        {/* Finalize Button */}
        <TouchableOpacity
          style={[styles.finalizeButton, { bottom: insets.bottom + 20 }]}
          onPress={handleFinalize}
          activeOpacity={0.8}
        >
          <View style={styles.buttonContent}>
            <MaterialIcons
              name="check-circle"
              size={20}
              color="#ffffff"
              style={styles.buttonIcon}
            />
            <ThemedText style={styles.buttonText}>Finalize</ThemedText>
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  // Loading state while draft is being loaded
  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[styles.closeButton, { top: insets.top + 20 }]}
        onPress={handleClose}
      >
        <ThemedText style={styles.closeText}>×</ThemedText>
      </TouchableOpacity>
      <ReportIssueButton top={insets.top + 20} left={20} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  videoPreviewContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 90,
  },
  videoPreview: {
    width: "90%",
    maxWidth: "100%",
    aspectRatio: 9 / 16, // Portrait aspect ratio (16:9 rotated)
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#1a1a1a",
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
  finalizeButton: {
    position: "absolute",
    left: 20,
    right: 20,
    height: 50,
    borderRadius: 8,
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
    fontSize: 16,
    fontWeight: "600",
  },
  loadingScreen: {
    flex: 1,
    backgroundColor: "#000000",
    justifyContent: "center",
    alignItems: "center",
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



import { ThemedText } from "@/components/ThemedText";
import VideoTrimScrubber from "@/components/VideoTrimScrubber";
import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { formatTimeMs } from "@/utils/timeFormat";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useState } from "react";
import {
  StyleSheet,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";

export default function SplitTrimScreen() {
  const { draftId, segmentId } = useLocalSearchParams<{
    draftId: string;
    segmentId: string;
  }>();
  const insets = useSafeAreaInsets();

  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [segment, setSegment] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [currentInMs, setCurrentInMs] = useState<number>(0);
  const [currentOutMs, setCurrentOutMs] = useState<number | undefined>(
    undefined
  );

  const player = useVideoPlayer(null, (player) => {
    if (player) {
      player.loop = false;
      player.muted = false;
      player.currentTime = 0;
    }
  });

  useEffect(() => {
    const loadSegment = async () => {
      if (!draftId || !segmentId) {
        router.back();
        return;
      }

      try {
        setIsLoading(true);
        const draft = await DraftStorage.getDraftById(draftId);
        if (!draft) {
          router.back();
          return;
        }

        const foundSegment = draft.segments.find(
          (s: any) => s.id === segmentId
        );
        if (!foundSegment) {
          router.back();
          return;
        }

        setSegment(foundSegment);
        const absoluteUri = fileStore.toAbsolutePath(foundSegment.uri);
        setVideoUri(absoluteUri);

        // Initialize trim points
        setCurrentInMs(foundSegment.inMs ?? 0);
        setCurrentOutMs(foundSegment.outMs);
      } catch (error) {
        console.error("Failed to load segment:", error);
        router.back();
      } finally {
        setIsLoading(false);
      }
    };

    loadSegment();
  }, [draftId, segmentId]);

  useEffect(() => {
    const setupPlayer = async () => {
      if (videoUri && player && !isLoading) {
        try {
          await player.replaceAsync(videoUri);
          // Seek to the in point when video loads
          const inSeconds = currentInMs / 1000;
          player.currentTime = inSeconds;
          player.play();
        } catch (error) {
          console.error("Failed to setup player:", error);
        }
      }
    };

    setupPlayer();
  }, [videoUri, player, isLoading]);

  useEffect(() => {
    if (!player || !segment) return;

    const videoDurationMs = segment.duration * 1000;
    const effectiveOutMs = currentOutMs ?? videoDurationMs;
    const inSeconds = currentInMs / 1000;
    const outSeconds = effectiveOutMs / 1000;

    const checkTime = () => {
      try {
        const currentTime = player.currentTime;
        
        // If we've reached or passed the out point, loop back to in point
        if (currentTime >= outSeconds) {
          player.currentTime = inSeconds;
        }
        // If we're before the in point, jump to in point
        else if (currentTime < inSeconds) {
          player.currentTime = inSeconds;
        }
      } catch (error) {
        // Player might be disposed, ignore
      }
    };

    // Check every 100ms
    const interval = setInterval(checkTime, 100);

    return () => clearInterval(interval);
  }, [player, segment, currentInMs, currentOutMs]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        try {
          if (player && typeof player.pause === "function") {
            player.pause();
          }
        } catch (error) {}
      };
    }, [player])
  );

  useEffect(() => {
    return () => {
      try {
        if (player && typeof player.pause === "function") {
          player.pause();
        }
      } catch (error) {}
    };
  }, [player]);

  const handleCancel = useCallback(() => {
    router.back();
  }, []);

  const handleTrimChange = useCallback((inMs: number, outMs: number) => {
    setCurrentInMs(inMs);
    setCurrentOutMs(outMs);
    
    // Adjust player position if it's outside the new trim bounds
    if (player && segment) {
      try {
        const currentTimeMs = player.currentTime * 1000;
        const videoDurationMs = segment.duration * 1000;
        const effectiveOutMs = outMs ?? videoDurationMs;
        
        // If current position is outside new bounds, adjust it
        if (currentTimeMs < inMs) {
          player.currentTime = inMs / 1000;
        } else if (currentTimeMs > effectiveOutMs) {
          player.currentTime = effectiveOutMs / 1000;
        }
      } catch (error) {
        // Ignore errors
      }
    }
  }, [player, segment]);

  const handleSeek = useCallback(
    (timeMs: number) => {
      if (player && !isLoading && segment) {
        try {
          // Pause the player when seeking during trim handle drag
          // This ensures the frame stays visible at the trim point
          if (player.playing) {
            player.pause();
          }
          
          // Seek to the exact position with high precision
          // Convert ms to seconds with full precision (no rounding)
          const timeSeconds = timeMs / 1000.0;
          player.currentTime = timeSeconds;
        } catch (error) {
          console.error("Failed to seek player:", error);
        }
      }
    },
    [player, isLoading, segment]
  );

  const handleSplit = useCallback(
    async (splitMs: number) => {
      if (!draftId || !segment) return;

      Alert.alert(
        "Split Segment",
        `Split this segment at ${formatTimeMs(splitMs)}?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Split",
            style: "destructive",
            onPress: async () => {
              try {
                setIsSaving(true);
                const draft = await DraftStorage.getDraftById(draftId);
                if (!draft) return;

                // Find the segment index
                const segmentIndex = draft.segments.findIndex(
                  (s: any) => s.id === segmentId
                );
                if (segmentIndex === -1) return;

                // Create two new segments from the split
                const originalSegment = draft.segments[segmentIndex];
                const segment1 = {
                  id: `${originalSegment.id}_split1_${Date.now()}`,
                  uri: originalSegment.uri,
                  duration: originalSegment.duration,
                  inMs: currentInMs,
                  outMs: splitMs,
                };
                const segment2 = {
                  id: `${originalSegment.id}_split2_${Date.now()}`,
                  uri: originalSegment.uri,
                  duration: originalSegment.duration,
                  inMs: splitMs,
                  outMs: currentOutMs ?? originalSegment.duration * 1000,
                };

                // Replace the original segment with the two new ones
                const newSegments = [
                  ...draft.segments.slice(0, segmentIndex),
                  segment1,
                  segment2,
                  ...draft.segments.slice(segmentIndex + 1),
                ];

                // Preserve the original totalDuration (selected duration limit, e.g., 3 min)
                // Don't recalculate it based on segments - it represents the limit, not actual duration
                await DraftStorage.updateDraft(
                  draftId,
                  newSegments,
                  draft.totalDuration
                );

                // Navigate back to edit segments screen
                router.push({
                  pathname: "/reordersegments",
                  params: { draftId },
                });
              } catch (error) {
                console.error("Failed to split segment:", error);
                Alert.alert("Error", "Failed to split segment");
                setIsSaving(false);
              }
            },
          },
        ]
      );
    },
    [draftId, segment, segmentId, currentInMs, currentOutMs]
  );

  const handleSave = useCallback(async () => {
    if (!draftId || !segment) return;

    try {
      setIsSaving(true);
      const draft = await DraftStorage.getDraftById(draftId);
      if (!draft) return;

      // Update the segment with new trim points
      const updatedSegments = draft.segments.map((s: any) => {
        if (s.id === segmentId) {
          return {
            ...s,
            inMs: currentInMs,
            outMs: currentOutMs,
          };
        }
        return s;
      });

      // Preserve the original totalDuration (selected duration limit, e.g., 3 min)
      // Don't recalculate it based on segments - it represents the limit, not actual duration
      await DraftStorage.updateDraft(draftId, updatedSegments, draft.totalDuration);

      // Navigate back to edit segments screen
      router.push({
        pathname: "/reordersegments",
        params: { draftId },
      });
    } catch (error) {
      console.error("Failed to save trim points:", error);
      Alert.alert("Error", "Failed to save trim points");
      setIsSaving(false);
    }
  }, [draftId, segment, segmentId, currentInMs, currentOutMs]);

  if (isLoading || !videoUri) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.closeButton} onPress={handleCancel}>
            <MaterialIcons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <View />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#ff0000" />
          <ThemedText style={styles.loadingText}>Loading video...</ThemedText>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.closeButton} onPress={handleCancel}>
          <MaterialIcons name="close" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <ThemedText style={styles.headerTitle}>Split & Trim</ThemedText>
        </View>
        <TouchableOpacity
          style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={isSaving}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <MaterialIcons name="check" size={24} color="#fff" />
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.videoContainer}>
        <VideoView
          player={player}
          style={styles.video}
          allowsFullscreen={false}
          allowsPictureInPicture={false}
          showsTimecodes={true}
          requiresLinearPlayback={false}
          contentFit="contain"
          nativeControls={true}
        />
      </View>

      <View style={styles.controlsContainer}>
        <VideoTrimScrubber
          videoUri={videoUri}
          videoDuration={segment.duration}
          initialInMs={currentInMs}
          initialOutMs={currentOutMs}
          onTrimChange={handleTrimChange}
          onSplit={handleSplit}
          onSeek={handleSeek}
        />
      </View>
    </View>
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
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 20,
    backgroundColor: "rgba(0, 0, 0, 0.9)",
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  saveButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#ff0000",
    justifyContent: "center",
    alignItems: "center",
  },
  saveButtonDisabled: {
    backgroundColor: "#666",
    opacity: 0.5,
  },
  headerInfo: {
    flex: 1,
    alignItems: "center",
    marginHorizontal: 20,
  },
  headerTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    fontFamily: "Roboto-Bold",
  },
  videoContainer: {
    flex: 0.6,
    width: "100%",
    backgroundColor: "#000",
  },
  video: {
    flex: 1,
    width: "100%",
  },
  controlsContainer: {
    flex: 0.4,
    width: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.9)",
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.1)",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Roboto-Regular",
    marginTop: 16,
  },
});

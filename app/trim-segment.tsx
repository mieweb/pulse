import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useState, useEffect, useRef } from "react";
import {
  StyleSheet,
  TouchableOpacity,
  View,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { fileStore } from "@/utils/fileStore";
import VideoTrimmerUI from "react-native-video-trimmer-ui";
import { DraftStorage } from "@/utils/draftStorage";

export default function TrimSegmentScreen() {
  const { segmentUri, draftId, segmentId } = useLocalSearchParams<{
    segmentUri: string;
    draftId: string;
    segmentId: string;
  }>();
  const insets = useSafeAreaInsets();
  const [isLoading, setIsLoading] = useState(true);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const trimmerRef = useRef<any>(null);

  // Normalize URI
  const absoluteUri = segmentUri?.startsWith("file://") || segmentUri?.startsWith("/")
    ? segmentUri
    : fileStore.toAbsolutePath(segmentUri || "");

  // Load existing trim points (for reference, but won't auto-set in UI)
  useEffect(() => {
    const loadTrimPoints = async () => {
      if (!draftId || !segmentId) return;

      try {
        const draft = await DraftStorage.getDraftById(draftId);
        const segment = draft?.segments.find((s) => s.id === segmentId);
        if (segment?.trimStartTimeMs !== undefined && segment?.trimEndTimeMs !== undefined) {
          setTrimStart(segment.trimStartTimeMs / 1000); // Convert to seconds
          setTrimEnd(segment.trimEndTimeMs / 1000);
        }
        setIsLoading(false);
      } catch (error) {
        console.error("[TrimSegment] Error loading trim points:", error);
        setIsLoading(false);
      }
    };

    loadTrimPoints();
  }, [draftId, segmentId]);

  // Handle trim selection - update state with exact values
  const handleTrimSelected = (start: number, end: number) => {
    setTrimStart(start);
    setTrimEnd(end);
  };

  // Handle save - get exact trim points from the trimmer
  const handleSave = async () => {
    if (!draftId || !segmentId) {
      Alert.alert("Error", "Missing required parameters");
      return;
    }

    try {
      // Get the exact current trim points from the trimmer (more accurate than state)
      let finalTrimStart = trimStart;
      let finalTrimEnd = trimEnd;

      if (trimmerRef.current && typeof trimmerRef.current.getSelection === 'function') {
        try {
          const [start, end] = trimmerRef.current.getSelection();
          finalTrimStart = start;
          finalTrimEnd = end;
        } catch (error) {
          console.warn("Could not get selection from trimmer, using state values:", error);
        }
      }

      const updatedDraft = await DraftStorage.getDraftById(draftId);
      if (!updatedDraft) {
        Alert.alert("Error", "Draft not found");
        return;
      }

      const trimStartMs = finalTrimStart * 1000;
      const trimEndMs = finalTrimEnd * 1000;
      
      const updatedSegments = updatedDraft.segments.map((seg) => {
        if (seg.id === segmentId) {
          return {
            ...seg,
            trimStartTimeMs: trimStartMs,
            trimEndTimeMs: trimEndMs,
          };
        }
        return seg;
      });

      await DraftStorage.updateDraft(
        draftId,
        updatedSegments,
        updatedDraft.maxDurationLimitSeconds
      );

      // Navigate back to reorder screen - replace closes this screen and reloads reorder screen
      router.replace({
        pathname: "/reordersegments",
        params: { draftId },
      });
    } catch (error) {
      console.error("Failed to save trim points:", error);
      Alert.alert("Error", "Failed to save trim points");
    }
  };

  if (isLoading) {
    return (
      <ThemedView style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => router.back()}
            activeOpacity={0.7}
          >
            <MaterialIcons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <ThemedText style={styles.headerTitle}>Trim Segment</ThemedText>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#ff0000" />
          <ThemedText style={styles.loadingText}>Loading...</ThemedText>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <TouchableOpacity
          style={styles.closeButton}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <MaterialIcons name="close" size={24} color="#fff" />
        </TouchableOpacity>
        <ThemedText style={styles.headerTitle}>Trim Segment</ThemedText>
        <TouchableOpacity
          style={styles.saveButton}
          onPress={handleSave}
          activeOpacity={0.7}
        >
          <ThemedText style={styles.saveButtonText}>Save</ThemedText>
        </TouchableOpacity>
      </View>

      {/* Video Trimmer UI - includes built-in video player with looping */}
      <View style={styles.trimmerContainer}>
        <VideoTrimmerUI
          ref={trimmerRef}
          source={{ uri: absoluteUri }}
          onSelected={handleTrimSelected}
          loop={true}
          containerStyle={styles.trimmerUI}
          sliderContainerStyle={styles.sliderContainer}
          tintColor="#ff0000"
          minDuration={0.1}
        />
      </View>
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
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 10,
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
  headerTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    fontFamily: "Roboto-Bold",
  },
  headerSpacer: {
    width: 40,
  },
  saveButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#ff0000",
  },
  saveButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "#fff",
    marginTop: 16,
    fontSize: 16,
  },
  trimmerContainer: {
    flex: 1,
    backgroundColor: "#000",
  },
  trimmerUI: {
    flex: 1,
    backgroundColor: "#000",
  },
  sliderContainer: {
    marginHorizontal: 20,
    marginBottom: 40,
  },
});

import { ThemedText } from "@/components/ThemedText";
import SegmentReorderListVertical from "@/components/SegmentReorderListVertical";
import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, View, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface Segment {
  id: string;
  uri: string;
  duration: number;
}

export default function ReorderSegmentsScreen() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>();
  const insets = useSafeAreaInsets();

  const [segments, setSegments] = useState<Segment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [draft, setDraft] = useState<any>(null);

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
          // Convert segments to the format expected by the reorder component
          const formattedSegments: Segment[] = draft.segments.map(
            (segment: any) => ({
              id: segment.id,
              uri: fileStore.toAbsolutePath(segment.uri),
              duration: segment.duration,
            })
          );
          setSegments(formattedSegments);
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

  const handleSegmentsReorder = useCallback((reorderedSegments: Segment[]) => {
    setSegments(reorderedSegments);
  }, []);

  const handleSave = useCallback(
    async (reorderedSegments: Segment[]) => {
      if (!draftId || !draft) return;

      try {
        // Convert back to the draft format
        const updatedSegments = reorderedSegments.map((segment) => ({
          id: segment.id,
          uri: fileStore.toRelativePath(segment.uri), // Convert back to relative path
          duration: segment.duration,
        }));

        // Update the draft with reordered segments
        const updatedDraft = {
          ...draft,
          segments: updatedSegments,
        };

        // Use the original draft's totalDuration (selected duration limit)
        const totalDuration = draft.totalDuration;

        // Save the updated draft
        await DraftStorage.updateDraft(draftId, updatedSegments, totalDuration);

        // Navigate back to camera screen
        router.back();
      } catch (error) {
        console.error("Failed to save reordered segments:", error);
      }
    },
    [draftId, draft]
  );

  const handleCancel = useCallback(() => {
    router.back();
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator size="large" color="#ff0000" />
        <ThemedText style={styles.loadingText}>Loading segments...</ThemedText>
      </View>
    );
  }

  if (segments.length === 0) {
    return (
      <View style={[styles.container, styles.errorContainer]}>
        <ThemedText style={styles.errorText}>No segments found</ThemedText>
        <ThemedText style={styles.errorSubtext}>
          Please record some segments first
        </ThemedText>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.contentContainer}>
        <SegmentReorderListVertical
          segments={segments}
          onSegmentsReorder={handleSegmentsReorder}
          onSave={handleSave}
          onCancel={handleCancel}
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
  contentContainer: {
    flex: 1,
    width: "100%",
  },
  loadingContainer: {
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Roboto-Regular",
    marginTop: 16,
  },
  errorContainer: {
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  errorText: {
    color: "#fff",
    fontSize: 18,
    fontFamily: "Roboto-Bold",
    textAlign: "center",
    marginBottom: 8,
  },
  errorSubtext: {
    color: "#ccc",
    fontSize: 14,
    fontFamily: "Roboto-Regular",
    textAlign: "center",
  },
});

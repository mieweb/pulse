import { ThemedText } from "@/components/ThemedText";
import SegmentReorderListVertical from "@/components/SegmentReorderListVertical";
import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { calculateSegmentsDuration } from "@/utils/timeFormat";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, View, ActivityIndicator, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";

interface Segment {
  id: string;
  uri: string;
  duration: number;
  inMs?: number;
  outMs?: number;
}

export default function ReorderSegmentsScreen() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>();
  const insets = useSafeAreaInsets();

  const [segments, setSegments] = useState<Segment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraft] = useState<any>(null);

  const formatSegments = useCallback((draftSegments: any[]): Segment[] => {
    return draftSegments.map((segment: any) => ({
      id: segment.id,
      uri: fileStore.toAbsolutePath(segment.uri),
      duration: segment.duration,
      inMs: segment.inMs,
      outMs: segment.outMs,
    }));
  }, []);

  const [originalSegments, setOriginalSegments] = useState<Segment[]>([]);

  const loadDraft = useCallback(async () => {
    if (!draftId) {
      router.back();
      return;
    }

    try {
      const loadedDraft = await DraftStorage.getDraftById(draftId);
      if (loadedDraft && loadedDraft.segments.length > 0) {
        setDraft(loadedDraft);
        const formattedSegments = formatSegments(loadedDraft.segments);
        setSegments(formattedSegments);
        setOriginalSegments([...formattedSegments]);
      } else {
        router.back();
      }
    } catch (error) {
      console.error("Draft load failed:", error);
      router.back();
    } finally {
      setIsLoading(false);
    }
  }, [draftId, formatSegments]);

  useEffect(() => {
    loadDraft();
  }, [loadDraft]);

  useFocusEffect(
    useCallback(() => {
      if (isLoading) return;
      loadDraft();
    }, [loadDraft, isLoading])
  );

  const calculateTotalDuration = calculateSegmentsDuration;

  const handleSegmentsReorder = useCallback((reorderedSegments: Segment[]) => {
    setSegments(reorderedSegments);
  }, []);

  const handleSave = useCallback(
    async (reorderedSegments: Segment[]) => {
      if (!draftId || !draft) return;

      setIsSaving(true);
      try {
        const deletedSegments = originalSegments.filter(
          (originalSegment) =>
            !reorderedSegments.some(
              (segment) => segment.id === originalSegment.id
            )
        );

        if (deletedSegments.length > 0) {
          const urisToDelete = deletedSegments.map((seg) => seg.uri);
          await fileStore.deleteUris(urisToDelete);
          console.log(
            `Deleted ${deletedSegments.length} segment file(s) after save`
          );
        }

        const updatedSegments = reorderedSegments.map((segment) => ({
          id: segment.id,
          uri: fileStore.toRelativePath(segment.uri),
          duration: segment.duration,
          inMs: segment.inMs,
          outMs: segment.outMs,
        }));

        // Preserve the original totalDuration (selected duration limit, e.g., 3 min)
        // Don't recalculate it based on segments - it represents the limit, not actual duration
        await DraftStorage.updateDraft(draftId, updatedSegments, draft.totalDuration);
        // Navigate back after successful save
        router.back();
      } catch (error) {
        console.error("Failed to save reordered segments:", error);
        Alert.alert(
          "Save Failed",
          "Failed to save changes. Some files may not have been deleted properly. Please try again.",
          [{ text: "OK" }]
        );
      } finally {
        setIsSaving(false);
      }
    },
    [draftId, draft, originalSegments, calculateTotalDuration]
  );

  const totalDuration = calculateTotalDuration(segments);

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

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.contentContainer}>
        <SegmentReorderListVertical
          segments={segments}
          onSegmentsReorder={handleSegmentsReorder}
          onSave={handleSave}
          onCancel={handleCancel}
          totalDuration={totalDuration}
          isSaving={isSaving}
          onEditSegment={(segment) => {
            router.push({
              pathname: "/splittrim",
              params: { draftId: draftId, segmentId: segment.id },
            });
          }}
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
});

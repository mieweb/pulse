import { ThemedText } from "@/components/ThemedText";
import SegmentReorderListVertical from "@/components/SegmentReorderListVertical";
import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, View, ActivityIndicator, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface Segment {
  id: string;
  uri: string;
  recordedDurationSeconds: number;
}

export default function ReorderSegmentsScreen() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>();
  const insets = useSafeAreaInsets();

  const [segments, setSegments] = useState<Segment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
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
          const formattedSegments: Segment[] = draft.segments.map(
            (segment: any) => ({
              id: segment.id,
              uri: fileStore.toAbsolutePath(segment.uri),
              recordedDurationSeconds: segment.recordedDurationSeconds,
            })
          );
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
    };

    loadDraft();
  }, [draftId]);

  const [originalSegments, setOriginalSegments] = useState<Segment[]>([]);

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
          recordedDurationSeconds: segment.recordedDurationSeconds,
        }));

        const maxDurationLimitSeconds = draft.maxDurationLimitSeconds;

        await DraftStorage.updateDraft(draftId, updatedSegments, maxDurationLimitSeconds);
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
    [draftId, draft, originalSegments]
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

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.contentContainer}>
        <SegmentReorderListVertical
          segments={segments}
          onSegmentsReorder={handleSegmentsReorder}
          onSave={handleSave}
          onCancel={handleCancel}
          isSaving={isSaving}
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

import { ThemedText } from "@/components/ThemedText";
import { generateVideoThumbnail } from "@/utils/videoThumbnails";
import { MaterialIcons } from "@expo/vector-icons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import React, { useState, useCallback, useEffect } from "react";
import {
  StyleSheet,
  View,
  TouchableOpacity,
  Image,
  ScrollView,
} from "react-native";
import { router } from "expo-router";
import Sortable from "react-native-sortables";

const THUMBNAIL_SIZE = 60;
const ACCENT_COLOR = "#ff0000";

interface Segment {
  id: string;
  uri: string;
  recordedDurationSeconds: number;
  trimStartTimeMs?: number;
  trimEndTimeMs?: number;
}

// Calculate effective duration: trimmed duration if trim points exist, otherwise original duration
const getEffectiveDuration = (segment: Segment): number => {
  if (
    segment.trimStartTimeMs !== undefined &&
    segment.trimEndTimeMs !== undefined &&
    segment.trimStartTimeMs >= 0 &&
    segment.trimEndTimeMs > segment.trimStartTimeMs
  ) {
    // Calculate trimmed duration in seconds
    return (segment.trimEndTimeMs - segment.trimStartTimeMs) / 1000;
  }
  // Return original recorded duration if no trim points
  return segment.recordedDurationSeconds;
};

interface SegmentReorderListVerticalProps {
  segments: Segment[];
  onSegmentsReorder: (reorderedSegments: Segment[]) => void;
  onSave: (segments: Segment[]) => void;
  onCancel: () => void;
  draftId?: string;
}

interface SegmentItemProps {
  item: Segment;
  index: number;
  onDelete: (segmentId: string) => void;
  onTrim?: (segment: Segment) => void;
}

function SegmentItem({ item: segment, index, onDelete, onTrim }: SegmentItemProps) {
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Generate thumbnail on mount
  useEffect(() => {
    const loadThumbnail = async () => {
      try {
        setIsLoading(true);
        const uri = await generateVideoThumbnail(segment.uri, {
          time: 1000,
          quality: 0.8,
        });
        setThumbnailUri(uri);
      } catch (error) {
        console.error("Failed to generate thumbnail:", error);
      } finally {
        setIsLoading(false);
      }
    };

    loadThumbnail();
  }, [segment.uri]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    // Show seconds with 2 decimal places for precision
    return `${mins}:${secs.toFixed(2).padStart(5, "0")}`;
  };

  return (
    <View style={styles.segmentItem}>
      {/* Thumbnail */}
      <View style={styles.thumbnailContainer}>
        {isLoading ? (
          <View style={styles.loadingThumbnail}>
            <MaterialIcons name="video-library" size={24} color="#666" />
          </View>
        ) : thumbnailUri ? (
          <Image source={{ uri: thumbnailUri }} style={styles.thumbnail} />
        ) : (
          <View style={styles.errorThumbnail}>
            <MaterialIcons name="error" size={24} color="#666" />
          </View>
        )}
      </View>

      {/* Segment info */}
      <View style={styles.segmentInfo}>
        <ThemedText style={styles.segmentNumber}>
          Segment {index + 1}
        </ThemedText>
        <ThemedText style={styles.segmentDuration}>
          {formatDuration(getEffectiveDuration(segment))}
        </ThemedText>
      </View>

      {/* Trim button */}
      {onTrim && (
        <TouchableOpacity
          style={styles.trimButton}
          onPress={() => onTrim(segment)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Trim segment ${index + 1}`}
          accessibilityHint="Opens trim screen for this segment"
        >
          <MaterialCommunityIcons name="scissors-cutting" size={24} color="#2196F3" />
        </TouchableOpacity>
      )}

      {/* Delete button */}
      <TouchableOpacity
        style={styles.deleteButton}
        onPress={() => onDelete(segment.id)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Delete segment ${index + 1}`}
        accessibilityHint="Removes this segment from the video"
      >
        <MaterialIcons name="delete" size={24} color={ACCENT_COLOR} />
      </TouchableOpacity>

      {/* Reorder indicator */}
      <View style={styles.reorderIndicator}>
        <MaterialIcons name="reorder" size={20} color="#999" />
      </View>
    </View>
  );
}

export default function SegmentReorderListVertical({
  segments,
  onSegmentsReorder,
  onSave,
  onCancel,
  draftId,
}: SegmentReorderListVerticalProps) {
  const [reorderedSegments, setReorderedSegments] =
    useState<Segment[]>(segments);

  // Update reorderedSegments when segments prop changes (e.g., after trim points are updated)
  useEffect(() => {
    setReorderedSegments(segments);
  }, [segments]);

  const handleOrderChange = useCallback(
    (newOrder: Segment[]) => {
      setReorderedSegments(newOrder);
      onSegmentsReorder(newOrder);
      // Auto-save on reorder
      onSave(newOrder);
    },
    [onSegmentsReorder, onSave]
  );

  const handleDeleteSegment = useCallback(
    (segmentId: string) => {
      const updatedSegments = reorderedSegments.filter(
        (segment) => segment.id !== segmentId
      );
      setReorderedSegments(updatedSegments);
      onSegmentsReorder(updatedSegments);
      // Auto-save on delete
      onSave(updatedSegments);
    },
    [reorderedSegments, onSegmentsReorder, onSave]
  );

  const handleTrimSegment = useCallback(
    (segment: Segment) => {
      if (!draftId) return;
      router.push({
        pathname: "/trim-segment",
        params: {
          segmentUri: segment.uri,
          draftId: draftId,
          segmentId: segment.id,
        },
      });
    },
    [draftId]
  );


  // Calculate total duration using effective (trimmed) durations
  const totalRecordedDurationSeconds = reorderedSegments.reduce(
    (total, segment) => total + getEffectiveDuration(segment),
    0
  );

  const formatTotalDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    // Show seconds with 2 decimal places for precision
    return `${mins}:${secs.toFixed(2).padStart(5, "0")}`;
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
          <MaterialIcons name="close" size={24} color="#fff" />
        </TouchableOpacity>

        <View style={styles.headerInfo}>
          <ThemedText style={styles.headerTitle}>Edit Segments</ThemedText>
          <ThemedText style={styles.headerSubtitle}>
            {reorderedSegments.length} segments •{" "}
            {formatTotalDuration(totalRecordedDurationSeconds)}
          </ThemedText>
          <View style={styles.infoTag}>
            <MaterialIcons name="info" size={14} color={ACCENT_COLOR} />
            <ThemedText style={styles.infoTagText}>Hold to drag</ThemedText>
          </View>
        </View>

        {/* Invisible spacer to balance the close button */}
        <View style={styles.headerSpacer} />
      </View>

      {/* Sortable List */}
      <ScrollView
        style={styles.sortableContainer}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Sortable.Grid
          data={reorderedSegments}
          renderItem={({ item, index }) => (
            <SegmentItem
              item={item}
              index={index}
              onDelete={handleDeleteSegment}
              onTrim={handleTrimSegment}
            />
          )}
          columns={1}
          rowGap={8}
          onDragEnd={({ data }) => {
            handleOrderChange(data);
          }}
        />
      </ScrollView>

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
  cancelButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  headerSpacer: {
    width: 40,
    height: 40,
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
  headerSubtitle: {
    color: "#ccc",
    fontSize: 14,
    fontFamily: "Roboto-Regular",
    marginTop: 2,
  },
  infoTag: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 0, 0, 0.1)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginTop: 8,
    alignSelf: "center",
  },
  infoTagText: {
    color: ACCENT_COLOR,
    fontSize: 12,
    fontFamily: "Roboto-Regular",
    marginLeft: 4,
  },
  sortableContainer: {
    flex: 1,
    width: "100%",
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 0,
  },
  segmentItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    width: "100%",
    minHeight: 80,
  },
  thumbnailContainer: {
    marginRight: 12,
  },
  thumbnail: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: 8,
    backgroundColor: "#333",
  },
  loadingThumbnail: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: 8,
    backgroundColor: "#333",
    justifyContent: "center",
    alignItems: "center",
  },
  errorThumbnail: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: 8,
    backgroundColor: "#333",
    justifyContent: "center",
    alignItems: "center",
  },
  segmentInfo: {
    flex: 1,
  },
  segmentNumber: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    fontFamily: "Roboto-Bold",
  },
  segmentDuration: {
    color: "#ccc",
    fontSize: 14,
    fontFamily: "Roboto-Regular",
    marginTop: 2,
  },
  reorderIndicator: {
    marginLeft: 12,
    padding: 4,
  },
  trimButton: {
    marginLeft: 8,
    padding: 4,
  },
  deleteButton: {
    marginLeft: 8,
    padding: 4,
  },
});

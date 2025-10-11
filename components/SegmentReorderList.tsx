import { ThemedText } from "@/components/ThemedText";
import SegmentThumbnail from "@/components/SegmentThumbnail";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useState, useCallback } from "react";
import {
  StyleSheet,
  View,
  ScrollView,
  TouchableOpacity,
  Dimensions,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from "react-native-reanimated";

const { width: screenWidth } = Dimensions.get("window");
const THUMBNAIL_SIZE = (screenWidth - 60) / 2;

interface Segment {
  id: string;
  uri: string;
  duration: number;
}

interface SegmentReorderListProps {
  segments: Segment[];
  onSegmentsReorder: (reorderedSegments: Segment[]) => void;
  onSave: (segments: Segment[]) => void;
  onCancel: () => void;
}

export default function SegmentReorderList({
  segments,
  onSegmentsReorder,
  onSave,
  onCancel,
}: SegmentReorderListProps) {
  const [reorderedSegments, setReorderedSegments] =
    useState<Segment[]>(segments);
  const [isDragging, setIsDragging] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Animation for save button
  const saveButtonScale = useSharedValue(1);

  const handleDragStart = useCallback((index: number) => {
    setIsDragging(true);
    setDraggedIndex(index);
  }, []);

  const handleDragEnd = useCallback(
    (fromIndex: number, toIndex: number) => {
      setIsDragging(false);
      setDraggedIndex(null);

      if (fromIndex !== toIndex && toIndex < reorderedSegments.length) {
        const newSegments = [...reorderedSegments];
        const [movedSegment] = newSegments.splice(fromIndex, 1);
        newSegments.splice(toIndex, 0, movedSegment);

        setReorderedSegments(newSegments);
        setHasChanges(true);
        onSegmentsReorder(newSegments);
      }
    },
    [reorderedSegments, onSegmentsReorder]
  );

  const handleSave = useCallback(() => {
    if (hasChanges) {
      saveButtonScale.value = withSpring(0.95, {}, () => {
        saveButtonScale.value = withSpring(1);
      });

      onSave(reorderedSegments);
      setHasChanges(false);
    }
  }, [hasChanges, reorderedSegments, onSave, saveButtonScale]);

  const animatedSaveButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: saveButtonScale.value }],
  }));

  const totalDuration = reorderedSegments.reduce(
    (total, segment) => total + segment.duration,
    0
  );

  const formatTotalDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
          <MaterialIcons name="close" size={24} color="#fff" />
        </TouchableOpacity>

        <View style={styles.headerInfo}>
          <ThemedText style={styles.headerTitle}>Reorder Segments</ThemedText>
          <ThemedText style={styles.headerSubtitle}>
            {reorderedSegments.length} segments •{" "}
            {formatTotalDuration(totalDuration)}
          </ThemedText>
        </View>

        {/* Invisible spacer to balance the close button */}
        <View style={styles.headerSpacer} />
      </View>

      {/* Segments Grid */}
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.segmentsGrid}>
          {reorderedSegments.map((segment, index) => (
            <SegmentThumbnail
              key={segment.id}
              segment={segment}
              index={index}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              isDragging={isDragging}
              draggedIndex={draggedIndex}
            />
          ))}
        </View>
      </ScrollView>

      {/* Save Button */}
      <Animated.View
        style={[styles.saveButtonContainer, animatedSaveButtonStyle]}
      >
        <TouchableOpacity
          style={[styles.saveButton, !hasChanges && styles.disabledSaveButton]}
          onPress={handleSave}
          disabled={!hasChanges}
          activeOpacity={0.8}
        >
          <MaterialIcons
            name="save"
            size={20}
            color={hasChanges ? "#fff" : "#666"}
          />
          <ThemedText
            style={[
              styles.saveButtonText,
              !hasChanges && styles.disabledSaveButtonText,
            ]}
          >
            {hasChanges ? "Save New Order" : "No Changes"}
          </ThemedText>
        </TouchableOpacity>
      </Animated.View>
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
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
  },
  segmentsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  saveButtonContainer: {
    padding: 20,
    backgroundColor: "rgba(0, 0, 0, 0.9)",
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.1)",
  },
  saveButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ff0000",
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
  },
  disabledSaveButton: {
    backgroundColor: "#333",
  },
  saveButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    fontFamily: "Roboto-Bold",
    marginLeft: 8,
  },
  disabledSaveButtonText: {
    color: "#666",
  },
});

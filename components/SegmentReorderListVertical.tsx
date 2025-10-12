import { ThemedText } from "@/components/ThemedText";
import { generateVideoThumbnail } from "@/utils/videoThumbnails";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useState, useCallback, useEffect } from "react";
import {
  StyleSheet,
  View,
  ScrollView,
  TouchableOpacity,
  Dimensions,
  Image,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

const { width: screenWidth } = Dimensions.get("window");
const ITEM_HEIGHT = 80;
const THUMBNAIL_SIZE = 60;

function DropIndicator({
  index,
  isVisible,
  totalSegments,
}: DropIndicatorProps) {
  if (!isVisible) return null;

  // Clamp the index to valid range
  const clampedIndex = Math.max(0, Math.min(index, totalSegments - 1));

  return (
    <View
      style={[styles.dropIndicator, { top: clampedIndex * (ITEM_HEIGHT + 8) }]}
    />
  );
}

interface Segment {
  id: string;
  uri: string;
  duration: number;
}

interface SegmentReorderListVerticalProps {
  segments: Segment[];
  onSegmentsReorder: (reorderedSegments: Segment[]) => void;
  onSave: (segments: Segment[]) => void;
  onCancel: () => void;
}

interface DropIndicatorProps {
  index: number;
  isVisible: boolean;
  totalSegments: number;
}

interface SegmentItemProps {
  segment: Segment;
  index: number;
  totalSegments: number;
  onDragStart: (index: number) => void;
  onDragEnd: (fromIndex: number, toIndex: number) => void;
  onDragUpdate: (fromIndex: number, toIndex: number) => void;
  isDragging: boolean;
  draggedIndex: number | null;
}

function SegmentItem({
  segment,
  index,
  totalSegments,
  onDragStart,
  onDragEnd,
  onDragUpdate,
  isDragging,
  draggedIndex,
}: SegmentItemProps) {
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Animation values
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const zIndex = useSharedValue(0);

  const isBeingDragged = draggedIndex === index;
  const isDragTarget = isDragging && !isBeingDragged;

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

  // Gesture handler for drag and drop
  const panGesture = Gesture.Pan()
    .onStart(() => {
      zIndex.value = 100;
      scale.value = 1.02;
      runOnJS(onDragStart)(index);
    })
    .onUpdate((event) => {
      translateY.value = event.translationY;

      // Calculate drop target based on absolute position relative to other segments
      const currentPosition = index * (ITEM_HEIGHT + 8) + event.translationY;
      const targetIndex = Math.round(currentPosition / (ITEM_HEIGHT + 8));
      const clampedIndex = Math.max(
        0,
        Math.min(targetIndex, totalSegments - 1)
      );
      runOnJS(onDragUpdate)(index, clampedIndex);
    })
    .onEnd(() => {
      // Calculate drop target based on absolute position relative to other segments
      const currentPosition = index * (ITEM_HEIGHT + 8) + translateY.value;
      const targetIndex = Math.round(currentPosition / (ITEM_HEIGHT + 8));
      const clampedIndex = Math.max(
        0,
        Math.min(targetIndex, totalSegments - 1)
      );

      // Reset position with minimal animation
      translateY.value = 0;
      scale.value = 1;
      zIndex.value = 0;

      runOnJS(onDragEnd)(index, clampedIndex);
    });

  // Animated styles
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
    zIndex: zIndex.value,
  }));

  const containerStyle = useAnimatedStyle(() => ({
    opacity: isDragTarget ? 0.7 : 1,
  }));

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <Animated.View style={[styles.itemContainer, containerStyle]}>
      <GestureDetector gesture={panGesture}>
        <Animated.View style={[styles.segmentItem, animatedStyle]}>
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
              {formatDuration(segment.duration)}
            </ThemedText>
          </View>

          {/* Reorder indicator */}
          <View style={styles.reorderIndicator}>
            <MaterialIcons name="reorder" size={20} color="#999" />
          </View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

export default function SegmentReorderListVertical({
  segments,
  onSegmentsReorder,
  onSave,
  onCancel,
}: SegmentReorderListVerticalProps) {
  const [reorderedSegments, setReorderedSegments] =
    useState<Segment[]>(segments);
  const [isDragging, setIsDragging] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropIndicatorIndex, setDropIndicatorIndex] = useState<number | null>(
    null
  );
  const [hasChanges, setHasChanges] = useState(false);

  // Animation for save button
  const saveButtonScale = useSharedValue(1);

  const handleDragStart = useCallback((index: number) => {
    setIsDragging(true);
    setDraggedIndex(index);
    setDropIndicatorIndex(index);
  }, []);

  const handleDragUpdate = useCallback((fromIndex: number, toIndex: number) => {
    setDropIndicatorIndex(toIndex);
  }, []);

  const handleDragEnd = useCallback(
    (fromIndex: number, toIndex: number) => {
      setIsDragging(false);
      setDraggedIndex(null);
      setDropIndicatorIndex(null);

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
      saveButtonScale.value = 0.98;
      setTimeout(() => {
        saveButtonScale.value = 1;
      }, 100);

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

      {/* Segments List */}
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.segmentsContainer}>
          {reorderedSegments.map((segment, index) => (
            <SegmentItem
              key={segment.id}
              segment={segment}
              index={index}
              totalSegments={reorderedSegments.length}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragUpdate={handleDragUpdate}
              isDragging={isDragging}
              draggedIndex={draggedIndex}
            />
          ))}
          <DropIndicator
            index={dropIndicatorIndex || 0}
            isVisible={isDragging && dropIndicatorIndex !== null}
            totalSegments={reorderedSegments.length}
          />
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
  segmentsContainer: {
    position: "relative",
  },
  dropIndicator: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: "#ff0000",
    borderRadius: 1,
    zIndex: 1000,
  },
  itemContainer: {
    marginBottom: 8,
  },
  segmentItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
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

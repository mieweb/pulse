import { ThemedText } from "@/components/ThemedText";
import { generateVideoThumbnail } from "@/utils/videoThumbnails";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  Image,
  StyleSheet,
  TouchableOpacity,
  View,
  Dimensions,
} from "react-native";
import Animated, {
  useAnimatedGestureHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  runOnJS,
} from "react-native-reanimated";
import {
  PanGestureHandler,
  PanGestureHandlerGestureEvent,
} from "react-native-gesture-handler";

const { width: screenWidth } = Dimensions.get("window");
const THUMBNAIL_SIZE = (screenWidth - 60) / 2; // 2 columns with padding

interface SegmentThumbnailProps {
  segment: {
    id: string;
    uri: string;
    duration: number;
  };
  index: number;
  onDragStart: (index: number) => void;
  onDragEnd: (fromIndex: number, toIndex: number) => void;
  isDragging: boolean;
  draggedIndex: number | null;
}

export default function SegmentThumbnail({
  segment,
  index,
  onDragStart,
  onDragEnd,
  isDragging,
  draggedIndex,
}: SegmentThumbnailProps) {
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Animation values
  const translateX = useSharedValue(0);
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
          time: 1000, // 1 second into the video
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
  const gestureHandler = useAnimatedGestureHandler<
    PanGestureHandlerGestureEvent,
    { startX: number; startY: number }
  >({
    onStart: (_, context) => {
      context.startX = translateX.value;
      context.startY = translateY.value;
      zIndex.value = 1000;
      scale.value = withSpring(1.1);
      runOnJS(onDragStart)(index);
    },
    onActive: (event, context) => {
      translateX.value = context.startX + event.translationX;
      translateY.value = context.startY + event.translationY;
    },
    onEnd: () => {
      // Calculate drop target based on position
      const targetIndex = Math.round(
        (translateY.value + THUMBNAIL_SIZE / 2) / THUMBNAIL_SIZE
      );

      // Reset position
      translateX.value = withSpring(0);
      translateY.value = withSpring(0);
      scale.value = withSpring(1);
      zIndex.value = 0;

      runOnJS(onDragEnd)(index, Math.max(0, targetIndex));
    },
  });

  // Animated styles
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
    zIndex: zIndex.value,
  }));

  const containerStyle = useAnimatedStyle(() => ({
    opacity: isDragTarget ? 0.5 : 1,
  }));

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <Animated.View style={[styles.container, containerStyle]}>
      <PanGestureHandler onGestureEvent={gestureHandler}>
        <Animated.View style={[styles.thumbnailContainer, animatedStyle]}>
          <View style={styles.thumbnailWrapper}>
            {isLoading ? (
              <View style={styles.loadingContainer}>
                <MaterialIcons name="video-library" size={32} color="#666" />
              </View>
            ) : thumbnailUri ? (
              <Image source={{ uri: thumbnailUri }} style={styles.thumbnail} />
            ) : (
              <View style={styles.errorContainer}>
                <MaterialIcons name="error" size={32} color="#666" />
              </View>
            )}

            {/* Duration overlay */}
            <View style={styles.durationOverlay}>
              <ThemedText style={styles.durationText}>
                {formatDuration(segment.duration)}
              </ThemedText>
            </View>

            {/* Drag handle */}
            <View style={styles.dragHandle}>
              <MaterialIcons name="drag-indicator" size={20} color="#fff" />
            </View>
          </View>

          {/* Segment number */}
          <View style={styles.segmentNumber}>
            <ThemedText style={styles.segmentNumberText}>
              {index + 1}
            </ThemedText>
          </View>
        </Animated.View>
      </PanGestureHandler>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: THUMBNAIL_SIZE,
    marginBottom: 16,
  },
  thumbnailContainer: {
    position: "relative",
  },
  thumbnailWrapper: {
    position: "relative",
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#333",
  },
  thumbnail: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE * 0.75, // 4:3 aspect ratio
    resizeMode: "cover",
  },
  loadingContainer: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE * 0.75,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#222",
  },
  errorContainer: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE * 0.75,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#222",
  },
  durationOverlay: {
    position: "absolute",
    bottom: 8,
    right: 8,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  durationText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
    fontFamily: "Roboto-Bold",
  },
  dragHandle: {
    position: "absolute",
    top: 8,
    left: 8,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    padding: 4,
    borderRadius: 4,
  },
  segmentNumber: {
    position: "absolute",
    top: -8,
    right: -8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#ff0000",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#000",
  },
  segmentNumberText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
    fontFamily: "Roboto-Bold",
  },
});

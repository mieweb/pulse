import { MaterialIcons } from "@expo/vector-icons";
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Dimensions,
  Image,
  TouchableOpacity,
  PanResponder,
  ActivityIndicator,
  GestureResponderEvent,
} from "react-native";
import { generateVideoThumbnail } from "@/utils/videoThumbnails";
import { formatTimeMs } from "@/utils/timeFormat";

const SCREEN_WIDTH = Dimensions.get("window").width;
const THUMBNAIL_WIDTH = 60;
const THUMBNAIL_HEIGHT = 80;
const HANDLE_WIDTH = 40;
const TIMELINE_PADDING = 20;
const MIN_TRIM_GAP_MS = 100; // Minimum gap between trim handles
const MIN_THUMBNAILS = 8;
const THUMBNAIL_INTERVAL_SECONDS = 2;

interface VideoTrimScrubberProps {
  videoUri: string;
  videoDuration: number; // in seconds
  initialInMs?: number;
  initialOutMs?: number;
  onTrimChange?: (inMs: number, outMs: number) => void;
  onSplit?: (splitMs: number) => void;
  onSeek?: (timeMs: number) => void;
}

export default function VideoTrimScrubber({
  videoUri,
  videoDuration,
  initialInMs = 0,
  initialOutMs,
  onTrimChange,
  onSplit,
  onSeek,
}: VideoTrimScrubberProps) {
  const videoDurationMs = videoDuration * 1000;
  const effectiveOutMs = initialOutMs ?? videoDurationMs;

  const [inMs, setInMs] = useState(initialInMs);
  const [outMs, setOutMs] = useState(effectiveOutMs);
  const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);
  const [isLoadingThumbnails, setIsLoadingThumbnails] = useState(true);
  const [splitMode, setSplitMode] = useState(false);
  const [splitMs, setSplitMs] = useState<number | null>(null);

  const scrollViewRef = useRef<ScrollView>(null);
  const [timelineWidth, setTimelineWidth] = useState(0);

  // Calculate number of thumbnails based on video duration
  const thumbnailCount = Math.max(
    MIN_THUMBNAILS,
    Math.ceil(videoDuration / THUMBNAIL_INTERVAL_SECONDS)
  );

  // Generate thumbnails on mount
  useEffect(() => {
    const loadThumbnails = async () => {
      setIsLoadingThumbnails(true);
      const thumbs: (string | null)[] = [];

      for (let i = 0; i < thumbnailCount; i++) {
        const timeMs = (videoDurationMs / thumbnailCount) * i;
        try {
          const uri = await generateVideoThumbnail(videoUri, {
            time: timeMs,
            quality: 0.7,
          });
          thumbs.push(uri);
        } catch (error) {
          console.error("Failed to generate thumbnail:", error);
          thumbs.push(null);
        }
      }

      setThumbnails(thumbs);
      setIsLoadingThumbnails(false);
    };

    loadThumbnails();
  }, [videoUri, videoDurationMs, thumbnailCount]);

  // Calculate timeline width based on thumbnail count
  useEffect(() => {
    const width = thumbnailCount * THUMBNAIL_WIDTH;
    setTimelineWidth(width);
  }, [thumbnailCount]);

  // Convert ms to position on timeline
  const msToPosition = useCallback(
    (ms: number) => {
      return (ms / videoDurationMs) * timelineWidth;
    },
    [videoDurationMs, timelineWidth]
  );

  // Convert position to ms
  const positionToMs = useCallback(
    (position: number) => {
      const ms = (position / timelineWidth) * videoDurationMs;
      return Math.max(0, Math.min(videoDurationMs, ms));
    },
    [videoDurationMs, timelineWidth]
  );

  // Handle in point drag
  const inHandlePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_, gestureState) => {
          const currentInPosition = msToPosition(inMs);
          const newPosition = currentInPosition + gestureState.dx;
          const newInMs = positionToMs(newPosition);

          // Ensure in point doesn't exceed out point
          if (newInMs < outMs - MIN_TRIM_GAP_MS) {
            setInMs(newInMs);
            onSeek?.(newInMs);
          }
        },
        onPanResponderRelease: () => {
          onTrimChange?.(inMs, outMs);
        },
      }),
    [inMs, outMs, msToPosition, positionToMs, onSeek, onTrimChange]
  );

  // Handle out point drag
  const outHandlePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_, gestureState) => {
          const currentOutPosition = msToPosition(outMs);
          const newPosition = currentOutPosition + gestureState.dx;
          const newOutMs = positionToMs(newPosition);

          // Ensure out point doesn't go before in point
          if (newOutMs > inMs + MIN_TRIM_GAP_MS) {
            setOutMs(newOutMs);
            onSeek?.(newOutMs);
          }
        },
        onPanResponderRelease: () => {
          onTrimChange?.(inMs, outMs);
        },
      }),
    [inMs, outMs, msToPosition, positionToMs, onSeek, onTrimChange]
  );

  // Handle timeline tap for split
  const handleTimelineTap = (event: GestureResponderEvent) => {
    if (!splitMode) return;

    const { locationX } = event.nativeEvent;
    const newSplitMs = positionToMs(locationX);

    // Ensure split is within trim bounds
    if (newSplitMs >= inMs && newSplitMs <= outMs) {
      setSplitMs(newSplitMs);
    }
  };

  const handleSplitConfirm = () => {
    if (splitMs !== null) {
      onSplit?.(splitMs);
      setSplitMs(null);
      setSplitMode(false);
    }
  };

  const handleSplitCancel = () => {
    setSplitMs(null);
    setSplitMode(false);
  };

  const trimmedDuration = outMs - inMs;

  return (
    <View style={styles.container}>
      {/* Duration and time display */}
      <View style={styles.timeDisplay}>
        <View style={styles.timeItem}>
          <Text style={styles.timeLabel}>In</Text>
          <Text style={styles.timeValue}>{formatTimeMs(inMs)}</Text>
        </View>
        <View style={styles.timeItem}>
          <Text style={styles.timeLabel}>Duration</Text>
          <Text style={styles.timeValue}>{formatTimeMs(trimmedDuration)}</Text>
        </View>
        <View style={styles.timeItem}>
          <Text style={styles.timeLabel}>Out</Text>
          <Text style={styles.timeValue}>{formatTimeMs(outMs)}</Text>
        </View>
      </View>

      {/* Timeline with thumbnails */}
      <View style={styles.timelineContainer}>
        {isLoadingThumbnails ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#ff0000" />
            <Text style={styles.loadingText}>Loading timeline...</Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollViewRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: TIMELINE_PADDING,
            }}
            style={styles.scrollView}
          >
            <View
              style={[styles.timeline, { width: timelineWidth }]}
              onStartShouldSetResponder={() => splitMode}
              onResponderRelease={handleTimelineTap}
            >
              {/* Thumbnail strip */}
              <View style={styles.thumbnailStrip}>
                {thumbnails.map((thumb, index) => (
                  <View key={index} style={styles.thumbnailWrapper}>
                    {thumb ? (
                      <Image
                        source={{ uri: thumb }}
                        style={styles.thumbnail}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={styles.thumbnailPlaceholder}>
                        <MaterialIcons
                          name="video-library"
                          size={20}
                          color="#666"
                        />
                      </View>
                    )}
                  </View>
                ))}
              </View>

              {/* Overlay for non-selected regions */}
              <View
                style={[
                  styles.overlay,
                  styles.overlayLeft,
                  { width: msToPosition(inMs) },
                ]}
              />
              <View
                style={[
                  styles.overlay,
                  styles.overlayRight,
                  {
                    left: msToPosition(outMs),
                    width: timelineWidth - msToPosition(outMs),
                  },
                ]}
              />

              {/* Selection highlight */}
              <View
                style={[
                  styles.selectionHighlight,
                  {
                    left: msToPosition(inMs),
                    width: msToPosition(outMs) - msToPosition(inMs),
                  },
                ]}
              />

              {/* In handle */}
              <View
                {...inHandlePanResponder.panHandlers}
                style={[
                  styles.handle,
                  styles.handleLeft,
                  { left: msToPosition(inMs) - HANDLE_WIDTH / 2 },
                ]}
              >
                <View style={styles.handleBar} />
                <MaterialIcons name="arrow-right" size={24} color="#fff" />
              </View>

              {/* Out handle */}
              <View
                {...outHandlePanResponder.panHandlers}
                style={[
                  styles.handle,
                  styles.handleRight,
                  { left: msToPosition(outMs) - HANDLE_WIDTH / 2 },
                ]}
              >
                <MaterialIcons name="arrow-left" size={24} color="#fff" />
                <View style={styles.handleBar} />
              </View>

              {/* Split indicator */}
              {splitMode && splitMs !== null && (
                <View
                  style={[
                    styles.splitIndicator,
                    { left: msToPosition(splitMs) },
                  ]}
                >
                  <View style={styles.splitLine} />
                  <View style={styles.splitHandle}>
                    <MaterialIcons name="content-cut" size={20} color="#fff" />
                  </View>
                </View>
              )}
            </View>
          </ScrollView>
        )}
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        {!splitMode ? (
          <>
            <TouchableOpacity
              style={styles.controlButton}
              onPress={() => {
                setInMs(0);
                setOutMs(videoDurationMs);
                onTrimChange?.(0, videoDurationMs);
              }}
            >
              <MaterialIcons name="refresh" size={24} color="#fff" />
              <Text style={styles.controlButtonText}>Reset</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.controlButton, styles.primaryButton]}
              onPress={() => setSplitMode(true)}
            >
              <MaterialIcons name="content-cut" size={24} color="#fff" />
              <Text style={styles.controlButtonText}>Split</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity
              style={styles.controlButton}
              onPress={handleSplitCancel}
            >
              <MaterialIcons name="close" size={24} color="#fff" />
              <Text style={styles.controlButtonText}>Cancel</Text>
            </TouchableOpacity>

            <Text style={styles.splitHint}>
              {splitMs !== null
                ? `Split at ${formatTimeMs(splitMs)}`
                : "Tap timeline to set split point"}
            </Text>

            <TouchableOpacity
              style={[
                styles.controlButton,
                styles.primaryButton,
                splitMs === null && styles.disabledButton,
              ]}
              onPress={handleSplitConfirm}
              disabled={splitMs === null}
            >
              <MaterialIcons name="check" size={24} color="#fff" />
              <Text style={styles.controlButtonText}>Confirm</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  timeDisplay: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 16,
    paddingHorizontal: 20,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  timeItem: {
    alignItems: "center",
  },
  timeLabel: {
    color: "#999",
    fontSize: 12,
    fontFamily: "Roboto-Regular",
    marginBottom: 4,
  },
  timeValue: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    fontFamily: "Roboto-Bold",
  },
  timelineContainer: {
    flex: 1,
    paddingVertical: 20,
  },
  scrollView: {
    flex: 1,
  },
  timeline: {
    height: THUMBNAIL_HEIGHT + 60, // Extra space for handles
    position: "relative",
  },
  thumbnailStrip: {
    flexDirection: "row",
    height: THUMBNAIL_HEIGHT,
  },
  thumbnailWrapper: {
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    borderRightWidth: 1,
    borderRightColor: "rgba(255, 255, 255, 0.2)",
  },
  thumbnail: {
    width: "100%",
    height: "100%",
  },
  thumbnailPlaceholder: {
    width: "100%",
    height: "100%",
    backgroundColor: "#333",
    justifyContent: "center",
    alignItems: "center",
  },
  overlay: {
    position: "absolute",
    top: 0,
    height: THUMBNAIL_HEIGHT,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
  },
  overlayLeft: {
    left: 0,
  },
  overlayRight: {
    right: 0,
  },
  selectionHighlight: {
    position: "absolute",
    top: 0,
    height: THUMBNAIL_HEIGHT,
    borderTopWidth: 3,
    borderBottomWidth: 3,
    borderColor: "#ff0000",
  },
  handle: {
    position: "absolute",
    top: 0,
    width: HANDLE_WIDTH,
    height: THUMBNAIL_HEIGHT,
    backgroundColor: "#ff0000",
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 4,
    zIndex: 10,
  },
  handleLeft: {
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
  },
  handleRight: {
    borderTopLeftRadius: 8,
    borderBottomLeftRadius: 8,
  },
  handleBar: {
    width: 4,
    height: 30,
    backgroundColor: "#fff",
    borderRadius: 2,
    position: "absolute",
  },
  splitIndicator: {
    position: "absolute",
    top: -10,
    width: 2,
    height: THUMBNAIL_HEIGHT + 20,
    alignItems: "center",
    zIndex: 5,
  },
  splitLine: {
    width: 2,
    flex: 1,
    backgroundColor: "#ffeb3b",
  },
  splitHandle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#ffeb3b",
    justifyContent: "center",
    alignItems: "center",
    marginTop: -18,
  },
  controls: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    paddingVertical: 20,
    paddingHorizontal: 20,
    backgroundColor: "rgba(0, 0, 0, 0.9)",
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.1)",
  },
  controlButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    gap: 8,
  },
  primaryButton: {
    backgroundColor: "#ff0000",
  },
  disabledButton: {
    backgroundColor: "#666",
    opacity: 0.5,
  },
  controlButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "Roboto-Bold",
  },
  splitHint: {
    flex: 1,
    color: "#ffeb3b",
    fontSize: 12,
    fontFamily: "Roboto-Regular",
    textAlign: "center",
    paddingHorizontal: 10,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "#fff",
    fontSize: 14,
    fontFamily: "Roboto-Regular",
    marginTop: 12,
  },
});

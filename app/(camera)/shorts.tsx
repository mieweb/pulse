import CameraControls from "@/components/CameraControls";
import CloseButton from "@/components/CloseButton";
import UploadCloseButton from "@/components/UploadCloseButton";
import RecordButton from "@/components/RecordButton";
import RecordingProgressBar, {
  RecordingSegment,
} from "@/components/RecordingProgressBar";
import RedoSegmentButton from "@/components/RedoSegmentButton";
import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import TimeSelectorButton from "@/components/TimeSelectorButton";
import UndoSegmentButton from "@/components/UndoSegmentButton";
import * as ImagePicker from "expo-image-picker";
import { useDraftManager } from "@/hooks/useDraftManager";
import { useVideoStabilization } from "@/hooks/useVideoStabilization";
import { useCameraFacing } from "@/hooks/useCameraFacing";
import {
  VideoStabilization,
  mapToNativeVideoStabilization,
} from "@/constants/camera";
import { getExactFullDuration } from "@/utils/durationUtils";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { CameraType, CameraView } from "expo-camera";
import { router, useLocalSearchParams } from "expo-router";
import * as React from "react";
import {
  Alert,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import {
  PanGestureHandler,
  PinchGestureHandler,
} from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedGestureHandler,
  useSharedValue,
} from "react-native-reanimated";

/**
 * Shorts recording screen - main camera interface for creating segmented videos.
 *
 * Features:
 * - Segmented video recording with tap/hold controls
 * - Pinch-to-zoom camera view
 * - Camera controls (flip, flash)
 * - Draft auto-save with undo/redo
 * - Time selector for recording duration
 */
export default function ShortsScreen() {
  const { draftId, mode } = useLocalSearchParams<{
    draftId?: string;
    mode?: string;
  }>();
  const draftMode = (mode === "upload" ? "upload" : "camera") as
    | "camera"
    | "upload";
  const cameraRef = React.useRef<CameraView>(null);
  const [selectedDuration, setSelectedDuration] = React.useState(60);
  const [currentRecordingDuration, setCurrentRecordingDuration] =
    React.useState(0);

  // Use the draft manager hook
  const {
    recordingSegments,
    redoStack,
    currentDraftId,
    hasStartedOver,
    isContinuingLastDraft,
    showContinuingIndicator,
    loadedDuration,
    currentDraftName,
    handleStartOver,
    handleStartNew,
    handleSaveAsDraft,
    handleClose,
    handleUndoSegment,
    handleRedoSegment,
    updateSegmentsAfterRecording,
    updateDraftDuration,
    setRecordingSegments,
  } = useDraftManager(draftId, selectedDuration, draftMode);

  // Camera control states
  const { cameraFacing, updateCameraFacing } = useCameraFacing();
  const [torchEnabled, setTorchEnabled] = React.useState(false);
  const [isCameraSwitching, setIsCameraSwitching] = React.useState(false);
  const previousCameraFacingRef = React.useRef<CameraType>(cameraFacing);
  const { videoStabilizationMode, updateVideoStabilizationMode } =
    useVideoStabilization();

  // Recording state
  const [isRecording, setIsRecording] = React.useState(false);

  // Screen-level touch state for continuous hold recording
  const [screenTouchActive, setScreenTouchActive] = React.useState(false);
  const [_buttonPressActive, setButtonPressActive] = React.useState(false); // eslint-disable-line @typescript-eslint/no-unused-vars

  // Zoom state
  const [zoom, setZoom] = React.useState(0);
  const savedZoom = useSharedValue(0);
  const currentZoom = useSharedValue(0);

  // Drag-to-zoom state
  const initialTouchY = useSharedValue(0);
  const currentTouchY = useSharedValue(0);
  const isHoldRecording = useSharedValue(false);
  const recordingModeShared = useSharedValue("");

  // Calculate total duration accounting for trimmed segments
  const totalUsedDuration = recordingSegments.reduce((total, segment) => {
    if (segment.inMs !== undefined || segment.outMs !== undefined) {
      const start = segment.inMs || 0;
      const end = segment.outMs || segment.duration * 1000;
      return total + (end - start) / 1000; // Convert ms to seconds
    }
    return total + segment.duration;
  }, 0);

  const handleRecordingStart = (
    mode: "tap" | "hold",
    remainingTime: number
  ) => {
    setCurrentRecordingDuration(0);
    setIsRecording(true);

    // Update shared values for gesture handler
    isHoldRecording.value = true;
    recordingModeShared.value = mode;
  };

  const handleRecordingProgress = (
    currentDuration: number,
    remainingTime: number
  ) => {
    setCurrentRecordingDuration(currentDuration);
  };

  const handleRecordingComplete = async (
    videoUri: string | null,
    mode: "tap" | "hold",
    duration: number
  ) => {
    setCurrentRecordingDuration(0);
    setIsRecording(false);

    // Reset shared values
    isHoldRecording.value = false;
    recordingModeShared.value = "";

    if (videoUri && duration > 0) {
      const newSegment: RecordingSegment = {
        id: Date.now().toString(),
        duration: duration,
        uri: videoUri,
      };

      await updateSegmentsAfterRecording(newSegment, selectedDuration);
    }
  };

  // Restore loaded duration when draft is loaded
  React.useEffect(() => {
    if (loadedDuration !== null && loadedDuration !== selectedDuration) {
      setSelectedDuration(loadedDuration);
    }
  }, [loadedDuration, selectedDuration]);

  // Sync previousCameraFacing ref when cameraFacing changes
  React.useEffect(() => {
    previousCameraFacingRef.current = cameraFacing;
  }, [cameraFacing]);

  useFocusEffect(
    React.useCallback(() => {
      const reloadDraft = async () => {
        const draftToReload = draftId || currentDraftId;
        if (draftToReload) {
          try {
            const draft = await DraftStorage.getDraftById(
              draftToReload,
              "camera"
            );
            if (draft && draft.segments) {
              const segmentsWithAbsolutePaths =
                fileStore.convertSegmentsToAbsolute(draft.segments);
              setRecordingSegments(segmentsWithAbsolutePaths);
            }
          } catch (error) {
            console.error("Failed to reload draft on focus:", error);
          }
        }
      };
      reloadDraft();
    }, [draftId, currentDraftId, setRecordingSegments])
  );

  const handleTimeSelect = (timeInSeconds: number) => {
    // Check if current segments exceed the new duration limit
    const currentTotalDuration = recordingSegments.reduce((total, seg) => {
      if (seg.inMs !== undefined || seg.outMs !== undefined) {
        const start = seg.inMs || 0;
        const end = seg.outMs || seg.duration * 1000;
        return total + (end - start) / 1000; // Convert ms to seconds
      }
      return total + seg.duration;
    }, 0);

    if (currentTotalDuration > timeInSeconds) {
      Alert.alert(
        "Duration Too Low",
        `Current segments (${Math.round(
          currentTotalDuration
        )}s) exceed ${timeInSeconds}s limit. Undo segments first.`,
        [{ text: "OK", style: "default" }]
      );
      return;
    }

    setSelectedDuration(timeInSeconds);
    // Immediately update the draft with the new duration
    updateDraftDuration(timeInSeconds);
  };

  const handleFlipCamera = () => {
    setIsCameraSwitching(true);
    // Reset zoom when switching cameras
    setZoom(0);
    savedZoom.value = 0;
    currentZoom.value = 0;

    const newFacing = cameraFacing === "back" ? "front" : "back";
    if (newFacing === "front") {
      setTorchEnabled(false);
    }

    updateCameraFacing(newFacing);

    setTimeout(() => {
      setIsCameraSwitching(false);
    }, 300);
  };

  const handleTorchToggle = () => {
    setTorchEnabled((current) => !current);
  };

  const handleVideoStabilizationChange = (mode: VideoStabilization) => {
    updateVideoStabilizationMode(mode);
  };

  const handlePreview = () => {
    if (currentDraftId && recordingSegments.length > 0) {
      router.push({
        pathname: "/preview",
        params: { draftId: currentDraftId },
      });
    }
  };

  const handleEditSegments = () => {
    if (currentDraftId) {
      router.push({
        pathname: "/reordersegments",
        params: { draftId: currentDraftId },
      });
    }
  };

  const handleSaveAsDraftWrapper = async (
    segments: RecordingSegment[],
    options?: { forceNew?: boolean }
  ) => {
    await handleSaveAsDraft(segments, selectedDuration, options);
  };

  const handleUndoSegmentWrapper = async () => {
    await handleUndoSegment(selectedDuration);
  };

  const handleRedoSegmentWrapper = async () => {
    await handleRedoSegment(selectedDuration);
  };

  // Button touch coordination handlers
  const handleButtonTouchStart = () => {
    setButtonPressActive(true);
  };

  const handleButtonTouchEnd = () => {
    setButtonPressActive(false);
  };

  // Screen-level touch handler for continuous hold recording with drag-to-zoom
  const handleScreenPanGesture = useAnimatedGestureHandler({
    onStart: (event) => {
      runOnJS(setScreenTouchActive)(true);
      // Store initial touch position for zoom calculation
      initialTouchY.value = event.y;
      currentTouchY.value = event.y;
    },
    onActive: (event) => {
      currentTouchY.value = event.y;

      // Only apply zoom during hold recording
      if (isHoldRecording.value && recordingModeShared.value === "hold") {
        const deltaY = initialTouchY.value - event.y; // Negative = down, Positive = up

        // Convert pixel movement to zoom change with same sensitivity as pinch
        // Scale factor adjusted for touch movement (roughly 300px = full zoom range)
        const zoomChange =
          deltaY >= 0
            ? deltaY * 0.0013 // Drag up = zoom in (similar to pinch 0.4x sensitivity)
            : deltaY * 0.0023; // Drag down = zoom out (similar to pinch 0.7x sensitivity)

        const newZoom = Math.min(
          0.5,
          Math.max(0, savedZoom.value + zoomChange)
        );
        currentZoom.value = newZoom;
        runOnJS(setZoom)(newZoom);
      }
    },
    onEnd: () => {
      runOnJS(setScreenTouchActive)(false);
      // Save final zoom value when gesture ends
      if (isHoldRecording.value && recordingModeShared.value === "hold") {
        savedZoom.value = currentZoom.value;
      }
    },
    onCancel: () => {
      runOnJS(setScreenTouchActive)(false);
      // Save zoom state on cancel too
      if (isHoldRecording.value && recordingModeShared.value === "hold") {
        savedZoom.value = currentZoom.value;
      }
    },
    onFail: () => {
      runOnJS(setScreenTouchActive)(false);
      // Save zoom state on fail too
      if (isHoldRecording.value && recordingModeShared.value === "hold") {
        savedZoom.value = currentZoom.value;
      }
    },
  });

  const handleCloseWrapper = async () => {
    await handleClose();
    router.push("/(tabs)");
  };

  const handleAddVideoFromLibrary = async () => {
    try {
      // Launch the native video picker directly
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["videos"],
        allowsEditing: true, // Allow trimming
        quality: 1, // Full quality
        videoMaxDuration: 300, // 5 minutes max
        allowsMultipleSelection: false,
        exif: false, // Don't include EXIF data
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];

        // Get exact duration from AVFoundation instead of approximate metadata duration
        let actualDuration = 0;
        try {
          actualDuration = await getExactFullDuration(asset.uri);
          console.log(
            `[Library Import] Exact duration from AVFoundation: ${actualDuration}s`
          );
        } catch (error) {
          console.warn(
            "[Library Import] Failed to get exact duration, using metadata:",
            error
          );
          // Fallback to metadata duration if AVFoundation fails
          if (asset.duration) {
            actualDuration =
              asset.duration > 1000 ? asset.duration / 1000 : asset.duration;
          }
        }

        // Check if adding this video would exceed the total duration limit
        const currentTotalDuration = recordingSegments.reduce((total, seg) => {
          if (seg.inMs !== undefined || seg.outMs !== undefined) {
            const start = seg.inMs || 0;
            const end = seg.outMs || seg.duration * 1000;
            return total + (end - start) / 1000; // Convert ms to seconds
          }
          return total + seg.duration;
        }, 0);
        const newTotalDuration = currentTotalDuration + actualDuration;

        if (newTotalDuration > selectedDuration) {
          const remainingTime = selectedDuration - currentTotalDuration;
          Alert.alert(
            "Video Too Long",
            `Video (${Math.round(
              actualDuration
            )}s) exceeds ${selectedDuration}s limit. Remaining: ${Math.round(
              remainingTime
            )}s`,
            [{ text: "OK" }]
          );
          return;
        }

        // Create a recording segment from the selected video with exact duration
        const segment: RecordingSegment = {
          id: Date.now().toString(),
          uri: asset.uri,
          duration: actualDuration,
        };

        // Add the segment to the current recording
        await updateSegmentsAfterRecording(segment, selectedDuration);

        console.log("Video added from library:", asset.uri);
      }
    } catch (error) {
      console.error("Video selection failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to select video";
      Alert.alert("Error", errorMessage);
    }
  };

  return (
    <ThemedView style={styles.container}>
      <PanGestureHandler onGestureEvent={handleScreenPanGesture}>
        <Animated.View style={{ flex: 1 }}>
          <PinchGestureHandler
            onGestureEvent={useAnimatedGestureHandler({
              onStart: () => {
                currentZoom.value = savedZoom.value;
              },
              onActive: (event) => {
                const scaleChange = event.scale - 1;

                // Asymmetric sensitivity compensates for scale math limitations
                const zoomChange =
                  scaleChange >= 0
                    ? scaleChange * 0.4 // Zoom in
                    : scaleChange * 0.7; // Zoom out (more sensitive)

                const newZoom = Math.min(
                  0.5,
                  Math.max(0, savedZoom.value + zoomChange)
                );
                currentZoom.value = newZoom;
                runOnJS(setZoom)(newZoom);
              },
              onEnd: () => {
                savedZoom.value = currentZoom.value;
              },
            })}
          >
            <Animated.View style={{ flex: 1 }}>
              <CameraView
                ref={cameraRef}
                style={styles.camera}
                mode="video"
                facing={cameraFacing}
                enableTorch={torchEnabled}
                zoom={zoom}
                {...(Platform.OS === "ios"
                  ? {
                      videoStabilizationMode: mapToNativeVideoStabilization(
                        videoStabilizationMode
                      ),
                    }
                  : {})}
              />
            </Animated.View>
          </PinchGestureHandler>

          {!isRecording && (
            <CameraControls
              onFlipCamera={handleFlipCamera}
              onFlashToggle={handleTorchToggle}
              torchEnabled={torchEnabled}
              cameraFacing={
                isCameraSwitching
                  ? previousCameraFacingRef.current
                  : cameraFacing
              }
              videoStabilizationMode={videoStabilizationMode}
              onVideoStabilizationChange={handleVideoStabilizationChange}
              onEditSegments={
                recordingSegments.length > 0 ? handleEditSegments : undefined
              }
            />
          )}

          {/* Video Library Button */}
          {!isRecording && (
            <TouchableOpacity
              style={styles.videoLibraryButton}
              onPress={handleAddVideoFromLibrary}
              activeOpacity={0.7}
            >
              <MaterialIcons name="add" size={26} color="black" />
            </TouchableOpacity>
          )}

          {showContinuingIndicator && (
            <View style={styles.continuingDraftIndicator}>
              <ThemedText style={styles.continuingDraftText}>
                Continuing last draft
              </ThemedText>
            </View>
          )}

          {!isRecording && (
            <View style={styles.timeSelectorContainer}>
              <TimeSelectorButton
                onTimeSelect={handleTimeSelect}
                selectedTime={selectedDuration}
              />
            </View>
          )}

          <RecordingProgressBar
            segments={recordingSegments}
            totalDuration={selectedDuration}
            currentRecordingDuration={currentRecordingDuration}
          />

          <View style={styles.recordingTimeContainer}>
            {currentDraftName && (
              <>
                <ThemedText
                  style={styles.draftNameText}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  accessibilityLabel={`Draft name: ${currentDraftName}`}
                >
                  {currentDraftName}
                </ThemedText>
                <ThemedText style={styles.separatorText}>•</ThemedText>
              </>
            )}
            <ThemedText style={styles.recordingTimeText}>
              {(() => {
                const totalSeconds = Math.floor(
                  totalUsedDuration + currentRecordingDuration
                );
                const minutes = Math.floor(totalSeconds / 60);
                const seconds = totalSeconds % 60;
                return `${minutes}:${seconds.toString().padStart(2, "0")}`;
              })()}
            </ThemedText>
          </View>

          {!isRecording &&
            (draftMode === "upload" ? (
              <UploadCloseButton
                segments={recordingSegments}
                onStartOver={handleStartOver}
                hasStartedOver={hasStartedOver}
                onClose={handleCloseWrapper}
              />
            ) : (
              <CloseButton
                segments={recordingSegments}
                onStartOver={handleStartOver}
                onStartNew={handleStartNew}
                onSaveAsDraft={handleSaveAsDraftWrapper}
                hasStartedOver={hasStartedOver}
                onClose={handleCloseWrapper}
                isContinuingLastDraft={isContinuingLastDraft}
              />
            ))}

          <RecordButton
            cameraRef={cameraRef}
            maxDuration={180}
            totalDuration={selectedDuration}
            usedDuration={totalUsedDuration}
            holdDelay={300}
            onRecordingStart={handleRecordingStart}
            onRecordingProgress={handleRecordingProgress}
            onRecordingComplete={handleRecordingComplete}
            onButtonTouchStart={handleButtonTouchStart}
            onButtonTouchEnd={handleButtonTouchEnd}
            screenTouchActive={screenTouchActive}
          />

          {recordingSegments.length > 0 && !isRecording && (
            <UndoSegmentButton onUndoSegment={handleUndoSegmentWrapper} />
          )}

          {redoStack.length > 0 && !isRecording && (
            <RedoSegmentButton onRedoSegment={handleRedoSegmentWrapper} />
          )}

          {recordingSegments.length > 0 && currentDraftId && !isRecording && (
            <TouchableOpacity
              style={styles.previewButton}
              onPress={handlePreview}
            >
              <MaterialIcons name="done" size={26} color="black" />
            </TouchableOpacity>
          )}
        </Animated.View>
      </PanGestureHandler>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  camera: {
    flex: 1,
  },
  continuingDraftIndicator: {
    position: "absolute",
    top: "70%",
    left: 50,
    right: 50,
    zIndex: 10,
  },
  continuingDraftText: {
    color: "#ffffff",
    fontSize: 14,
    textAlign: "center",
    fontFamily: "Roboto-Regular",
  },
  timeSelectorContainer: {
    position: "absolute",
    top: 80,
    right: 25,
    zIndex: 10,
  },
  previewButton: {
    position: "absolute",
    bottom: 40,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  recordingTimeContainer: {
    position: "absolute",
    top: 90,
    left: 0,
    right: 0,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    zIndex: 10,
  },
  draftNameText: {
    color: "#ffffff",
    fontSize: 16,
    fontFamily: "Roboto-Regular",
    textShadowColor: "rgba(0, 0, 0, 0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
    marginRight: 8,
  },
  separatorText: {
    color: "#ffffff",
    fontSize: 16,
    fontFamily: "Roboto-Regular",
    textShadowColor: "rgba(0, 0, 0, 0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
    marginRight: 8,
    opacity: 0.7,
  },
  recordingTimeText: {
    color: "#ffffff",
    fontSize: 18,
    fontFamily: "Roboto-Bold",
    textShadowColor: "rgba(0, 0, 0, 0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  videoLibraryButton: {
    position: "absolute",
    bottom: 40,
    right: 80, // Position to the left of the preview button
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
});

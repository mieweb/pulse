import CameraControls from "@/components/CameraControls";
import RecordButton from "@/components/RecordButton";
import RecordingProgressBar, {
  RecordingSegment,
} from "@/components/RecordingProgressBar";
import RedoSegmentButton from "@/components/RedoSegmentButton";
import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import TimeSelectorButton from "@/components/TimeSelectorButton";
import UndoSegmentButton from "@/components/UndoSegmentButton";
import UploadCloseButton from "@/components/UploadCloseButton";
import * as ImagePicker from "expo-image-picker";
import * as VideoThumbnails from "expo-video-thumbnails";
import { useDraftManager } from "@/hooks/useDraftManager";
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
import {
  PanGestureHandler,
  PinchGestureHandler,
} from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedGestureHandler,
  useSharedValue,
} from "react-native-reanimated";
import {
  VideoStabilization,
  mapToNativeVideoStabilization,
} from "@/constants/camera";

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
export default function UploadScreen() {
  const { draftId } = useLocalSearchParams<{
    draftId: string;
  }>();
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
    isContinuingLastDraft: _isContinuingLastDraft, // eslint-disable-line @typescript-eslint/no-unused-vars
    showContinuingIndicator,
    loadedDuration,
    handleStartOver,
    handleClose,
    handleUndoSegment,
    handleRedoSegment,
    updateSegmentsAfterRecording,
    updateDraftDuration,
  } = useDraftManager(draftId, selectedDuration, "upload");

  // Camera control states
  const [cameraFacing, setCameraFacing] = React.useState<CameraType>("back");
  const [torchEnabled, setTorchEnabled] = React.useState(false);
  const [isCameraSwitching, setIsCameraSwitching] = React.useState(false);
  const [previousCameraFacing, setPreviousCameraFacing] =
    React.useState<CameraType>("back");
  const [videoStabilizationMode, setVideoStabilizationMode] =
    React.useState<VideoStabilization>(VideoStabilization.off);

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

  const totalUsedDuration = recordingSegments.reduce(
    (total, segment) => total + segment.duration,
    0
  );

  // Auto-load the selected duration from the draft
  React.useEffect(() => {
    if (loadedDuration !== null && loadedDuration !== selectedDuration) {
      setSelectedDuration(loadedDuration);
    }
  }, [loadedDuration, selectedDuration]);

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

  const handleTimeSelect = (timeInSeconds: number) => {
    // Check if current segments exceed the new duration limit
    const currentTotalDuration = recordingSegments.reduce(
      (total, seg) => total + seg.duration,
      0
    );

    if (currentTotalDuration > timeInSeconds) {
      Alert.alert(
        "Duration Limit Too Low",
        `Your current segments (${Math.round(
          currentTotalDuration
        )}s) exceed the new duration limit of ${timeInSeconds}s.\n\nPlease undo some segments first to reduce the total duration.`,
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

    setCameraFacing((current) => {
      setPreviousCameraFacing(current);
      const newFacing = current === "back" ? "front" : "back";
      if (newFacing === "front") {
        setTorchEnabled(false);
      }

      setTimeout(() => {
        setIsCameraSwitching(false);
      }, 300);

      return newFacing;
    });
  };

  const handleTorchToggle = () => {
    setTorchEnabled((current) => !current);
  };

  const handleVideoStabilizationChange = (mode: VideoStabilization) => {
    setVideoStabilizationMode(mode);
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

  // Removed unused _handleSaveAsDraftWrapper

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
    router.push("/(camera)/drafts");
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

        // Get the actual video duration in seconds
        let actualDuration = 0;
        if (asset.duration) {
          // Convert from milliseconds to seconds if needed
          actualDuration =
            asset.duration > 1000 ? asset.duration / 1000 : asset.duration;
        }

        // Create a recording segment from the selected video
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
                isCameraSwitching ? previousCameraFacing : cameraFacing
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

          {isRecording && (
            <View style={styles.recordingTimeContainer}>
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
          )}

          {!isRecording && (
            <UploadCloseButton
              segments={recordingSegments}
              onStartOver={handleStartOver}
              hasStartedOver={hasStartedOver}
              onClose={handleCloseWrapper}
            />
          )}

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
    top: 78,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 10,
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

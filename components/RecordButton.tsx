import { CameraView } from "expo-camera";
import { setAudioModeAsync } from "expo-audio";
import * as React from "react";
import { Animated, StyleSheet, TouchableOpacity, View } from "react-native";
import VideoConcatModule from "@/modules/video-concat";

export interface RecordButtonRef {
  reset: () => void;
}

interface RecordButtonProps {
  cameraRef: React.RefObject<CameraView | null>;
  maxDuration?: number;
  onRecordingStart?: (mode: "tap" | "hold", remainingTime: number) => void;
  onRecordingComplete?: (
    videoUri: string | null,
    mode: "tap" | "hold",
    recordedDurationSeconds: number
  ) => void;
  onRecordingProgress?: (
    currentDuration: number,
    remainingTime: number
  ) => void;
  holdDelay?: number;
  style?: any;
  totalDuration: number;
  usedDuration: number;
  // New props for screen-level touch coordination
  onButtonTouchStart?: () => void;
  onButtonTouchEnd?: () => void;
  screenTouchActive?: boolean;
}

const RecordButton = React.forwardRef<RecordButtonRef, RecordButtonProps>(({
  cameraRef,
  maxDuration = 180,
  onRecordingStart,
  onRecordingComplete,
  onRecordingProgress,
  holdDelay = 500,
  style,
  totalDuration,
  usedDuration,
  // New props for screen-level touch coordination
  onButtonTouchStart,
  onButtonTouchEnd,
  screenTouchActive = false,
}, ref) => {
  const [isRecording, setIsRecording] = React.useState(false);
  const [recordingMode, setRecordingMode] = React.useState<
    "tap" | "hold" | null
  >(null);
  const [isHoldingForRecord, setIsHoldingForRecord] = React.useState(false);
  // Track if current recording session was initiated by this button
  const [buttonInitiatedRecording, setButtonInitiatedRecording] =
    React.useState(false);

  const scaleAnim = React.useRef(new Animated.Value(1)).current;
  const borderRadiusAnim = React.useRef(new Animated.Value(30)).current;
  const outerBorderScaleAnim = React.useRef(new Animated.Value(1)).current;
  const pulsingRef = React.useRef<Animated.CompositeAnimation | null>(null);
  const holdTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const pressStartTimeRef = React.useRef<number>(0);
  const recordingPromiseRef = React.useRef<Promise<any> | null>(null);
  const manuallyStoppedRef = React.useRef(false);
  const isHoldingRef = React.useRef(false);
  const buttonTouchActiveRef = React.useRef(false);
  const fingerMovedOffButtonRef = React.useRef(false);
  const initialTouchPositionRef = React.useRef<{ x: number; y: number } | null>(null);

  const recordingStartTimeRef = React.useRef<number>(0);
  const progressIntervalRef = React.useRef<ReturnType<
    typeof setInterval
  > | null>(null);

  const remainingTime = totalDuration - usedDuration;

  const getVideoDuration = async (uri: string): Promise<number> => {
    try {
      const startTime = Date.now();
      const duration = await Promise.race([
        VideoConcatModule.getDuration(uri),
        new Promise<number>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 500)
        )
      ]);
      const elapsed = Date.now() - startTime;
      console.log(`[RecordButton] Native duration: ${duration.toFixed(2)}s (${elapsed}ms)`);
      return duration;
    } catch (error) {
      const fallbackDuration = (Date.now() - recordingStartTimeRef.current) / 1000;
      console.warn(`[RecordButton] Native duration failed, using timestamp: ${fallbackDuration.toFixed(2)}s`, error);
      return fallbackDuration;
    }
  };

  React.useEffect(() => {
    if (
      !screenTouchActive &&
      !buttonTouchActiveRef.current &&
      buttonInitiatedRecording &&
      isRecording &&
      recordingMode === "hold"
    ) {
      stopRecording();
      stopHoldVisualFeedback();
      setButtonInitiatedRecording(false);
    }
  }, [screenTouchActive, buttonInitiatedRecording, isRecording, recordingMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const startRecording = async (mode: "tap" | "hold") => {
    if (!cameraRef.current || isRecording || remainingTime <= 0) return;

    // Configure audio session for better interruption handling
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: "doNotMix", // Request exclusive audio focus
        shouldPlayInBackground: false, // Don't play in background
      });
      console.log("[RecordButton] ✅ Audio session configured successfully");
    } catch (error) {
      console.warn("[RecordButton] ⚠️ Failed to configure audio session:", error);
      // Continue with recording even if audio session config fails
    }

    setIsRecording(true);
    setRecordingMode(mode);
    setButtonInitiatedRecording(true);
    manuallyStoppedRef.current = false;
    recordingStartTimeRef.current = Date.now();

    const sessionMaxDuration = Math.min(maxDuration, remainingTime);
    onRecordingStart?.(mode, remainingTime);
    progressIntervalRef.current = setInterval(() => {
      const currentRecordingDuration =
        (Date.now() - recordingStartTimeRef.current) / 1000;
      const newRemainingTime = remainingTime - currentRecordingDuration;

      onRecordingProgress?.(
        currentRecordingDuration,
        Math.max(0, newRemainingTime)
      );

      if (newRemainingTime <= 0) {
        stopRecording();
        if (mode === "hold") {
          stopHoldVisualFeedback();
        } else if (mode === "tap") {
          Animated.parallel([
            Animated.timing(scaleAnim, {
              toValue: 1,
              duration: 150,
              useNativeDriver: false,
            }),
            Animated.timing(borderRadiusAnim, {
              toValue: 30,
              duration: 150,
              useNativeDriver: false,
            }),
          ]).start();
        }
      }
    }, 100);

    if (mode === "tap") {
      Animated.sequence([
        Animated.delay(100),
        Animated.parallel([
          Animated.timing(scaleAnim, {
            toValue: 0.4,
            duration: 150,
            useNativeDriver: false,
          }),
          Animated.timing(borderRadiusAnim, {
            toValue: 8,
            duration: 150,
            useNativeDriver: false,
          }),
        ]),
      ]).start();
    }

    recordingPromiseRef.current = cameraRef.current
      .recordAsync({ maxDuration: sessionMaxDuration })
      .then(async (video) => {
        let recordingDuration = (Date.now() - recordingStartTimeRef.current) / 1000;

        if (!manuallyStoppedRef.current && video?.uri) {
          console.log("[RecordButton] Recording saved:", video.uri);
          recordingDuration = await getVideoDuration(video.uri);
        }
        onRecordingComplete?.(video?.uri || null, mode, recordingDuration);
        return video;
      })
      .catch(async (error) => {
        const recordingDuration = (Date.now() - recordingStartTimeRef.current) / 1000;

        // Check for specific error types
        if (
          error.message?.includes("interrupted") ||
          error.message?.includes("stopped") ||
          error.message?.includes("background") ||
          error.message?.includes("cancelled")
        ) {
          console.warn("[RecordButton] ⚠️ Recording interrupted (expected):", error.message);
          // Don't show error alert for expected interruptions
        } else {
          console.error("[RecordButton] ❌ Recording failed (unexpected):", error);
        }
        onRecordingComplete?.(null, mode, recordingDuration);
        return null;
      })
      .finally(() => {
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }

        setIsRecording(false);
        setRecordingMode(null);
        setButtonInitiatedRecording(false);
        recordingPromiseRef.current = null;
        manuallyStoppedRef.current = false;
        buttonTouchActiveRef.current = false;
        fingerMovedOffButtonRef.current = false;
        initialTouchPositionRef.current = null;
        // Ensure hold visual feedback is stopped
        if (isHoldingForRecord) {
          stopHoldVisualFeedback();
        }
      });
  };

  const startHoldVisualFeedback = () => {
    setIsHoldingForRecord(true);
    isHoldingRef.current = true;

    const startPulsing = () => {
      pulsingRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(outerBorderScaleAnim, {
            toValue: 1.4,
            duration: 800,
            useNativeDriver: false,
          }),
          Animated.timing(outerBorderScaleAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: false,
          }),
        ])
      );
      pulsingRef.current.start();
    };
    startPulsing();
  };

  const stopHoldVisualFeedback = () => {
    setIsHoldingForRecord(false);
    isHoldingRef.current = false;

    if (pulsingRef.current) {
      pulsingRef.current.stop();
    }
    Animated.timing(outerBorderScaleAnim, {
      toValue: 1,
      duration: 200,
      useNativeDriver: false,
    }).start();
  };

  // Reset all animations and states to initial values
  const reset = React.useCallback(() => {
    // Stop any ongoing animations
    if (pulsingRef.current) {
      pulsingRef.current.stop();
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }

    // Reset animation values to initial state
    scaleAnim.setValue(1);
    borderRadiusAnim.setValue(30);
    outerBorderScaleAnim.setValue(1);

    // Reset state
    setIsHoldingForRecord(false);
    setIsRecording(false);
    setRecordingMode(null);
    setButtonInitiatedRecording(false);
    isHoldingRef.current = false;
    manuallyStoppedRef.current = false;
    recordingPromiseRef.current = null;

    console.log("[RecordButton] 🔄 Reset all animations and states");
  }, []);

  // Expose reset method via ref
  React.useImperativeHandle(ref, () => ({
    reset,
  }));

  const stopRecording = async () => {
    if (!cameraRef.current || !isRecording) return;

    manuallyStoppedRef.current = true;

    try {
      if (recordingPromiseRef.current) {
        cameraRef.current.stopRecording();
        await recordingPromiseRef.current;
      }
    } catch {
      // Error handling in promise handlers
    }

    if (recordingMode === "tap") {
      Animated.parallel([
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 150,
          useNativeDriver: false,
        }),
        Animated.timing(borderRadiusAnim, {
          toValue: 30,
          duration: 150,
          useNativeDriver: false,
        }),
      ]).start();
    }
  };

  const handleRecordPress = () => {
    const pressDuration = Date.now() - pressStartTimeRef.current;

    // Quick press = tap, longer press was hold operation
    if (pressDuration < 200) {
      if (isRecording) {
        stopRecording();
      } else {
        startRecording("tap");
      }
    }
  };

  const handlePressIn = (event?: any) => {
    pressStartTimeRef.current = Date.now();
    buttonTouchActiveRef.current = true;
    fingerMovedOffButtonRef.current = false;
    
    if (event?.nativeEvent) {
      initialTouchPositionRef.current = {
        x: event.nativeEvent.pageX || 0,
        y: event.nativeEvent.pageY || 0,
      };
    }

    // Notify parent that button touch started
    onButtonTouchStart?.();

    if (!isRecording && !isHoldingForRecord) {
      startHoldVisualFeedback();

      holdTimeoutRef.current = setTimeout(() => {
        if (isHoldingRef.current && buttonTouchActiveRef.current) {
          startRecording("hold");
        }
      }, holdDelay);
    }
  };

  const handlePressOut = () => {
    const wasButtonTouched = buttonTouchActiveRef.current;
    buttonTouchActiveRef.current = false;
    
    onButtonTouchEnd?.();

    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }

    if (isRecording && recordingMode === "hold" && wasButtonTouched) {
      const fingerMovedToScreen = fingerMovedOffButtonRef.current && screenTouchActive;
      
      if (!fingerMovedToScreen) {
        stopRecording();
        stopHoldVisualFeedback();
        setButtonInitiatedRecording(false);
      }
    } else if (isHoldingForRecord) {
      stopHoldVisualFeedback();
    }
    
    fingerMovedOffButtonRef.current = false;
    initialTouchPositionRef.current = null;
  };

  const handleTouchMove = (event: any) => {
    if (!buttonTouchActiveRef.current || !initialTouchPositionRef.current) {
      return;
    }

    const currentX = event.nativeEvent?.pageX || 0;
    const currentY = event.nativeEvent?.pageY || 0;
    const initialX = initialTouchPositionRef.current.x;
    const initialY = initialTouchPositionRef.current.y;

    const deltaX = Math.abs(currentX - initialX);
    const deltaY = Math.abs(currentY - initialY);
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    const MOVEMENT_THRESHOLD = 15;
    if (distance > MOVEMENT_THRESHOLD) {
      fingerMovedOffButtonRef.current = true;
    }
  };

  const handleTouchEnd = () => {
    if (buttonTouchActiveRef.current) {
      setTimeout(() => {
        if (buttonTouchActiveRef.current) {
          handlePressOut();
        }
      }, 10);
    }
  };

  return (
    <View style={[styles.buttonContainer, style]}>
      {/* Pulsing outer border for hold mode */}
      <Animated.View
        style={[
          styles.outerBorder,
          (isRecording || isHoldingForRecord) && styles.outerBorderActive,
          {
            transform: [{ scale: outerBorderScaleAnim }],
          },
        ]}
      />

      {/* Semi-transparent background that pulses during hold mode */}
      <Animated.View
        style={[
          styles.recordButton,
          {
            transform: [{ scale: outerBorderScaleAnim }],
          },
        ]}
      />

      {/* Static center button with tap animation only */}
      <View
        style={styles.touchableArea}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <TouchableOpacity
          onPress={handleRecordPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          activeOpacity={0.8}
        >
          <Animated.View
            style={[
              styles.innerButton,
              {
                transform: [{ scale: scaleAnim }],
                borderRadius: borderRadiusAnim,
                backgroundColor: "#ff0000",
              },
            ]}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
});

RecordButton.displayName = "RecordButton";

export default RecordButton;

const styles = StyleSheet.create({
  buttonContainer: {
    position: "absolute",
    bottom: 60,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  outerBorder: {
    position: "absolute",
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 4,
    borderColor: "#ffffff",
    backgroundColor: "transparent",
  },
  outerBorderActive: {
    borderColor: "#ff0000",
  },
  recordButton: {
    position: "absolute",
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "rgba(17, 17, 17, 0.5)",
  },
  touchableArea: {
    position: "absolute",
    width: 76,
    height: 76,
    justifyContent: "center",
    alignItems: "center",
  },
  innerButton: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#ff0000",
    justifyContent: "center",
    alignItems: "center",
  },
});

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as React from "react";
import { VideoStabilization } from "@/constants/camera";

const VIDEO_STABILIZATION_STORAGE_KEY = "videoStabilizationMode";

export function useVideoStabilization() {
  const [videoStabilizationMode, setVideoStabilizationMode] =
    React.useState<VideoStabilization>(VideoStabilization.on);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    async function loadVideoStabilizationPreference() {
      try {
        const savedMode = await AsyncStorage.getItem(
          VIDEO_STABILIZATION_STORAGE_KEY
        );

        if (
          savedMode === VideoStabilization.off ||
          savedMode === VideoStabilization.on
        ) {
          setVideoStabilizationMode(savedMode);
        } else {
          // No saved preference - default to ON for new users
          setVideoStabilizationMode(VideoStabilization.on);
        }
      } catch (error) {
        console.error("Error loading video stabilization preference:", error);
        // Default to ON on error
        setVideoStabilizationMode(VideoStabilization.on);
      } finally {
        setIsLoading(false);
      }
    }

    loadVideoStabilizationPreference();
  }, []);

  // Function to update and persist the preference
  const updateVideoStabilizationMode = React.useCallback(
    async (mode: VideoStabilization) => {
      try {
        setVideoStabilizationMode(mode);
        await AsyncStorage.setItem(VIDEO_STABILIZATION_STORAGE_KEY, mode);
      } catch (error) {
        console.error("Error saving video stabilization preference:", error);
        // Still update the state even if saving fails
        setVideoStabilizationMode(mode);
      }
    },
    []
  );

  return {
    videoStabilizationMode,
    updateVideoStabilizationMode,
    isLoading,
  };
}


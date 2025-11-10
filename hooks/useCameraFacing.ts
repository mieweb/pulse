import AsyncStorage from "@react-native-async-storage/async-storage";
import * as React from "react";
import { CameraType } from "expo-camera";

const CAMERA_FACING_STORAGE_KEY = "cameraFacing";

export function useCameraFacing() {
  const [cameraFacing, setCameraFacing] = React.useState<CameraType>("back");
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    async function loadCameraFacingPreference() {
      try {
        const savedFacing = await AsyncStorage.getItem(
          CAMERA_FACING_STORAGE_KEY
        );

        if (savedFacing === "back" || savedFacing === "front") {
          setCameraFacing(savedFacing as CameraType);
        } else {
          // No saved preference - default to BACK for new users
          setCameraFacing("back");
        }
      } catch (error) {
        console.error("Error loading camera facing preference:", error);
        // Default to BACK on error
        setCameraFacing("back");
      } finally {
        setIsLoading(false);
      }
    }

    loadCameraFacingPreference();
  }, []);

  // Function to update and persist the preference
  const updateCameraFacing = React.useCallback(
    async (facing: CameraType) => {
      try {
        setCameraFacing(facing);
        await AsyncStorage.setItem(CAMERA_FACING_STORAGE_KEY, facing);
      } catch (error) {
        console.error("Error saving camera facing preference:", error);
        // Still update the state even if saving fails
        setCameraFacing(facing);
      }
    },
    []
  );

  return {
    cameraFacing,
    updateCameraFacing,
    isLoading,
  };
}


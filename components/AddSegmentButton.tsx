import React, { useState } from "react";
import { StyleSheet, TouchableOpacity, Alert } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import * as MediaLibrary from "expo-media-library";
import { fileStore } from "@/utils/fileStore";
import { RecordingSegment } from "@/components/RecordingProgressBar";
import { v4 as uuidv4 } from "uuid";
import VideoSelectorModal from "@/components/VideoSelectorModal";

interface AddSegmentButtonProps {
  onSegmentAdd: (segment: RecordingSegment) => void;
  totalDuration: number;
  usedDuration: number;
  disabled?: boolean;
}

export default function AddSegmentButton({
  onSegmentAdd,
  totalDuration,
  usedDuration,
  disabled = false,
}: AddSegmentButtonProps) {
  const [isModalVisible, setIsModalVisible] = useState(false);

  const handleAddSegment = async () => {
    try {
      // Check and request media library permissions
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          "Permission Required",
          "Please allow access to your photo library to select videos."
        );
        return;
      }

      // Open the video selector modal
      setIsModalVisible(true);
    } catch (error) {
      console.error("Error accessing photo library:", error);
      Alert.alert(
        "Error",
        "Failed to access your photo library. Please try again."
      );
    }
  };

  const handleSelectVideo = async (asset: MediaLibrary.Asset) => {
    try {
      // Get asset info to access the file
      const assetInfo = await MediaLibrary.getAssetInfoAsync(asset);
      
      if (!assetInfo.localUri && !assetInfo.uri) {
        Alert.alert(
          "Error",
          "Could not access the selected video file."
        );
        return;
      }

      const videoUri = assetInfo.localUri || assetInfo.uri;
      const videoDuration = Math.round(asset.duration); // Duration is already in seconds

      // Check if adding this segment would exceed total duration
      if (usedDuration + videoDuration > totalDuration) {
        Alert.alert(
          "Duration Exceeded",
          `This video is ${videoDuration}s long, but you only have ${totalDuration - usedDuration}s remaining. Please select a shorter video or increase your recording duration.`
        );
        return;
      }

      // Store the file using importSegment method
      const segmentId = `imported_${uuidv4()}`;
      const storedUri = await fileStore.importSegment({
        draftId: Date.now().toString(), // Temporary draft ID - will be handled by useDraftManager
        srcUri: videoUri,
        segmentId: segmentId,
      });

      // Create the recording segment
      const newSegment: RecordingSegment = {
        id: segmentId,
        uri: storedUri,
        duration: videoDuration,
      };

      onSegmentAdd(newSegment);
    } catch (error) {
      console.error("Error processing selected video:", error);
      Alert.alert(
        "Error",
        "Failed to process the selected video. Please try again."
      );
    }
  };

  return (
    <>
      <TouchableOpacity
        style={[styles.addSegmentButton, disabled && styles.disabled]}
        onPress={handleAddSegment}
        disabled={disabled}
        activeOpacity={0.7}
      >
        <MaterialIcons name="add" size={26} color={disabled ? "#666" : "black"} />
      </TouchableOpacity>

      <VideoSelectorModal
        visible={isModalVisible}
        onClose={() => setIsModalVisible(false)}
        onSelectVideo={handleSelectVideo}
      />
    </>
  );
}

const styles = StyleSheet.create({
  addSegmentButton: {
    position: "absolute",
    bottom: 40,
    right: 80, // Position to the left of the preview button (right: 20 + 44 + 16)
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  disabled: {
    backgroundColor: "#ccc",
    opacity: 0.6,
  },
});
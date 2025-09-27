import React from "react";
import { StyleSheet, TouchableOpacity, Alert } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { Audio } from "expo-av";
import { fileStore } from "@/utils/fileStore";
import { RecordingSegment } from "@/components/RecordingProgressBar";
import { v4 as uuidv4 } from "uuid";

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
  const handleAddSegment = async () => {
    try {
      // Open document picker for video files
      const result = await DocumentPicker.getDocumentAsync({
        type: ["video/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled) {
        return;
      }

      const selectedFile = result.assets[0];
      
      // Validate file size (50MB limit)
      const maxSizeInBytes = 50 * 1024 * 1024; // 50MB
      if (selectedFile.size && selectedFile.size > maxSizeInBytes) {
        Alert.alert(
          "File Too Large",
          "Please select a video file smaller than 50MB."
        );
        return;
      }

      // Get video duration using expo-av
      let videoDuration = 0;
      try {
        const { sound } = await Audio.Sound.createAsync(
          { uri: selectedFile.uri },
          { shouldPlay: false }
        );
        const status = await sound.getStatusAsync();
        if (status.isLoaded && status.durationMillis) {
          videoDuration = Math.round(status.durationMillis / 1000); // Convert to seconds
        }
        await sound.unloadAsync();
      } catch (error) {
        console.warn("Could not get video duration:", error);
        // Default to 5 seconds if we can't get duration
        videoDuration = 5;
      }

      // Check if adding this segment would exceed total duration
      if (usedDuration + videoDuration > totalDuration) {
        Alert.alert(
          "Duration Exceeded",
          `This video is ${videoDuration}s long, but you only have ${totalDuration - usedDuration}s remaining. Please select a shorter video or increase your recording duration.`
        );
        return;
      }

      // Store the file in our file system
      const storedUri = await fileStore.storeFile(selectedFile.uri, "video", {
        name: selectedFile.name || "imported_video.mp4",
        type: selectedFile.mimeType || "video/mp4",
      });

      // Create the recording segment
      const newSegment: RecordingSegment = {
        id: `imported_${uuidv4()}`,
        uri: storedUri,
        duration: videoDuration,
      };

      onSegmentAdd(newSegment);
    } catch (error) {
      console.error("Error adding video segment:", error);
      Alert.alert(
        "Error",
        "Failed to add video segment. Please try again or select a different file."
      );
    }
  };

  return (
    <TouchableOpacity
      style={[styles.addSegmentButton, disabled && styles.disabled]}
      onPress={handleAddSegment}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <MaterialIcons name="add" size={26} color={disabled ? "#666" : "black"} />
    </TouchableOpacity>
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
import React from "react";
import { StyleSheet, TouchableOpacity, Alert } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { getThumbnailAsync } from "expo-video-thumbnails";
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

      // Get video duration using video thumbnails (workaround approach)
      let videoDuration = 5; // Default fallback duration in seconds
      try {
        // Generate thumbnail to access video metadata (we don't use the actual dimensions)
        await getThumbnailAsync(
          selectedFile.uri,
          {
            time: 0, // Get thumbnail at start of video
          }
        );
        
        // Since we can't get exact duration easily, we'll estimate based on file size
        // This is a rough estimation - could be improved with native module
        if (selectedFile.size) {
          const sizeInMB = selectedFile.size / (1024 * 1024);
          // Very rough estimation: smaller files = shorter videos, larger files = longer videos
          // Adjust these values based on testing
          if (sizeInMB < 5) {
            videoDuration = Math.max(3, Math.min(10, sizeInMB * 2));
          } else if (sizeInMB < 20) {
            videoDuration = Math.max(10, Math.min(30, sizeInMB * 1.5));
          } else {
            videoDuration = Math.max(30, Math.min(60, sizeInMB));
          }
        }
      } catch (error) {
        console.warn("Could not estimate video duration:", error);
        // Use default duration if estimation fails
        videoDuration = 5;
      }

      // Ask user to confirm the estimated duration or let them input the actual duration
      Alert.alert(
        "Video Duration",
        `We estimated this video is about ${Math.round(videoDuration)} seconds long. Is this correct?`,
        [
          {
            text: "Different Length",
            onPress: () => {
              Alert.prompt(
                "Enter Video Duration",
                "Please enter the actual duration in seconds:",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Add Video",
                    onPress: (inputDuration) => {
                      const duration = parseInt(inputDuration || "5", 10);
                      if (isNaN(duration) || duration <= 0) {
                        Alert.alert("Invalid Duration", "Please enter a valid duration in seconds.");
                        return;
                      }
                      addVideoSegment(selectedFile, duration);
                    },
                  },
                ],
                "plain-text",
                videoDuration.toString()
              );
            },
          },
          {
            text: "Correct",
            onPress: () => addVideoSegment(selectedFile, videoDuration),
          },
        ]
      );
    } catch (error) {
      console.error("Error adding video segment:", error);
      Alert.alert(
        "Error",
        "Failed to add video segment. Please try again or select a different file."
      );
    }
  };

  const addVideoSegment = async (selectedFile: any, videoDuration: number) => {
    try {
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
        srcUri: selectedFile.uri,
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
      console.error("Error storing video segment:", error);
      Alert.alert(
        "Error",
        "Failed to store video segment. Please try again."
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
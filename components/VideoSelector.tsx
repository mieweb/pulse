import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { Colors } from "@/constants/Colors";
import { useColorScheme } from "@/hooks/useColorScheme";
import * as ImagePicker from "expo-image-picker";
import * as VideoThumbnails from "expo-video-thumbnails";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Alert,
  StyleSheet,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from "react-native";

export interface VideoSelectionResult {
  uri: string;
  duration?: number;
  fileSize?: number;
  width?: number;
  height?: number;
  thumbnailUri?: string;
}

interface VideoSelectorProps {
  onVideoSelected: (result: VideoSelectionResult) => void;
  onError?: (error: string) => void;
  style?: any;
  buttonText?: string;
  showIcon?: boolean;
  disabled?: boolean;
}

export default function VideoSelector({
  onVideoSelected,
  onError,
  style,
  buttonText = "Select Video",
  showIcon = true,
  disabled = false,
}: VideoSelectorProps) {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const [isLoading, setIsLoading] = useState(false);

  const requestPermissions = async (): Promise<boolean> => {
    try {
      const { status } =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Permission Required",
          "Please grant access to your photo library to select videos.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Settings",
              onPress: () => ImagePicker.requestMediaLibraryPermissionsAsync(),
            },
          ]
        );
        return false;
      }
      return true;
    } catch (error) {
      console.error("Permission request failed:", error);
      onError?.("Failed to request permissions");
      return false;
    }
  };

  const generateThumbnail = async (
    videoUri: string
  ): Promise<string | null> => {
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
        time: 1000, // 1 second into the video
        quality: 0.8,
      });
      return uri;
    } catch (error) {
      console.warn("Thumbnail generation failed:", error);
      return null;
    }
  };

  const selectVideo = async () => {
    if (disabled || isLoading) return;

    try {
      setIsLoading(true);

      // Request permissions first
      const hasPermission = await requestPermissions();
      if (!hasPermission) {
        return;
      }

      // Launch the native video picker
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

        // Generate thumbnail
        const thumbnailUri = await generateThumbnail(asset.uri);

        // Create the result object
        const videoResult: VideoSelectionResult = {
          uri: asset.uri,
          duration: asset.duration || undefined,
          fileSize: asset.fileSize,
          width: asset.width,
          height: asset.height,
          thumbnailUri: thumbnailUri || undefined,
        };

        onVideoSelected(videoResult);
      }
    } catch (error) {
      console.error("Video selection failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to select video";
      onError?.(errorMessage);
      Alert.alert("Error", errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <TouchableOpacity
      style={[
        styles.button,
        {
          backgroundColor: colors.background,
          borderColor: colors.icon,
        },
        disabled && styles.disabled,
        style,
      ]}
      onPress={selectVideo}
      disabled={disabled || isLoading}
      activeOpacity={0.7}
    >
      <View style={styles.buttonContent}>
        {isLoading ? (
          <ActivityIndicator size="small" color={colors.text} />
        ) : (
          showIcon && (
            <MaterialIcons
              name="video-library"
              size={20}
              color={colors.text}
              style={styles.icon}
            />
          )
        )}
        <ThemedText
          style={[
            styles.buttonText,
            { color: colors.text },
            disabled && styles.disabledText,
          ]}
        >
          {isLoading ? "Selecting..." : buttonText}
        </ThemedText>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 48,
  },
  buttonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    marginRight: 8,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  disabled: {
    opacity: 0.5,
  },
  disabledText: {
    opacity: 0.5,
  },
});

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
  Modal,
  Dimensions,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export interface VideoSelectionResult {
  uri: string;
  duration?: number;
  fileSize?: number;
  width?: number;
  height?: number;
  thumbnailUri?: string;
}

interface VideoSelectorModalProps {
  visible: boolean;
  onClose: () => void;
  onVideoSelected: (result: VideoSelectionResult) => void;
  onError?: (error: string) => void;
}

const { width: screenWidth } = Dimensions.get("window");

export default function VideoSelectorModal({
  visible,
  onClose,
  onVideoSelected,
  onError,
}: VideoSelectorModalProps) {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const insets = useSafeAreaInsets();
  const [isLoading, setIsLoading] = useState(false);
  const [selectedVideo, setSelectedVideo] =
    useState<VideoSelectionResult | null>(null);

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

        setSelectedVideo(videoResult);
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

  const handleConfirm = () => {
    if (selectedVideo) {
      onVideoSelected(selectedVideo);
      setSelectedVideo(null);
      onClose();
    }
  };

  const handleCancel = () => {
    setSelectedVideo(null);
    onClose();
  };

  const formatDuration = (duration?: number): string => {
    if (!duration) return "Unknown";
    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const formatFileSize = (fileSize?: number): string => {
    if (!fileSize) return "Unknown size";
    const mb = fileSize / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleCancel}
    >
      <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleCancel} style={styles.cancelButton}>
            <ThemedText style={styles.cancelText}>Cancel</ThemedText>
          </TouchableOpacity>
          <ThemedText style={styles.title}>Select Video</ThemedText>
          <TouchableOpacity
            onPress={handleConfirm}
            style={[styles.confirmButton, { opacity: selectedVideo ? 1 : 0.5 }]}
            disabled={!selectedVideo}
          >
            <ThemedText style={styles.confirmText}>Add</ThemedText>
          </TouchableOpacity>
        </View>

        {/* Content */}
        <View style={styles.content}>
          {selectedVideo ? (
            <View style={styles.previewContainer}>
              {selectedVideo.thumbnailUri && (
                <Image
                  source={{ uri: selectedVideo.thumbnailUri }}
                  style={styles.thumbnail}
                  resizeMode="cover"
                />
              )}
              <View style={styles.videoInfo}>
                <ThemedText style={styles.duration}>
                  Duration: {formatDuration(selectedVideo.duration)}
                </ThemedText>
                <ThemedText style={styles.fileSize}>
                  Size: {formatFileSize(selectedVideo.fileSize)}
                </ThemedText>
                {selectedVideo.width && selectedVideo.height && (
                  <ThemedText style={styles.dimensions}>
                    Resolution: {selectedVideo.width} × {selectedVideo.height}
                  </ThemedText>
                )}
              </View>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <MaterialIcons
                name="video-library"
                size={64}
                color={colors.icon}
              />
              <ThemedText style={styles.emptyText}>
                No video selected
              </ThemedText>
              <ThemedText style={styles.emptySubtext}>
                Tap "Select Video" to choose from your library
              </ThemedText>
            </View>
          )}
        </View>

        {/* Actions */}
        <View style={[styles.actions, { paddingBottom: insets.bottom + 20 }]}>
          <TouchableOpacity
            style={[
              styles.selectButton,
              {
                backgroundColor: colors.background,
                borderColor: colors.icon,
              },
            ]}
            onPress={selectVideo}
            disabled={isLoading}
            activeOpacity={0.7}
          >
            <View style={styles.buttonContent}>
              {isLoading ? (
                <ActivityIndicator size="small" color={colors.text} />
              ) : (
                <MaterialIcons
                  name="video-library"
                  size={20}
                  color={colors.text}
                  style={styles.buttonIcon}
                />
              )}
              <ThemedText style={styles.buttonText}>
                {isLoading ? "Selecting..." : "Select Video"}
              </ThemedText>
            </View>
          </TouchableOpacity>
        </View>
      </ThemedView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0, 0, 0, 0.1)",
  },
  cancelButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  cancelText: {
    fontSize: 16,
    color: "#007AFF",
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
  },
  confirmButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  confirmText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#007AFF",
  },
  content: {
    flex: 1,
    padding: 20,
  },
  previewContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbnail: {
    width: screenWidth - 80,
    height: (screenWidth - 80) * 0.75, // 4:3 aspect ratio
    borderRadius: 12,
    marginBottom: 20,
  },
  videoInfo: {
    alignItems: "center",
  },
  duration: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  fileSize: {
    fontSize: 14,
    opacity: 0.7,
    marginBottom: 4,
  },
  dimensions: {
    fontSize: 14,
    opacity: 0.7,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 18,
    fontWeight: "600",
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    opacity: 0.7,
    textAlign: "center",
  },
  actions: {
    paddingHorizontal: 20,
  },
  selectButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    borderWidth: 1,
  },
  buttonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonIcon: {
    marginRight: 8,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
  },
});

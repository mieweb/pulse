import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { useVideoPlayer, VideoView } from "expo-video";
import * as VideoThumbnails from "expo-video-thumbnails";
import * as Sharing from "expo-sharing";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  TouchableOpacity,
  View,
  Dimensions,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { uploadVideo } from "@/utils/tusUpload";
import { getUploadConfigForDraft } from "@/utils/uploadConfig";
import {
  getAllDestinations,
  type UploadDestination,
} from "@/utils/uploadDestinations";
import { DraftStorage } from "@/utils/draftStorage";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

export default function MergedVideoScreen() {
  const { videoUri, draftId } = useLocalSearchParams<{
    videoUri: string;
    draftId: string;
  }>();
  const insets = useSafeAreaInsets();
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasUploadConfig, setHasUploadConfig] = useState(false);
  const [isUploadModeDraft, setIsUploadModeDraft] = useState(false);
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<UploadDestination[]>([]);
  const [selectedDestination, setSelectedDestination] =
    useState<UploadDestination | null>(null);

  const player = useVideoPlayer(videoUri, (player) => {
    player.loop = false;
    player.muted = false;
    player.currentTime = 0;
    player.staysActiveInBackground = true; 
    // player.showNowPlayingNotification=true
  });

  useEffect(() => {
    const setupPlayer = async () => {
      if (videoUri) {
        try {
          setIsLoading(true);
          
          // Generate thumbnail
          try {
            const { uri } = await VideoThumbnails.getThumbnailAsync(
              videoUri,
              {
                time: 0,
              }
            );
            setThumbnailUri(uri);
          } catch (thumbError) {
            console.error("Failed to generate thumbnail:", thumbError);
          }

          await player.replaceAsync(videoUri);
          player.pause();
          player.currentTime = 0;
        } catch (error) {
          console.error("Failed to load merged video:", error);
          Alert.alert("Error", "Failed to load merged video");
        } finally {
          setIsLoading(false);
        }
      }
    };

    setupPlayer();
  }, [videoUri, player]);

  // Check upload config and load saved destinations
  useEffect(() => {
    const checkUploadConfig = async () => {
      const config = draftId ? await getUploadConfigForDraft(draftId) : null;
      setHasUploadConfig(!!config);

      if (draftId) {
        try {
          const draft = await DraftStorage.getDraftById(draftId, "upload") ||
                       await DraftStorage.getDraftById(draftId, "camera");
          if (draft) {
            setIsUploadModeDraft(draft.mode === "upload");
          }
        } catch (error) {
          console.error("[MergedVideo] Failed to check draft mode:", error);
          setIsUploadModeDraft(false);
        }
      } else {
        setIsUploadModeDraft(false);
      }
    };
    checkUploadConfig();
  }, [draftId]);

  useEffect(() => {
    getAllDestinations().then(setDestinations);
  }, []);

  // Cleanup player on component unmount
  useEffect(() => {
    return () => {
      try {
        if (player && typeof player.pause === "function") {
          player.pause();
        }
      } catch {
        // Silently ignore - player is already destroyed
      }
    };
  }, [player]);

  const handleBack = useCallback(() => {
    router.back();
  }, []);

  const toggleFullscreen = () => {
    if (!isFullscreen) {
      // Enter fullscreen and start playback
      setIsFullscreen(true);
      player.currentTime = 0; // Reset to beginning
      player.play();
    } else {
      // Exit fullscreen and pause
      setIsFullscreen(false);
      player.pause();
    }
  };

  const shareVideo = async () => {
    if (!videoUri) return;

    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert(
          "Sharing not available",
          "Sharing is not available on this device."
        );
        return;
      }

      await Sharing.shareAsync(videoUri, {
        mimeType: "video/mp4",
        dialogTitle: "Share your merged video",
      });
    } catch (error) {
      console.error("❌ Failed to share video:", error);
      Alert.alert("Share Failed", "Could not share the video.");
    }
  };

  const canUploadWithDestination =
    draftId && (hasUploadConfig || selectedDestination);
  const showDestinationPicker =
    !hasUploadConfig && destinations.length > 0 && draftId;

  const handleUpload = async () => {
    if (!videoUri) return;

    if (!draftId) {
      Alert.alert(
        "Upload not available",
        "This recording has no draft. Save as draft first.",
        [{ text: "OK" }]
      );
      return;
    }

    let configOverride: { server: string; token: string } | undefined;
    if (hasUploadConfig) {
      const config = await getUploadConfigForDraft(draftId);
      if (!config) {
        Alert.alert(
          "Server not set up for upload",
          "Server is not properly set up for upload.",
          [{ text: "OK", onPress: () => router.back() }]
        );
        return;
      }
      configOverride = undefined;
    } else if (selectedDestination) {
      configOverride = {
        server: selectedDestination.server,
        token: selectedDestination.token,
      };
    } else {
      Alert.alert(
        "Choose a destination",
        "Select an upload destination from the list above, or add one in Profile.",
        [{ text: "OK" }]
      );
      return;
    }

    try {
      setIsUploading(true);
      setUploadProgress(0);

      const filename = `draft-${draftId}.mp4`;
      const result = await uploadVideo(
        videoUri,
        filename,
        (progress) => setUploadProgress(progress.percentage),
        draftId,
        configOverride
      );

      Alert.alert(
        "Upload Successful",
        `Video uploaded successfully!\n\nVideo ID: ${result.videoId}\nSize: ${(result.size / 1024 / 1024).toFixed(2)} MB`,
        [
          {
            text: "OK",
            onPress: () => {
              // Navigate back or to success screen
              router.back();
            },
          },
        ]
      );
    } catch (error) {
      console.error("[Upload] Upload failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to upload video. Please try again.";
      
      // Check if it's a localhost error and provide helpful solution
      const isLocalhostError = errorMessage.includes("localhost") || errorMessage.includes("127.0.0.1");
      
      Alert.alert(
        "Upload Failed",
        isLocalhostError
          ? `${errorMessage}\n\n💡 Solution: Regenerate QR code with your computer's IP address:\n\n1. Find your IP: ifconfig | grep "inet "\n2. Run: PULSEVAULT_URL="http://YOUR_IP:3000" ./test-deeplink.sh\n3. Scan the new QR code`
          : errorMessage,
        [
          {
            text: "OK",
            style: "default",
          },
        ]
      );
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  if (isLoading) {
    return (
      <ThemedView style={styles.container}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
          <TouchableOpacity style={styles.backButton} onPress={handleBack}>
            <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
          </TouchableOpacity>
          <ThemedText style={styles.headerTitle}>Upload Video</ThemedText>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#ffffff" />
          <ThemedText style={styles.loadingText}>
            Loading merged video...
          </ThemedText>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <TouchableOpacity style={styles.backButton} onPress={handleBack}>
          <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
        </TouchableOpacity>
        <ThemedText style={styles.headerTitle}>Upload Video</ThemedText>
        <View style={styles.headerSpacer} />
      </View>
    
      {!isFullscreen && (
      <View style={styles.content}>
        {/* Video Thumbnail */}
        <View style={styles.videoSection}>
          <TouchableOpacity
            style={styles.videoThumbnail}
            onPress={toggleFullscreen}
          >
            {thumbnailUri ? (
              <Image 
                source={{ uri: thumbnailUri }} 
                style={styles.thumbnailImage}
                resizeMode="cover"
              />
            ) : (
              <View style={styles.thumbnailPlaceholder}>
                <MaterialIcons name="videocam" size={60} color="#666" />
              </View>
            )}
            <View style={styles.playOverlay}>
              <MaterialIcons name="play-arrow" size={60} color="#ffffff" />
            </View>
          </TouchableOpacity>
        </View>

        {/* Upload Info */}
        {hasUploadConfig && (
          <View style={styles.inputSection}>
            <ThemedText style={styles.inputLabel}>
              Upload Server Configured
            </ThemedText>
            <ThemedText style={styles.uploadInfoText}>
              Ready to upload to your organization&apos;s server
            </ThemedText>
          </View>
        )}

        {showDestinationPicker && (
          <View style={styles.inputSection}>
            <ThemedText style={styles.inputLabel}>
              Choose upload destination
            </ThemedText>
            <ThemedText style={styles.uploadInfoText}>
              Select a server to upload this video to.
            </ThemedText>
            <View style={styles.destinationList}>
              {destinations.map((dest) => (
                <TouchableOpacity
                  key={dest.id}
                  style={[
                    styles.destinationItem,
                    selectedDestination?.id === dest.id &&
                      styles.destinationItemSelected,
                  ]}
                  onPress={() =>
                    setSelectedDestination(
                      selectedDestination?.id === dest.id ? null : dest
                    )
                  }
                  activeOpacity={0.8}
                >
                  <MaterialIcons
                    name={
                      selectedDestination?.id === dest.id
                        ? "radio-button-checked"
                        : "radio-button-unchecked"
                    }
                    size={20}
                    color={
                      selectedDestination?.id === dest.id ? "#0A84FF" : "#666"
                    }
                  />
                  <View style={styles.destinationItemContent}>
                    <ThemedText
                      style={styles.destinationItemName}
                      numberOfLines={1}
                    >
                      {dest.name || dest.server}
                    </ThemedText>
                    <ThemedText
                      style={styles.destinationItemServer}
                      numberOfLines={1}
                    >
                      {dest.server}
                    </ThemedText>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {!hasUploadConfig && !showDestinationPicker && (
          <View style={styles.inputSection}>
            <ThemedText style={styles.inputLabel}>
              {draftId
                ? "No upload destination"
                : "Upload not available"}
            </ThemedText>
            <ThemedText style={styles.uploadInfoText}>
              {draftId
                ? "Add an upload destination in Profile (scan a Setup QR from your vault), or use a per-draft QR code."
                : "Save as draft first to upload."}
            </ThemedText>
          </View>
        )}

        {/* Upload Progress Bar */}
        {isUploading && (
          <View style={styles.progressSection}>
            <View style={styles.progressBarContainer}>
              <View
                style={[
                  styles.progressBar,
                  { width: `${uploadProgress}%` },
                ]}
              />
            </View>
            <ThemedText style={styles.progressText}>
              {Math.round(uploadProgress)}% uploaded
            </ThemedText>
          </View>
        )}

        {/* Action Buttons */}
        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={[
              styles.uploadButton,
              (!canUploadWithDestination || isUploading) &&
                styles.uploadButtonDisabled,
            ]}
            onPress={handleUpload}
            activeOpacity={0.8}
            disabled={!canUploadWithDestination || isUploading}
          >
            {isUploading ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <MaterialIcons name="cloud-upload" size={20} color="#ffffff" />
            )}
            <ThemedText style={styles.buttonText}>
              {isUploading
                ? `Uploading... ${Math.round(uploadProgress)}%`
                : "Upload to Cloud"}
            </ThemedText>
          </TouchableOpacity>

          {/* Separator */}
          <View style={styles.separator}>
            <View style={styles.separatorLine} />
            <ThemedText style={styles.separatorText}>or</ThemedText>
            <View style={styles.separatorLine} />
          </View>

          <TouchableOpacity
            style={styles.saveButton}
            onPress={shareVideo}
            activeOpacity={0.8}
          >
            <MaterialIcons name="download" size={20} color="#ffffff" />
            <ThemedText style={styles.buttonText}>Save to Device</ThemedText>
          </TouchableOpacity>
        </View>
      </View>
      )}

      {/* Fullscreen Video Overlay */}
      {isFullscreen && (
        <View style={styles.fullscreenOverlay}>
          <VideoView
            player={player}
            style={styles.fullscreenVideoPlayer}
            allowsFullscreen={false}
            allowsPictureInPicture={false}
            showsTimecodes={true}
            requiresLinearPlayback={true}
            contentFit="contain"
            nativeControls={true}
            surfaceType="textureView"
          />

          <TouchableOpacity
            style={styles.fullscreenCloseButton}
            onPress={toggleFullscreen}
          >
            <MaterialIcons name="close" size={24} color="#ffffff" />
          </TouchableOpacity>
        </View>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#333",
  },
  backButton: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#ffffff",
    flex: 1,
    textAlign: "center",
  },
  headerSpacer: {
    width: 40,
  },
  content: {
    flex: 1,
    paddingBottom: 20,
  },
  videoSection: {
    padding: 16,
  },
  videoThumbnail: {
    width: "100%",
    height: 200,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#333",
    position: "relative",
  },
  thumbnailImage: {
    width: "100%",
    height: "100%",
  },
  thumbnailPlaceholder: {
    width: "100%",
    height: "100%",
    backgroundColor: "#1a1a1a",
    justifyContent: "center",
    alignItems: "center",
  },
  staticThumbnail: {
    width: "100%",
    height: "100%",
    backgroundColor: "#333",
    justifyContent: "center",
    alignItems: "center",
  },
  playOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    justifyContent: "center",
    alignItems: "center",
  },
  inputSection: {
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  inputLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: "#ffffff",
    marginBottom: 8,
  },
  titleInput: {
    backgroundColor: "#1a1a1a",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: "#ffffff",
    borderWidth: 1,
    borderColor: "#333",
    minHeight: 50,
  },
  uploadLinkInput: {
    backgroundColor: "#1a1a1a",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: "#ffffff",
    borderWidth: 1,
    borderColor: "#333",
    minHeight: 50,
  },
  actionButtons: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 12,
  },
  saveButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 50,
    backgroundColor: "#333",
    borderRadius: 8,
    gap: 8,
  },
  uploadButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 50,
    backgroundColor: "#ff0000",
    borderRadius: 8,
    gap: 8,
  },
  uploadButtonDisabled: {
    backgroundColor: "#666",
    opacity: 0.5,
  },
  uploadInfoText: {
    fontSize: 14,
    color: "#999",
    marginTop: 4,
  },
  destinationList: {
    marginTop: 8,
    gap: 6,
  },
  destinationItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "#333",
    gap: 10,
  },
  destinationItemSelected: {
    borderColor: "#0A84FF",
    backgroundColor: "#0A84FF18",
  },
  destinationItemContent: {
    flex: 1,
  },
  destinationItemName: {
    fontSize: 15,
    fontWeight: "600",
    color: "#ffffff",
  },
  destinationItemServer: {
    fontSize: 12,
    color: "#999",
    marginTop: 2,
  },
  progressSection: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  progressBarContainer: {
    height: 4,
    backgroundColor: "#333",
    borderRadius: 2,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressBar: {
    height: "100%",
    backgroundColor: "#ff0000",
    borderRadius: 2,
  },
  progressText: {
    fontSize: 12,
    color: "#999",
    textAlign: "center",
  },
  separator: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 16,
  },
  separatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#333",
  },
  separatorText: {
    color: "#666",
    fontSize: 14,
    marginHorizontal: 16,
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "#ffffff",
    marginTop: 20,
    fontSize: 16,
    fontFamily: "Roboto-Regular",
  },
  fullscreenOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1000,
  },
  fullscreenVideoPlayer: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  fullscreenCloseButton: {
    position: "absolute",
    top: 50,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1001,
  },
});

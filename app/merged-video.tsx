import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { useVideoPlayer, VideoView } from "expo-video";
import * as Sharing from "expo-sharing";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import * as FileSystem from "expo-file-system";
import { uploadVideo } from "@/utils/tusUpload";
import QRCodeScanner from "@/components/QRCodeScanner";

export default function MergedVideoScreen() {
  const { videoUri, draftId, server, token } = useLocalSearchParams<{
    videoUri: string;
    draftId: string;
    server?: string;
    token?: string; // Secure upload token
  }>();
  const insets = useSafeAreaInsets();
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLink, setUploadLink] = useState(server || "");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [scannedToken, setScannedToken] = useState<string | null>(null);
  
  // Use token from params or from QR scan
  const effectiveToken = token || scannedToken;

  const player = useVideoPlayer(videoUri, (player) => {
    if (player) {
      player.loop = false;
      player.muted = false;
      player.currentTime = 0;
    }
  });

  useEffect(() => {
    const setupPlayer = async () => {
      if (videoUri) {
        try {
          setIsLoading(true);
          await player.replaceAsync(videoUri);
          // Don't auto-play in thumbnail mode
          player.pause();
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

  // Pause video when not in fullscreen
  useEffect(() => {
    if (!isFullscreen) {
      player.pause();
    }
  }, [isFullscreen, player]);

  // Cleanup player on component unmount
  useEffect(() => {
    return () => {
      try {
        if (player && typeof player.pause === "function") {
          player.pause();
        }
      } catch (error) {
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

  // Initialize upload link from server param if available
  useEffect(() => {
    if (server && !uploadLink) {
      // Normalize server URL - ensure it has protocol
      let normalizedServer = server;
      if (!normalizedServer.includes("://")) {
        normalizedServer = `http://${normalizedServer}`;
      }
      // Extract just protocol + host (remove any paths)
      try {
        const parsed = new URL(normalizedServer);
        normalizedServer = `${parsed.protocol}//${parsed.host}`;
      } catch (e) {
        // If parsing fails, use as-is (shouldn't happen if we added protocol)
      }
      setUploadLink(normalizedServer);
    }
  }, [server]);

  // Verify token if present
  useEffect(() => {
    const verifyToken = async () => {
      if (effectiveToken && server) {
        try {
          const response = await fetch(`${server}/qr/verify`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ token: effectiveToken }),
          });

          if (response.ok) {
            const data = await response.json();
            if (data.valid) {
              console.log("✅ Token verified:", data.payload);
              // Token is valid, can proceed with upload
              // Optionally extract userId/organizationId from payload
            } else {
              Alert.alert("Invalid Token", data.reason || "Token verification failed");
            }
          } else {
            console.warn("Token verification failed:", response.statusText);
          }
        } catch (error) {
          console.error("Token verification error:", error);
          // Don't block upload if verification fails (network issues, etc.)
        }
      }
    };

    verifyToken();
  }, [effectiveToken, server]);

  const handleUpload = async () => {
    if (!videoUri) return;

    if (!uploadLink) {
      Alert.alert("Upload Link Required", "Please enter an upload link first.");
      return;
    }
    
    // Require token for secure uploads (QR code scan)
    if (!effectiveToken) {
      Alert.alert(
        "Authentication Required",
        "Uploads require a secure token.\n\n" +
        "Please scan a QR code from your organization to upload videos.\n\n" +
        "Manual server URLs are not allowed for security reasons.",
        [{ text: "OK" }]
      );
      return;
    }

    // Validate and normalize server URL format
    let serverUrl = uploadLink.trim();
    
    // Handle URLs that include /uploads path - strip it since TUS uses /uploads endpoint
    serverUrl = serverUrl.replace(/\/uploads\/?$/, "");
    
    // Replace localhost with your computer's IP for mobile devices
    // This is needed because localhost on phone refers to the phone, not your computer
    if (serverUrl.includes("localhost") || serverUrl.includes("127.0.0.1")) {
      // Try to detect if we're on a mobile device
      const isMobile = Platform.OS === "ios" || Platform.OS === "android";
      if (isMobile) {
        Alert.alert(
          "Localhost Detected",
          "You're using 'localhost' which won't work from your phone.\n\n" +
          "Please use your computer's IP address instead:\n" +
          "192.168.8.179:3000\n\n" +
          "Or scan a new QR code generated with your IP address.",
          [{ text: "OK" }]
        );
        return;
      }
    }
    
    // Add protocol if missing
    if (!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://")) {
      serverUrl = `http://${serverUrl}`;
    }
    
    // Remove trailing slash and any path components (keep only base URL)
    try {
      const url = new URL(serverUrl);
      serverUrl = `${url.protocol}//${url.host}`;
    } catch (error) {
      // If URL parsing fails, just remove trailing slash
      serverUrl = serverUrl.replace(/\/$/, "");
    }

    try {
      setIsUploading(true);
      setUploadProgress(0);

      // Get filename from video URI or use default
      const filename = `video-${draftId || Date.now()}.mp4`;

      // Upload using TUS protocol
      // Note: Token validation happens server-side during finalize
      const result = await uploadVideo({
        serverUrl,
        fileUri: videoUri,
        filename,
        uploadToken: effectiveToken, // Pass token for server-side validation
        onProgress: (progress) => {
          setUploadProgress(progress);
        },
        onError: (error) => {
          console.error("Upload error:", error);
          Alert.alert("Upload Failed", error.message || "Failed to upload video");
        },
      });

      console.log("✅ Upload successful:", result);

      // Show success message
      Alert.alert(
        "Upload Successful",
        result.videoId
          ? `Video uploaded successfully!\nVideo ID: ${result.videoId}`
          : "Video uploaded successfully!",
        [
          {
            text: "OK",
            onPress: () => {
              // Navigate back or to a success screen
              router.back();
            },
          },
        ]
      );
    } catch (error) {
      console.error("❌ Upload failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to upload video";
      Alert.alert("Upload Failed", errorMessage);
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

      <View style={styles.content}>
        {/* Video Thumbnail */}
        <View style={styles.videoSection}>
          <TouchableOpacity
            style={styles.videoThumbnail}
            onPress={toggleFullscreen}
          >
            <VideoView
              player={player}
              style={styles.thumbnailVideo}
              allowsFullscreen={false}
              allowsPictureInPicture={false}
              showsTimecodes={false}
              requiresLinearPlayback={false}
              contentFit="cover"
              nativeControls={false}
            />
            <View style={styles.playOverlay}>
              <MaterialIcons name="play-arrow" size={40} color="#ffffff" />
            </View>
          </TouchableOpacity>
        </View>

        {/* Upload Link Input */}
        <View style={styles.inputSection}>
          <View style={styles.inputLabelRow}>
            <ThemedText style={styles.inputLabel}>
              Server URL {effectiveToken && "🔒"}
            </ThemedText>
            <TouchableOpacity
              style={styles.qrButton}
              onPress={() => setShowQRScanner(true)}
              activeOpacity={0.7}
            >
              <MaterialIcons name="qr-code-scanner" size={20} color="#ffffff" />
            </TouchableOpacity>
          </View>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.uploadLinkInput}
              placeholder="http://your-server.com:3000"
              placeholderTextColor="#666"
              value={uploadLink}
              onChangeText={setUploadLink}
              autoCapitalize="none"
              keyboardType="url"
              returnKeyType="done"
              blurOnSubmit={true}
              onSubmitEditing={() => {
                // Dismiss keyboard when done is pressed
              }}
            />
          </View>
          <ThemedText style={styles.helperText}>
            {effectiveToken 
              ? "🔒 Secure upload enabled (token from QR code)"
              : "⚠️ Scan QR code to enable uploads (authentication required)"}
          </ThemedText>
          {effectiveToken && (
            <View style={styles.tokenContainer}>
              <ThemedText style={styles.tokenLabel}>Upload Token:</ThemedText>
              <ThemedText style={styles.tokenValue} selectable>
                {effectiveToken.length > 40 
                  ? `${effectiveToken.substring(0, 20)}...${effectiveToken.substring(effectiveToken.length - 20)}`
                  : effectiveToken}
              </ThemedText>
            </View>
          )}
          {!effectiveToken && uploadLink && (
            <ThemedText style={styles.warningText}>
              ⚠️ Uploads require authentication. Please scan a QR code.
            </ThemedText>
          )}
          {uploadLink && !uploadLink.includes("://") && (
            <ThemedText style={styles.warningText}>
              ⚠️ Include http:// or https://
            </ThemedText>
          )}
        </View>

        {/* Action Buttons */}
        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={[
              styles.uploadButton,
              isUploading && styles.uploadButtonDisabled,
            ]}
            onPress={handleUpload}
            activeOpacity={0.8}
            disabled={isUploading || !uploadLink.trim() || !effectiveToken}
          >
            {isUploading ? (
              <>
                <ActivityIndicator size="small" color="#ffffff" />
                <ThemedText style={styles.buttonText}>
                  Uploading... {Math.round(uploadProgress * 100)}%
                </ThemedText>
              </>
            ) : (
              <>
                <MaterialIcons name="cloud-upload" size={20} color="#ffffff" />
                <ThemedText style={styles.buttonText}>
                  Upload to Cloud
                </ThemedText>
              </>
            )}
          </TouchableOpacity>
          
          {/* Progress bar */}
          {isUploading && (
            <View style={styles.progressBarContainer}>
              <View style={[styles.progressBar, { width: `${uploadProgress * 100}%` }]} />
            </View>
          )}

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

      {/* Fullscreen Video Overlay */}
      {isFullscreen && (
        <View style={styles.fullscreenOverlay}>
          <View style={styles.fullscreenVideo}>
            <VideoView
              player={player}
              style={styles.fullscreenVideoPlayer}
              allowsFullscreen={true}
              allowsPictureInPicture={false}
              showsTimecodes={false}
              requiresLinearPlayback={true}
              contentFit="cover"
              nativeControls={true}
            />
          </View>

          <TouchableOpacity
            style={styles.fullscreenCloseButton}
            onPress={toggleFullscreen}
          >
            <MaterialIcons name="close" size={24} color="#ffffff" />
          </TouchableOpacity>
        </View>
      )}

      {/* QR Code Scanner Modal */}
      {showQRScanner && (
        <QRCodeScanner
          onScan={(data) => {
            console.log("📷 Scanned QR code:", data);
            setShowQRScanner(false);
            
            // Parse deeplink or use as server URL
            if (data.startsWith("pulsecam://")) {
              // Parse deeplink
              try {
                const url = new URL(data);
                const serverParam = url.searchParams.get("server");
                const tokenParam = url.searchParams.get("token");
                
                // Extract token if present
                if (tokenParam) {
                  // Token is already URL-encoded in the deeplink, decode it
                  const decodedToken = decodeURIComponent(tokenParam);
                  console.log("✅ Token extracted from QR:", decodedToken.substring(0, 20) + "...");
                  // Store token in state for use during upload
                  setScannedToken(decodedToken);
                }
                
                if (serverParam) {
                  // Extract just the base server URL (remove any paths)
                  let serverUrl = decodeURIComponent(serverParam);
                  // Remove /uploads if present
                  serverUrl = serverUrl.replace(/\/uploads\/?$/, "");
                  
                  // Normalize URL - ensure it has protocol
                  if (!serverUrl.includes("://")) {
                    serverUrl = `http://${serverUrl}`;
                  }
                  
                  // Extract base URL (protocol + host)
                  try {
                    const parsed = new URL(serverUrl);
                    serverUrl = `${parsed.protocol}//${parsed.host}`;
                  } catch (e) {
                    // If URL parsing fails, try to add protocol if still missing
                    if (!serverUrl.includes("://")) {
                      serverUrl = `http://${serverUrl}`;
                    }
                  }
                  setUploadLink(serverUrl);
                }
              } catch (error) {
                console.error("Failed to parse deeplink:", error);
                // Fallback: use the scanned data as-is
                setUploadLink(data);
              }
            } else {
              // Use scanned data as server URL, normalize it
              let serverUrl = data;
              // Remove /uploads if present
              serverUrl = serverUrl.replace(/\/uploads\/?$/, "");
              
              // Normalize URL - ensure it has protocol
              if (!serverUrl.includes("://")) {
                serverUrl = `http://${serverUrl}`;
              }
              
              // Extract base URL (protocol + host)
              try {
                const parsed = new URL(serverUrl);
                serverUrl = `${parsed.protocol}//${parsed.host}`;
              } catch (e) {
                // If URL parsing fails, ensure protocol is present
                if (!serverUrl.includes("://")) {
                  serverUrl = `http://${serverUrl}`;
                }
              }
              setUploadLink(serverUrl);
            }
          }}
          onClose={() => setShowQRScanner(false)}
        />
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
  thumbnailVideo: {
    width: "100%",
    height: "100%",
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
  inputLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  inputLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: "#ffffff",
  },
  qrButton: {
    padding: 8,
    backgroundColor: "#333",
    borderRadius: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
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
    flex: 1,
  },
  helperText: {
    fontSize: 12,
    color: "#999",
    marginTop: 6,
    marginLeft: 4,
  },
  warningText: {
    fontSize: 12,
    color: "#ff9900",
    marginTop: 4,
    marginLeft: 4,
  },
  tokenContainer: {
    marginTop: 8,
    padding: 8,
    backgroundColor: "#1a1a1a",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#333",
  },
  tokenLabel: {
    fontSize: 11,
    color: "#999",
    marginBottom: 4,
    fontWeight: "600",
  },
  tokenValue: {
    fontSize: 10,
    color: "#4CAF50",
    fontFamily: "monospace",
    letterSpacing: 0.5,
  },
  progressBarContainer: {
    height: 4,
    backgroundColor: "#333",
    borderRadius: 2,
    overflow: "hidden",
    marginTop: 8,
  },
  progressBar: {
    height: "100%",
    backgroundColor: "#ff0000",
    borderRadius: 2,
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
    zIndex: 1000,
  },
  fullscreenVideo: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  fullscreenVideoPlayer: {
    width: "100%",
    height: "100%",
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

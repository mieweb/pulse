import React, { useEffect, useState } from "react";
import {
  Modal,
  View,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
  Pressable,
} from "react-native";
import { ThemedText } from "@/components/ThemedText";
import * as MediaLibrary from "expo-media-library";
import { getThumbnailAsync } from "expo-video-thumbnails";
import { MaterialIcons } from "@expo/vector-icons";

interface VideoSelectorModalProps {
  visible: boolean;
  onClose: () => void;
  onSelectVideo: (asset: MediaLibrary.Asset) => void;
}

interface VideoItem {
  asset: MediaLibrary.Asset;
  thumbnailUri?: string;
}

export default function VideoSelectorModal({
  visible,
  onClose,
  onSelectVideo,
}: VideoSelectorModalProps) {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (visible) {
      loadVideos();
    }
  }, [visible]);

  const loadVideos = async () => {
    try {
      setLoading(true);
      const assets = await MediaLibrary.getAssetsAsync({
        mediaType: MediaLibrary.MediaType.video,
        first: 50,
        sortBy: MediaLibrary.SortBy.creationTime,
      });

      // Load thumbnails for each video
      const videosWithThumbnails = await Promise.all(
        assets.assets.map(async (asset) => {
          try {
            const assetInfo = await MediaLibrary.getAssetInfoAsync(asset);
            const videoUri = assetInfo.localUri || assetInfo.uri;
            const thumbnail = await getThumbnailAsync(videoUri, {
              time: 0,
            });
            return { asset, thumbnailUri: thumbnail.uri };
          } catch (error) {
            console.warn("Failed to generate thumbnail:", error);
            return { asset, thumbnailUri: undefined };
          }
        })
      );

      setVideos(videosWithThumbnails);
    } catch (error) {
      console.error("Error loading videos:", error);
    } finally {
      setLoading(false);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const renderVideoItem = ({ item }: { item: VideoItem }) => (
    <TouchableOpacity
      style={styles.videoItem}
      onPress={() => {
        onSelectVideo(item.asset);
        onClose();
      }}
    >
      <View style={styles.thumbnailContainer}>
        {item.thumbnailUri ? (
          <Image
            source={{ uri: item.thumbnailUri }}
            style={styles.thumbnail}
            resizeMode="cover"
          />
        ) : (
          <View style={[styles.thumbnail, styles.placeholderThumbnail]}>
            <MaterialIcons name="videocam" size={40} color="#666" />
          </View>
        )}
        <View style={styles.durationBadge}>
          <ThemedText style={styles.durationText}>
            {formatDuration(item.asset.duration)}
          </ThemedText>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <ThemedText style={styles.title}>Select Video</ThemedText>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <MaterialIcons name="close" size={28} color="#fff" />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#ff0000" />
              <ThemedText style={styles.loadingText}>Loading videos...</ThemedText>
            </View>
          ) : videos.length === 0 ? (
            <View style={styles.emptyContainer}>
              <MaterialIcons name="videocam-off" size={64} color="#666" />
              <ThemedText style={styles.emptyText}>
                No videos found in your library
              </ThemedText>
            </View>
          ) : (
            <FlatList
              data={videos}
              renderItem={renderVideoItem}
              keyExtractor={(item) => item.asset.id}
              numColumns={3}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={true}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: "#1a1a1a",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "80%",
    paddingBottom: 20,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#333",
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#fff",
  },
  closeButton: {
    padding: 4,
  },
  listContent: {
    padding: 10,
  },
  videoItem: {
    flex: 1,
    margin: 5,
    maxWidth: "30%",
  },
  thumbnailContainer: {
    position: "relative",
    aspectRatio: 9 / 16,
    borderRadius: 8,
    overflow: "hidden",
  },
  thumbnail: {
    width: "100%",
    height: "100%",
  },
  placeholderThumbnail: {
    backgroundColor: "#333",
    justifyContent: "center",
    alignItems: "center",
  },
  durationBadge: {
    position: "absolute",
    bottom: 4,
    right: 4,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  durationText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "bold",
  },
  loadingContainer: {
    padding: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    marginTop: 16,
    color: "#999",
    fontSize: 16,
  },
  emptyContainer: {
    padding: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    marginTop: 16,
    color: "#999",
    fontSize: 16,
    textAlign: "center",
  },
});

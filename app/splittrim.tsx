import { ThemedText } from "@/components/ThemedText";
import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { MaterialIcons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useState } from "react";
import {
  StyleSheet,
  View,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";

export default function SplitTrimScreen() {
  const { draftId, segmentId } = useLocalSearchParams<{
    draftId: string;
    segmentId: string;
  }>();
  const insets = useSafeAreaInsets();

  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [segment, setSegment] = useState<any>(null);

  const player = useVideoPlayer(null, (player) => {
    if (player) {
      player.loop = false;
      player.muted = false;
      player.currentTime = 0;
    }
  });

  useEffect(() => {
    const loadSegment = async () => {
      if (!draftId || !segmentId) {
        router.back();
        return;
      }

      try {
        setIsLoading(true);
        const draft = await DraftStorage.getDraftById(draftId);
        if (!draft) {
          router.back();
          return;
        }

        const foundSegment = draft.segments.find(
          (s: any) => s.id === segmentId
        );
        if (!foundSegment) {
          router.back();
          return;
        }

        setSegment(foundSegment);
        const absoluteUri = fileStore.toAbsolutePath(foundSegment.uri);
        setVideoUri(absoluteUri);
      } catch (error) {
        console.error("Failed to load segment:", error);
        router.back();
      } finally {
        setIsLoading(false);
      }
    };

    loadSegment();
  }, [draftId, segmentId]);

  useEffect(() => {
    const setupPlayer = async () => {
      if (videoUri && player && !isLoading) {
        try {
          await player.replaceAsync(videoUri);
          player.play();
        } catch (error) {
          console.error("Failed to setup player:", error);
        }
      }
    };

    setupPlayer();
  }, [videoUri, player, isLoading]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        try {
          if (player && typeof player.pause === "function") {
            player.pause();
          }
        } catch (error) {}
      };
    }, [player])
  );

  useEffect(() => {
    return () => {
      try {
        if (player && typeof player.pause === "function") {
          player.pause();
        }
      } catch (error) {}
    };
  }, [player]);

  const handleCancel = useCallback(() => {
    router.back();
  }, []);

  if (isLoading || !videoUri) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.closeButton} onPress={handleCancel}>
            <MaterialIcons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#ff0000" />
          <ThemedText style={styles.loadingText}>Loading video...</ThemedText>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.closeButton} onPress={handleCancel}>
          <MaterialIcons name="close" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <ThemedText style={styles.headerTitle}>Split & Trim</ThemedText>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.videoContainer}>
        <VideoView
          player={player}
          style={styles.video}
          allowsFullscreen={false}
          allowsPictureInPicture={false}
          showsTimecodes={true}
          requiresLinearPlayback={false}
          contentFit="contain"
          nativeControls={true}
        />
      </View>

      <View style={styles.controlsContainer}></View>
    </View>
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
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 20,
    backgroundColor: "rgba(0, 0, 0, 0.9)",
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  headerSpacer: {
    width: 40,
    height: 40,
  },
  headerInfo: {
    flex: 1,
    alignItems: "center",
    marginHorizontal: 20,
  },
  headerTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    fontFamily: "Roboto-Bold",
  },
  videoContainer: {
    flex: 0.6,
    width: "100%",
    backgroundColor: "#000",
  },
  video: {
    flex: 1,
    width: "100%",
  },
  controlsContainer: {
    flex: 0.4,
    width: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.9)",
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.1)",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Roboto-Regular",
    marginTop: 16,
  },
});

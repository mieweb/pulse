import { Draft, DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { DRAFT_NAME_LENGTH } from "@/constants/camera";
import AsyncStorage from "@react-native-async-storage/async-storage";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import React, { useEffect, useState, useCallback } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  Alert,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function DraftsScreen() {
  const insets = useSafeAreaInsets();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftNameInput, setDraftNameInput] = useState("");

  useEffect(() => {
    loadDrafts();
  }, []);

  // Reload drafts when screen comes into focus (e.g., after trimming)
  useFocusEffect(
    useCallback(() => {
      loadDrafts();
    }, [])
  );

  const loadDrafts = async () => {
    try {
      const savedDrafts = await DraftStorage.getAllDrafts();
      // Sort by most recently modified
      setDrafts(
        savedDrafts.sort(
          (a, b) => b.lastModified.getTime() - a.lastModified.getTime()
        )
      );
    } catch (error) {
      console.error("Error loading drafts:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDraftPress = (draft: Draft) => {
    router.push({
      pathname: "/(camera)/shorts",
      params: {
        draftId: draft.id,
        mode: draft.mode,
      },
    });
  };

  const handleDeleteDraft = async (draftId: string) => {
    Alert.alert("Delete Draft", "Are you sure you want to delete this draft?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            // If redo stack belongs to this draft, delete redo files and clear the stack
            try {
              const REDO_STACK_KEY = "redo_stack";
              const savedRedoData = await AsyncStorage.getItem(REDO_STACK_KEY);
              if (savedRedoData) {
                try {
                  const parsed = JSON.parse(savedRedoData);
                  const segments: any[] = Array.isArray(parsed)
                    ? parsed
                    : parsed?.segments || [];
                  const redoDraftId: string | null = Array.isArray(parsed)
                    ? null
                    : parsed?.draftId ?? null;
                  if (
                    segments.length > 0 &&
                    (redoDraftId === draftId || redoDraftId === null)
                  ) {
                    // Convert relative paths to absolute paths for deletion
                    const absoluteUris = segments.map((s: any) =>
                      fileStore.toAbsolutePath(s.uri)
                    );
                    await fileStore.deleteUris(absoluteUris);
                    await AsyncStorage.removeItem(REDO_STACK_KEY);
                  }
                } catch (error) {
                  console.warn(
                    "Failed to cleanup redo stack on delete:",
                    error
                  );
                }
              }
            } catch (error) {
              console.warn("Failed to read redo stack on delete:", error);
            }

            await DraftStorage.deleteDraft(draftId);
            loadDrafts();
          } catch (error) {
            console.error("Error deleting draft:", error);
          }
        },
      },
    ]);
  };

  const handleLongPress = (draft: Draft) => {
    setDraftNameInput(draft.name || "");
    setEditingDraftId(draft.id);
  };

  const handleSaveName = async (draftId: string) => {
    const trimmedName = draftNameInput.trim();

    try {
      await DraftStorage.updateDraftName(draftId, trimmedName || undefined);
      await loadDrafts();
      setEditingDraftId(null);
      setDraftNameInput("");
    } catch (error) {
      console.error("Error updating draft name:", error);
      Alert.alert("Error", "Failed to update draft name");
    }
  };

  const handleBlur = (draftId: string) => {
    handleSaveName(draftId).catch((error) => {
      console.error("Error saving draft name on blur:", error);
      Alert.alert("Error", "Failed to update draft name");
    });
  };

  const formatDuration = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const dateOnly = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate()
    );
    const timeString = date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    if (dateOnly.getTime() === today.getTime()) {
      return `Today, ${timeString}`;
    } else if (dateOnly.getTime() === yesterday.getTime()) {
      return `Yesterday, ${timeString}`;
    } else {
      return `${date.toLocaleDateString([], {
        month: "short",
        day: "numeric",
      })}, ${timeString}`;
    }
  };

  const renderDraftItem = ({ item }: { item: Draft }) => {
    // Calculate total duration accounting for trimmed segments
    const totalRecordedDuration = item.segments.reduce((total, segment) => {
      if (segment.inMs !== undefined || segment.outMs !== undefined) {
        const start = segment.inMs || 0;
        const end = segment.outMs || segment.duration * 1000;
        return total + (end - start) / 1000; // Convert ms to seconds
      }
      return total + segment.duration;
    }, 0);

    return (
      <TouchableOpacity
        style={styles.draftItem}
        onPress={() => handleDraftPress(item)}
        onLongPress={() => handleLongPress(item)}
        activeOpacity={0.5}
      >
        <View style={styles.draftContent}>
          {item.thumbnail && (
            <Image
              source={{ uri: fileStore.toAbsolutePath(item.thumbnail) }}
              style={styles.thumbnail}
            />
          )}
          <View style={styles.draftInfo}>
            {editingDraftId === item.id ? (
              <TextInput
                style={styles.draftNameInput}
                value={draftNameInput}
                onChangeText={setDraftNameInput}
                placeholder="Name this draft"
                placeholderTextColor="#888"
                autoFocus={true}
                maxLength={DRAFT_NAME_LENGTH}
                onSubmitEditing={() => handleSaveName(item.id)}
                onBlur={() => handleBlur(item.id)}
                returnKeyType="done"
                blurOnSubmit={true}
              />
            ) : item.name ? (
              <Text style={styles.draftName}>{item.name}</Text>
            ) : null}
            <Text style={styles.draftTitle}>
              {item.segments.length} segment
              {item.segments.length !== 1 ? "s" : ""} • Rec:{" "}
              {formatDuration(Math.floor(totalRecordedDuration))}/
              {formatDuration(item.totalDuration)}
            </Text>
            <Text style={styles.draftDate}>
              Created: {formatDate(item.createdAt)}
            </Text>
            <Text style={styles.draftDate}>
              Modified: {formatDate(item.lastModified)}
            </Text>
          </View>
          <View style={styles.actionsContainer}>
            {item.mode === "upload" && (
              <View style={styles.modeTag}>
                <MaterialIcons name="link" size={14} color="#888888" />
              </View>
            )}
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => handleDeleteDraft(item.id)}
            >
              <Text style={styles.deleteText}>×</Text>
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={styles.container}>
        {/* Close Button */}
        <TouchableOpacity
          style={[styles.closeButton, { top: insets.top + 20 }]}
          onPress={() => router.push("/(tabs)")}
        >
          <Text style={styles.closeText}>×</Text>
        </TouchableOpacity>

        <Text style={styles.loadingText}>Loading drafts...</Text>
      </View>
    );
  }

  if (drafts.length === 0) {
    return (
      <View style={styles.container}>
        {/* Close Button */}
        <TouchableOpacity
          style={[styles.closeButton, { top: insets.top + 20 }]}
          onPress={() => router.push("/(tabs)")}
        >
          <Text style={styles.closeText}>×</Text>
        </TouchableOpacity>

        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>No Drafts</Text>
          <Text style={styles.emptySubtitle}>
            Your saved recording and uploaded video drafts will appear here
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Close Button */}
      <TouchableOpacity
        style={[styles.closeButton, { top: insets.top + 20 }]}
        onPress={() => router.dismiss()}
      >
        <Text style={styles.closeText}>×</Text>
      </TouchableOpacity>

      <View style={[styles.header, { paddingTop: insets.top + 20 }]}>
        <Text style={styles.headerTitle}>Drafts</Text>
        <Text style={styles.headerSubtitle}>Tap to continue recording</Text>
      </View>

      <FlatList
        data={drafts}
        renderItem={renderDraftItem}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  actionsContainer: {
    flexDirection: "row",
    alignItems: "center",
  },
  modeTag: {
    backgroundColor: "#2a2a2a",
    padding: 4,
    borderRadius: 4,
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  header: {
    padding: 20,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#ffffff",
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 16,
    color: "#888888",
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 20,
    paddingTop: 0,
  },
  draftItem: {
    backgroundColor: "#1a1a1a",
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#333",
  },
  draftContent: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
  },
  thumbnail: {
    width: 50,
    height: 50,
    borderRadius: 6,
    backgroundColor: "#333",
    marginRight: 10,
  },
  draftInfo: {
    flex: 1,
  },
  draftName: {
    fontSize: 16,
    fontWeight: "700",
    color: "#ffffff",
    marginBottom: 4,
  },
  draftNameInput: {
    fontSize: 16,
    fontWeight: "700",
    color: "#ffffff",
    backgroundColor: "#2a2a2a",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "#444",
    minHeight: 24,
    marginBottom: 4,
  },
  draftTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#ffffff",
    marginBottom: 2,
  },
  draftDate: {
    fontSize: 11,
    color: "#666666",
    lineHeight: 14,
  },
  deleteButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255, 0, 0, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 12,
  },
  deleteText: {
    color: "#ff0000",
    fontSize: 20,
    fontWeight: "600",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#ffffff",
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 16,
    color: "#888888",
    textAlign: "center",
    lineHeight: 24,
  },
  loadingText: {
    fontSize: 18,
    color: "#ffffff",
    textAlign: "center",
    marginTop: 100,
  },
  closeButton: {
    position: "absolute",
    top: 80,
    right: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  closeText: {
    color: "#ffffff",
    fontSize: 26,
    fontWeight: "300",
    fontFamily: "Roboto-Regular",
    textAlign: "center",
    textAlignVertical: "center",
    includeFontPadding: false,
  },
});

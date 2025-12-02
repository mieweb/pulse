import { Draft, DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { DraftTransfer } from "@/utils/draftTransfer";
import { DRAFT_NAME_LENGTH } from "@/constants/camera";
import AsyncStorage from "@react-native-async-storage/async-storage";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Alert,
  ActivityIndicator,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

export default function DraftsScreen() {
  const insets = useSafeAreaInsets();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftNameInput, setDraftNameInput] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);

  useEffect(() => {
    loadDrafts();
  }, []);

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
    if (isSelectionMode) {
      handleToggleSelection(draft.id);
    } else {
      router.push({
        pathname: "/(camera)/shorts",
        params: {
          draftId: draft.id,
          mode: draft.mode,
        },
      });
    }
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
    if (isSelectionMode) {
      handleToggleSelection(draft.id);
    } else {
      setDraftNameInput(draft.name || "");
      setEditingDraftId(draft.id);
    }
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

  const handleToggleSelection = (draftId: string) => {
    const newSelected = new Set(selectedDraftIds);
    if (newSelected.has(draftId)) {
      newSelected.delete(draftId);
    } else {
      newSelected.add(draftId);
    }
    setSelectedDraftIds(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedDraftIds.size === drafts.length) {
      setSelectedDraftIds(new Set());
    } else {
      setSelectedDraftIds(new Set(drafts.map(d => d.id)));
    }
  };

  const handleExportSelected = async () => {
    if (selectedDraftIds.size === 0) {
      Alert.alert("No Selection", "Please select at least one draft to export.");
      return;
    }

    setExporting(true);
    try {
      const draftIds = Array.from(selectedDraftIds);
      const backupUri = await DraftTransfer.exportSelectedDrafts(draftIds);
      const isAvailable = await Sharing.isAvailableAsync();
      if (isAvailable) {
        await Sharing.shareAsync(backupUri, {
          mimeType: 'application/json',
          dialogTitle: 'Share Pulse Drafts',
          UTI: 'public.json',
        });
      }
      Alert.alert("Success", `${draftIds.length} draft${draftIds.length > 1 ? 's' : ''} exported successfully!`);
      setSelectedDraftIds(new Set());
      setIsSelectionMode(false);
    } catch (error) {
      console.error("Error exporting drafts:", error);
      Alert.alert("Export Failed", "Failed to export drafts. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  const handleImportDraft = async () => {
    setImporting(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        // Allow all file types so .pulse files can be selected
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        setImporting(false);
        return;
      }

      const uri = result.assets[0].uri;
      console.log('[DraftsScreen] Importing from:', uri);

      // Check if it's a backup (all drafts) or single draft
      const content = await FileSystem.readAsStringAsync(uri);
      const parsed = JSON.parse(content);

      if (parsed.version) {
        // Single draft import
        await DraftTransfer.importDraft(uri);
        Alert.alert("Success", "Draft imported successfully!");
      } else {
        // Backup import (all drafts)
        const importedIds = await DraftTransfer.importAllDrafts(uri);
        Alert.alert(
          "Success",
          `Imported ${importedIds.length} draft${importedIds.length > 1 ? 's' : ''} successfully!`
        );
      }

      await loadDrafts();
    } catch (error) {
      console.error("Error importing draft:", error);
      Alert.alert("Import Failed", "Failed to import draft. Please check the file and try again.");
    } finally {
      setImporting(false);
    }
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
    const totalRecordedDuration = item.segments.reduce(
      (total, segment) => total + segment.duration,
      0
    );

    const isSelected = selectedDraftIds.has(item.id);
    
    return (
      <TouchableOpacity
        style={[
          styles.draftItem,
          isSelected && styles.draftItemSelected
        ]}
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
              {item.segments.length !== 1 ? "s" : ""} • {" "}
              {formatDuration(Math.round(totalRecordedDuration))}/
              {formatDuration(item.totalDuration)}
            </Text>
            <Text style={styles.draftDate}>
              Created: {formatDate(item.createdAt)}
            </Text>
          </View>
          <View style={styles.actionsContainer}>
            {isSelectionMode ? (
              <TouchableOpacity
                style={styles.checkbox}
                onPress={() => handleToggleSelection(item.id)}
              >
                <MaterialIcons
                  name={selectedDraftIds.has(item.id) ? "check-box" : "check-box-outline-blank"}
                  size={24}
                  color={selectedDraftIds.has(item.id) ? "#007AFF" : "#888888"}
                />
              </TouchableOpacity>
            ) : (
              <>
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
              </>
            )}
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
        <TouchableOpacity
          style={[styles.closeButton, { top: insets.top + 20 }]}
          onPress={() => router.push("/(tabs)")}
        >
          <Text style={styles.closeText}>×</Text>
        </TouchableOpacity>

        <View style={[styles.header, { paddingTop: insets.top + 20 }]}>
          <Text style={styles.headerTitle}>Drafts</Text>
          <Text style={styles.headerSubtitle}>Tap to continue recording</Text>
          
          <View style={styles.controlsContainer}>
            <TouchableOpacity
              style={styles.controlButton}
              onPress={handleImportDraft}
              disabled={importing || exporting}
            >
              {importing ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <MaterialIcons name="file-download" size={20} color="#ffffff" />
                  <Text style={styles.controlButtonText}>Import</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>

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
          <View>
            <Text style={styles.headerTitle}>Drafts</Text>
            <Text style={styles.headerSubtitle}>Tap to continue recording</Text>
          </View>
          
          <View style={styles.controlsContainer}>
            <TouchableOpacity
              style={styles.controlButton}
              onPress={handleImportDraft}
              disabled={importing || exporting}
            >
              {importing ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <MaterialIcons name="file-download" size={20} color="#ffffff" />
                  <Text style={styles.controlButtonText}>Import</Text>
                </>
              )}
            </TouchableOpacity>
            
            {isSelectionMode ? (
              <>
                <TouchableOpacity
                  style={[styles.controlButton, selectedDraftIds.size === 0 && styles.controlButtonDisabled]}
                  onPress={handleExportSelected}
                  disabled={importing || exporting || selectedDraftIds.size === 0}
                >
                  {exporting ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <>
                      <MaterialIcons name="file-upload" size={20} color="#ffffff" />
                      <Text style={styles.controlButtonText}>
                        Export {selectedDraftIds.size > 0 ? `(${selectedDraftIds.size})` : ''}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.controlButton}
                  onPress={() => {
                    setIsSelectionMode(false);
                    setSelectedDraftIds(new Set());
                  }}
                >
                  <Text style={styles.controlButtonText}>Cancel</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity
                style={styles.controlButton}
                onPress={() => setIsSelectionMode(true)}
                disabled={importing || exporting || drafts.length === 0}
              >
                <MaterialIcons name="file-upload" size={20} color="#ffffff" />
                <Text style={styles.controlButtonText}>Export</Text>
              </TouchableOpacity>
            )}
          </View>
          
          {isSelectionMode && (
            <TouchableOpacity
              style={styles.selectAllButton}
              onPress={handleSelectAll}
            >
              <Text style={styles.selectAllText}>
                {selectedDraftIds.size === drafts.length ? "Deselect All" : "Select All"}
              </Text>
            </TouchableOpacity>
          )}
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
  selectAllButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginTop: 4,
    alignSelf: "flex-start",
  },
  selectAllText: {
    color: "#007AFF",
    fontSize: 16,
    fontWeight: "600",
  },
  controlsContainer: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  controlButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "#333",
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 8,
  },
  controlButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  controlButtonDisabled: {
    opacity: 0.5,
  },
  checkbox: {
    padding: 4,
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
  draftItemSelected: {
    borderColor: "#007AFF",
    borderWidth: 2,
    backgroundColor: "#1a1a2a",
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
    fontSize: 13,
    color: "#666666",
    lineHeight: 16,
    marginTop: 4,
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
    marginTop: -60,
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

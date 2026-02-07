import { Draft, DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import { DraftTransfer } from "@/utils/draftTransfer";
import { DRAFT_NAME_LENGTH } from "@/constants/camera";
import { Colors } from "@/constants/Colors";
import { useColorScheme } from "@/hooks/useColorScheme";
import AsyncStorage from "@react-native-async-storage/async-storage";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
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
import { useFocusEffect } from "@react-navigation/native";

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() ?? "light";
  const colors = Colors[colorScheme];
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftNameInput, setDraftNameInput] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);

  const loadDrafts = useCallback(async () => {
    try {
      const savedDrafts = await DraftStorage.getAllDrafts();
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
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadDrafts();
    }, [loadDrafts])
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        actionsContainer: {
          flexDirection: "row",
          alignItems: "center",
        },
        modeTag: {
          backgroundColor: colors.inputBackground,
          padding: 4,
          borderRadius: 4,
          width: 22,
          height: 22,
          alignItems: "center",
          justifyContent: "center",
        },
        uploadDestination: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          marginTop: 4,
        },
        uploadDestinationText: {
          fontSize: 12,
          color: colors.secondaryText,
          flex: 1,
        },
        container: {
          flex: 1,
          backgroundColor: colors.background,
        },
        header: {
          padding: 20,
        },
        headerTitle: {
          fontSize: 24,
          fontWeight: "bold",
          color: colors.text,
          marginBottom: 4,
        },
        headerSubtitle: {
          fontSize: 16,
          color: colors.secondaryText,
        },
        selectAllButton: {
          paddingVertical: 4,
          paddingHorizontal: 8,
          marginTop: 4,
          alignSelf: "flex-start",
        },
        selectAllText: {
          color: colors.selection,
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
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
          paddingVertical: 12,
          paddingHorizontal: 16,
          gap: 8,
        },
        controlButtonText: {
          color: colors.text,
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
          backgroundColor: colors.surface,
          borderRadius: 10,
          marginBottom: 8,
          borderWidth: 1,
          borderColor: colors.border,
        },
        draftItemSelected: {
          borderColor: colors.selection,
          borderWidth: 2,
          backgroundColor:
            colorScheme === "dark"
              ? "rgba(10, 132, 255, 0.15)"
              : "rgba(10, 132, 255, 0.08)",
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
          backgroundColor: colors.border,
          marginRight: 10,
        },
        draftInfo: {
          flex: 1,
        },
        draftName: {
          fontSize: 16,
          fontWeight: "700",
          color: colors.text,
          marginBottom: 4,
        },
        draftNameInput: {
          fontSize: 16,
          fontWeight: "700",
          color: colors.text,
          backgroundColor: colors.inputBackground,
          borderRadius: 6,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderWidth: 1,
          borderColor: colors.border,
          minHeight: 24,
          marginBottom: 4,
        },
        draftTitle: {
          fontSize: 14,
          fontWeight: "600",
          color: colors.text,
          marginBottom: 2,
        },
        draftDate: {
          fontSize: 13,
          color: colors.secondaryText,
          lineHeight: 16,
          marginTop: 4,
        },
        deleteButton: {
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: "rgba(244, 67, 54, 0.15)",
          justifyContent: "center",
          alignItems: "center",
          marginLeft: 12,
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
          color: colors.text,
          marginBottom: 8,
        },
        emptySubtitle: {
          fontSize: 16,
          color: colors.secondaryText,
          textAlign: "center",
          lineHeight: 24,
        },
        loadingText: {
          fontSize: 18,
          color: colors.text,
          textAlign: "center",
          marginTop: 100,
        },
      }),
    [colors, colorScheme]
  );

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
      setSelectedDraftIds(new Set(drafts.map((d) => d.id)));
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
          mimeType: "application/json",
          dialogTitle: "Share Pulse Drafts",
          UTI: "public.json",
        });
      }
      Alert.alert(
        "Success",
        `${draftIds.length} draft${draftIds.length > 1 ? "s" : ""} exported successfully!`
      );
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
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        setImporting(false);
        return;
      }

      const uri = result.assets[0].uri;
      console.log("[HomeScreen] Importing from:", uri);

      const content = await FileSystem.readAsStringAsync(uri);
      const parsed = JSON.parse(content);

      if (parsed.version) {
        await DraftTransfer.importDraft(uri);
        Alert.alert("Success", "Draft imported successfully!");
      } else {
        const importedIds = await DraftTransfer.importAllDrafts(uri);
        Alert.alert(
          "Success",
          `Imported ${importedIds.length} draft${importedIds.length > 1 ? "s" : ""} successfully!`
        );
      }

      await loadDrafts();
    } catch (error) {
      console.error("Error importing draft:", error);
      Alert.alert(
        "Import Failed",
        "Failed to import draft. Please check the file and try again."
      );
    } finally {
      setImporting(false);
    }
  };

  const formatDuration = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const getEffectiveDuration = (segment: any): number => {
    if (
      segment.trimStartTimeMs !== undefined &&
      segment.trimEndTimeMs !== undefined &&
      segment.trimStartTimeMs >= 0 &&
      segment.trimEndTimeMs > segment.trimStartTimeMs
    ) {
      return (segment.trimEndTimeMs - segment.trimStartTimeMs) / 1000;
    }
    return segment.recordedDurationSeconds;
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
    const totalRecordedDurationSeconds = item.segments.reduce(
      (total, segment) => total + getEffectiveDuration(segment),
      0
    );

    const isSelected = selectedDraftIds.has(item.id);

    return (
      <TouchableOpacity
        style={[
          styles.draftItem,
          isSelected && styles.draftItemSelected,
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
                placeholderTextColor={colors.secondaryText}
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
              {item.segments.length !== 1 ? "s" : ""} •{" "}
              {formatDuration(Math.round(totalRecordedDurationSeconds))}/
              {formatDuration(item.maxDurationLimitSeconds)}
            </Text>
            <Text style={styles.draftDate}>
              Created: {formatDate(item.createdAt)}
            </Text>
            {item.mode === "upload" && (
              <View style={styles.uploadDestination}>
                <MaterialIcons name="link" size={14} color={colors.secondaryText} />
                {item.uploadConfig?.server ? (
                  <Text style={styles.uploadDestinationText} numberOfLines={2}>
                    {item.uploadConfig.server}
                  </Text>
                ) : (
                  <Text style={[styles.uploadDestinationText, { fontStyle: "italic", color: colors.secondaryText }]} numberOfLines={2}>
                    Server not set up for upload
                  </Text>
                )}
              </View>
            )}
          </View>
          <View style={styles.actionsContainer}>
            {isSelectionMode ? (
              <TouchableOpacity
                style={styles.checkbox}
                onPress={() => handleToggleSelection(item.id)}
              >
                <MaterialIcons
                  name={
                    selectedDraftIds.has(item.id)
                      ? "check-box"
                      : "check-box-outline-blank"
                  }
                  size={24}
                  color={selectedDraftIds.has(item.id) ? colors.selection : colors.secondaryText}
                />
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity
                  style={styles.deleteButton}
                  onPress={() => handleDeleteDraft(item.id)}
                >
                  <MaterialIcons name="delete-outline" size={18} color={colors.error} />
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
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Text style={styles.loadingText}>Loading drafts...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Welcome to Pulse</Text>
        <Text style={styles.headerSubtitle}>
          Tap a draft to continue recording, or use + to start a new one
        </Text>

        <View style={styles.controlsContainer}>
          <TouchableOpacity
            style={styles.controlButton}
            onPress={handleImportDraft}
            disabled={importing || exporting}
          >
            {importing ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <>
                <MaterialIcons name="file-download" size={20} color={colors.text} />
                <Text style={styles.controlButtonText}>Import</Text>
              </>
            )}
          </TouchableOpacity>

          {isSelectionMode ? (
            <>
              <TouchableOpacity
                style={[
                  styles.controlButton,
                  selectedDraftIds.size === 0 && styles.controlButtonDisabled,
                ]}
                onPress={handleExportSelected}
                disabled={
                  importing || exporting || selectedDraftIds.size === 0
                }
              >
                {exporting ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <>
                    <MaterialIcons
                      name="file-upload"
                      size={20}
                      color={colors.text}
                    />
                    <Text style={styles.controlButtonText}>
                      Export{" "}
                      {selectedDraftIds.size > 0
                        ? `(${selectedDraftIds.size})`
                        : ""}
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
          ) : drafts.length > 0 ? (
            <TouchableOpacity
              style={styles.controlButton}
              onPress={() => setIsSelectionMode(true)}
              disabled={importing || exporting}
            >
              <MaterialIcons name="file-upload" size={20} color={colors.text} />
              <Text style={styles.controlButtonText}>Export</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {isSelectionMode && (
          <TouchableOpacity
            style={styles.selectAllButton}
            onPress={handleSelectAll}
          >
            <Text style={styles.selectAllText}>
              {selectedDraftIds.size === drafts.length
                ? "Deselect All"
                : "Select All"}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {drafts.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>No drafts yet</Text>
          <Text style={styles.emptySubtitle}>
            Tap the + button to open the camera and start a new draft
          </Text>
        </View>
      ) : (
        <FlatList
          data={drafts}
          renderItem={renderDraftItem}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={styles.listContent}
        />
      )}
    </View>
  );
}

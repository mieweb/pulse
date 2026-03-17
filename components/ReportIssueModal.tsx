import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  GestureResponderEvent,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { ThemedText } from "@/components/ThemedText";
import { Colors } from "@/constants/Colors";
import { useColorScheme } from "@/hooks/useColorScheme";
import { submitIssueReport } from "@/utils/reportIssue";

interface ReportIssueModalProps {
  visible: boolean;
  onClose: () => void;
}

export function ReportIssueModal({ visible, onClose }: ReportIssueModalProps) {
  const colorScheme = useColorScheme();
  const colors = colorScheme === "dark" ? Colors.dark : Colors.light;

  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [includeDraftFolder, setIncludeDraftFolder] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => !!summary.trim() && !!description.trim() && !isSubmitting,
    [description, isSubmitting, summary]
  );

  const resetAndClose = () => {
    setSummary("");
    setDescription("");
    setIncludeDraftFolder(false);
    setErrorMessage(null);
    onClose();
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      setErrorMessage("Summary and description are required.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await submitIssueReport({
        summary,
        description,
        includeDraftFolder,
      });

      Alert.alert("Issue reported", "Thanks. Your report was sent to Pulse Vault.", [
        { text: "OK", onPress: resetAndClose },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to submit issue report.";
      console.error(error)
      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={resetAndClose}
    >
      <Pressable style={styles.backdrop} onPress={resetAndClose}>
        <Pressable
          style={[
            styles.modalCard,
            {
              backgroundColor: colors.background,
              borderColor: colors.border,
            },
          ]}
          onPress={(event: GestureResponderEvent) => event.stopPropagation()}
        >
          <View style={styles.headerRow}>
            <ThemedText type="subtitle" style={styles.title}>
              Report an Issue
            </ThemedText>
            <Pressable
              accessibilityLabel="Close report issue form"
              disabled={isSubmitting}
              onPress={resetAndClose}
              style={styles.closeButton}
            >
              <MaterialIcons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          <ThemedText style={[styles.label, { color: colors.secondaryText }]}>Summary</ThemedText>
          <TextInput
            editable={!isSubmitting}
            onChangeText={setSummary}
            placeholder="Brief summary"
            placeholderTextColor={colors.secondaryText}
            style={[
              styles.input,
              {
                backgroundColor: colors.inputBackground,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
            value={summary}
          />

          <ThemedText style={[styles.label, { color: colors.secondaryText }]}>Description</ThemedText>
          <TextInput
            editable={!isSubmitting}
            multiline
            numberOfLines={5}
            onChangeText={setDescription}
            placeholder="Describe what happened and how to reproduce it"
            placeholderTextColor={colors.secondaryText}
            style={[
              styles.input,
              styles.descriptionInput,
              {
                backgroundColor: colors.inputBackground,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
            textAlignVertical="top"
            value={description}
          />

          <Pressable
            disabled={isSubmitting}
            onPress={() => setIncludeDraftFolder((prev: boolean) => !prev)}
            style={styles.checkboxRow}
          >
            <View
              style={[
                styles.checkbox,
                {
                  borderColor: colors.border,
                  backgroundColor: includeDraftFolder
                    ? colors.selection
                    : "transparent",
                },
              ]}
            >
              {includeDraftFolder ? (
                <MaterialIcons name="check" size={15} color="#FFFFFF" />
              ) : null}
            </View>
            <ThemedText style={styles.checkboxLabel}>Include draft folder</ThemedText>
          </Pressable>

          {errorMessage ? (
            <ThemedText style={[styles.errorText, { color: colors.error }]}>
              {errorMessage}
            </ThemedText>
          ) : null}

          <Pressable
            disabled={!canSubmit}
            onPress={handleSubmit}
            style={[
              styles.submitButton,
              {
                backgroundColor: canSubmit ? colors.appPrimary : colors.border,
              },
            ]}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <ThemedText style={styles.submitButtonText}>Submit</ThemedText>
            )}
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  modalCard: {
    width: "100%",
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    maxWidth: 460,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  title: {
    fontSize: 20,
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    marginTop: 10,
    marginBottom: 6,
    fontFamily: "Roboto-Bold",
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Roboto-Regular",
    fontSize: 15,
  },
  descriptionInput: {
    minHeight: 110,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 14,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxLabel: {
    marginLeft: 10,
    fontSize: 14,
  },
  errorText: {
    marginTop: 12,
    fontFamily: "Roboto-Regular",
  },
  submitButton: {
    marginTop: 14,
    height: 46,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  submitButtonText: {
    color: "#FFFFFF",
    fontFamily: "Roboto-Bold",
    fontSize: 16,
  },
});

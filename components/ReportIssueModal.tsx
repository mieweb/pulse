import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as React from "react";
import {
  ActivityIndicator,
  GestureResponderEvent,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { ThemedText } from "@/components/ThemedText";
import { Colors } from "@/constants/Colors";
import { useColorScheme } from "@/hooks/useColorScheme";
import {
  SubmitIssueReportProgress,
  SubmitIssueReportResult,
  submitIssueReport,
} from "@/utils/reportIssue";
import {
  notifyBackgroundBugReportResult,
} from "@/utils/localNotification";

interface ReportIssueModalProps {
  visible: boolean;
  onClose: () => void;
}

export function ReportIssueModal({ visible, onClose }: ReportIssueModalProps) {
  const colorScheme = useColorScheme();
  const colors = colorScheme === "dark" ? Colors.dark : Colors.light;

  const [summary, setSummary] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [includeDraftFolder, setIncludeDraftFolder] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [submittedIssue, setSubmittedIssue] = React.useState<SubmitIssueReportResult | null>(null);
  const [submitProgress, setSubmitProgress] = React.useState(0);
  const [submitProgressMessage, setSubmitProgressMessage] = React.useState("");
  const [showBackgroundUploadButton, setShowBackgroundUploadButton] = React.useState(false);
  const [activeSubmissionToken, setActiveSubmissionToken] = React.useState<string | null>(null);
  const backgroundEnabledByTokenRef = React.useRef<Map<string, boolean>>(new Map());

  const normalizedSummary = summary.trim();
  const normalizedDescription = description.trim();

  const canUploadInBackground = showBackgroundUploadButton && isSubmitting;
  const isBusy = isSubmitting;

  const canSubmit = React.useMemo(
    () => !!normalizedSummary && !!normalizedDescription && !isSubmitting,
    [isSubmitting, normalizedDescription, normalizedSummary]
  );

  const resetAndClose = React.useCallback(() => {
    setSummary("");
    setDescription("");
    setIncludeDraftFolder(false);
    setErrorMessage(null);
    setSubmittedIssue(null);
    setSubmitProgress(0);
    setSubmitProgressMessage("");
    setShowBackgroundUploadButton(false);
    setActiveSubmissionToken(null);
    onClose();
  }, [onClose]);

  const handleSubmitProgress = React.useCallback(
    (progressUpdate: SubmitIssueReportProgress) => {
      setSubmitProgress(progressUpdate.progress);
      if (progressUpdate.message) {
        setSubmitProgressMessage(progressUpdate.message);
        return;
      }

      if (progressUpdate.phase === "uploading") {
        const pct = Math.round(progressUpdate.progress * 100);
        setSubmitProgressMessage(`Uploading report... ${pct}%`);
      } else if (progressUpdate.phase === "finalizing") {
        setSubmitProgressMessage("Finalizing issue report...");
      } else {
        setSubmitProgressMessage("Preparing payload...");
      }
    },
    []
  );

  const handleOpenIssueUrl = async () => {
    if (!submittedIssue?.issueUrl) return;
    try {
      const supported = await Linking.canOpenURL(submittedIssue.issueUrl);
      if (!supported) {
        setErrorMessage("Unable to open issue URL on this device.");
        return;
      }
      await Linking.openURL(submittedIssue.issueUrl);
    } catch {
      setErrorMessage("Unable to open issue URL on this device.");
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      setErrorMessage("Summary and description are required.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setSubmitProgress(0);
    setSubmitProgressMessage("Preparing payload...");

    const currentSubmissionToken = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    backgroundEnabledByTokenRef.current.set(currentSubmissionToken, false);
    setActiveSubmissionToken(currentSubmissionToken);
    setShowBackgroundUploadButton(includeDraftFolder);

    try {
      const result = await submitIssueReport(
        {
          summary,
          description,
          includeDraftFolder,
        },
        handleSubmitProgress
      );

      const shouldNotifyInBackground =
        backgroundEnabledByTokenRef.current.get(currentSubmissionToken) === true;

      if (shouldNotifyInBackground) {
        void notifyBackgroundBugReportResult(true, result.issueUrl);
      } else {
        setSubmittedIssue(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to submit issue report.";
      console.error(error);

      const shouldNotifyInBackground =
        backgroundEnabledByTokenRef.current.get(currentSubmissionToken) === true;

      if (shouldNotifyInBackground) {
        void notifyBackgroundBugReportResult(false);
      } else {
        setErrorMessage(message);
      }
    } finally {
      backgroundEnabledByTokenRef.current.delete(currentSubmissionToken);
      setShowBackgroundUploadButton(false);
      setActiveSubmissionToken(null);
      setIsSubmitting(false);
    }
  };

  const handleUploadInBackground = React.useCallback(() => {
    if (!canUploadInBackground || !activeSubmissionToken) {
      return;
    }

    backgroundEnabledByTokenRef.current.set(activeSubmissionToken, true);
    resetAndClose();
  }, [activeSubmissionToken, canUploadInBackground, resetAndClose]);

  return (
    <Modal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={() => {
        if (isBusy) return;
        resetAndClose();
      }}
    >
      <Pressable
        style={styles.backdrop}
        onPress={() => {
          if (isBusy) return;
          resetAndClose();
        }}
      >
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
              disabled={isBusy}
              onPress={resetAndClose}
              style={styles.closeButton}
            >
              <MaterialIcons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          {submittedIssue ? (
            <View>
              <ThemedText style={[styles.successText, { color: colors.text }]}> 
                {`Issue created successfully. Thank you for the feedback. We will work on it.`}
              </ThemedText>

              <Pressable
                disabled={!submittedIssue.issueUrl}
                onPress={handleOpenIssueUrl}
                style={[
                  styles.secondaryButton,
                  {
                    borderColor: colors.selection,
                    backgroundColor: colors.background,
                    opacity: submittedIssue.issueUrl ? 1 : 0.6,
                  },
                ]}
              >
                <ThemedText style={[styles.secondaryButtonText, { color: colors.selection }]}>Open GitHub URL</ThemedText>
              </Pressable>

              <Pressable
                onPress={resetAndClose}
                style={[
                  styles.submitButton,
                  {
                    backgroundColor: colors.appPrimary,
                  },
                ]}
              >
                <ThemedText style={styles.submitButtonText}>Close</ThemedText>
              </Pressable>
            </View>
          ) : (
            <>
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

              {includeDraftFolder ? (
                <ThemedText style={[styles.noteText, { color: colors.secondaryText }]}> 
                  Note: This draft folder will become publicly accessible on GitHub once you upload it.
                </ThemedText>
              ) : null}

              {isSubmitting ? (
                <View style={styles.progressContainer}>
                  <View style={[styles.progressTrack, { backgroundColor: colors.border }]}> 
                    <View
                      style={[
                        styles.progressFill,
                        {
                          backgroundColor: colors.appPrimary,
                          width: `${Math.max(5, Math.round(submitProgress * 100))}%`,
                        },
                      ]}
                    />
                  </View>
                  <ThemedText style={[styles.progressText, { color: colors.secondaryText }]}> 
                    {submitProgressMessage || "Uploading report..."}
                  </ThemedText>
                </View>
              ) : null}

              {errorMessage ? (
                <ThemedText style={[styles.errorText, { color: colors.error }]}> 
                  {errorMessage}
                </ThemedText>
              ) : null}

              <View style={styles.footerButtons}>
                {showBackgroundUploadButton ? (
                  <Pressable
                    disabled={!canUploadInBackground}
                    onPress={handleUploadInBackground}
                    style={[
                      styles.secondaryFooterButton,
                      {
                        borderColor: canUploadInBackground ? colors.selection : colors.border,
                        backgroundColor: colors.background,
                        opacity: canUploadInBackground ? 1 : 0.6,
                      },
                    ]}
                  >
                    <ThemedText style={[styles.secondaryButtonText, { color: colors.selection }]}>Upload in Background</ThemedText>
                  </Pressable>
                ) : null}

                <Pressable
                  disabled={!canSubmit}
                  onPress={handleSubmit}
                  style={[
                    styles.submitButton,
                    showBackgroundUploadButton ? styles.footerButtonHalf : null,
                    {
                      backgroundColor: canSubmit ? colors.appPrimary : colors.border,
                    },
                  ]}
                >
                  {isSubmitting ? (
                    <View style={styles.submitProgressInline}>
                      <ActivityIndicator color="#FFFFFF" />
                      <ThemedText style={styles.submitButtonText}>
                        {`${Math.round(submitProgress * 100)}%`}
                      </ThemedText>
                    </View>
                  ) : (
                    <ThemedText style={styles.submitButtonText}>Submit</ThemedText>
                  )}
                </Pressable>
              </View>
            </>
          )}
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
  noteText: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: "Roboto-Regular",
  },
  progressContainer: {
    marginTop: 12,
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
  },
  progressText: {
    marginTop: 6,
    fontSize: 13,
    fontFamily: "Roboto-Regular",
  },
  errorText: {
    marginTop: 12,
    fontFamily: "Roboto-Regular",
  },
  successText: {
    marginTop: 10,
    marginBottom: 16,
    fontFamily: "Roboto-Regular",
    fontSize: 15,
    lineHeight: 22,
  },
  secondaryButton: {
    borderWidth: 1,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  secondaryButtonText: {
    fontFamily: "Roboto-Bold",
    fontSize: 15,
  },
  footerButtons: {
    marginTop: 14,
    flexDirection: "row",
    gap: 10,
  },
  secondaryFooterButton: {
    flex: 1,
    borderWidth: 1,
    height: 46,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  footerButtonHalf: {
    flex: 1,
    marginTop: 0,
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
  submitProgressInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
});

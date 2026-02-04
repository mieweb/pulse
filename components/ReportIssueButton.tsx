import { MaterialIcons } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Alert,
  Modal,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
  Keyboard,
  Linking,
  Text,
} from "react-native";
import { ThemedText } from "./ThemedText";
import { Colors } from "@/constants/Colors";
import { useColorScheme } from "@/hooks/useColorScheme";
import { DraftTransfer } from "@/utils/draftTransfer";
import * as FileSystem from 'expo-file-system';

// API Configuration
// For USB connected devices, use localhost with ADB port forwarding
// Run: adb reverse tcp:3000 tcp:3000
const API_BASE_URL = "http://localhost:3000"; // TODO: Need to be updated from the User configuration on login.

interface IssueResponse {
  success: boolean;
  message: string;
  githubIssueUrl?: string;
  issueNumber?: number;
  issueUuid?: string;
  zipFileStored?: boolean;
  storageLocation?: string;
}

interface ReportIssueButtonProps {
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export default function ReportIssueButton({
  position = "top-right",
  top,
  bottom,
  left,
  right,
}: ReportIssueButtonProps) {
  const colorScheme = useColorScheme();
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [issueTitle, setIssueTitle] = useState("Test");
  const [issueDescription, setIssueDescription] = useState("Test Desc");
  const [zipFolder, setZipFolder] = useState(false);
  const [successResponse, setSuccessResponse] = useState<IssueResponse | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);

  const handleOpenModal = () => {
    setIsModalVisible(true);
  };

  const handleCloseModal = () => {
    setIsModalVisible(false);
    setIssueTitle("");
    setIssueDescription("");
    setZipFolder(false);
  };
  const showAlert = () => {
    Alert.alert(
        "Issue Reported",
        "Thank you for reporting this issue. We'll look into it."
      );
  }

  const handleSubmit = async () => {
    if (issueTitle.trim() === "") {
      Alert.alert("Missing Title", "Please provide a title for the issue.");
      return;
    }
    if (issueDescription.trim() === "") {
      Alert.alert("Empty Issue", "Please describe the issue before submitting.");
      return;
    }

    // Dismiss keyboard first
    Keyboard.dismiss();

    // Close the modal immediately
    setIsModalVisible(false);
    const title = issueTitle;
    const description = issueDescription;
    const shouldZip = zipFolder;
    setIssueTitle("");
    setIssueDescription("");
    setZipFolder(false);

    try {
      let zipFilePath: string | null = null;
      
      // If checkbox is checked, package the user folder
      if (shouldZip) {
        console.log("[ReportIssue] Packaging user folder...");
        try {
          const packageResult = await DraftTransfer.exportUserFolderPackage();
          zipFilePath = packageResult.filePath;
          console.log(`[ReportIssue] Packaged ${packageResult.fileCount} files`);
          console.log(`[ReportIssue] File saved at: ${zipFilePath}`);
          
          // Verify the zip file exists and is valid before uploading
          if (zipFilePath && packageResult.fileCount === 0) {
            console.warn("[ReportIssue] Empty zip file created - skipping upload");
            zipFilePath = null;
          } else if (zipFilePath) {
            // Verify file exists and get size
            try {
              const cleanPath = zipFilePath.replace('file://', '');
              const fileInfo = await FileSystem.getInfoAsync(cleanPath);
              if (!fileInfo.exists) {
                console.warn("[ReportIssue] Zip file does not exist:", cleanPath);
                zipFilePath = null;
              } else {
                console.log(`[ReportIssue] Zip file verified: ${fileInfo.size} bytes`);
              }
            } catch (verifyError: any) {
              console.warn("[ReportIssue] Failed to verify zip file:", verifyError.message);
              zipFilePath = null;
            }
          }
        } catch (zipError: any) {
          console.warn("[ReportIssue] Failed to package folder:", zipError.message);
          // Continue without the zip file - don't show error since it's optional
          zipFilePath = null;
          console.log("[ReportIssue] Continuing without zip file");
        }
      }

      // Create FormData for multipart/form-data upload
      // IMPORTANT: Fields must come before file for backend to parse correctly
      const formData = new FormData();
      formData.append("description", description);
      formData.append("bug", title);
      // Add zip file if available (must come after text fields)
      if (zipFilePath) {
        console.log("[ReportIssue] Preparing zip file for upload:", zipFilePath);
        formData.append("zipFile", {
          uri: zipFilePath,
          type: "application/zip",
          name: "user-folder.zip",
        } as any);
        console.log("[ReportIssue] Added zip file to FormData");
      }
      
      console.log(`[ReportIssue] Sending request to: ${API_BASE_URL}/create_issue`);
      console.log(`[ReportIssue] FormData fields: description, bug ${zipFilePath ? ', zipFile' : ''}`);
      
      // Use fetch API - more reliable for file uploads in React Native
      const response = await fetch(`${API_BASE_URL}/create_issue`, {
        method: 'POST',
        body: formData,
        // Don't set Content-Type header - fetch will set it automatically with boundary
      });

      console.log(`[ReportIssue] Response status: ${response.status}`);

      if (response.ok) {
        const responseData: IssueResponse = await response.json();
        console.log("[ReportIssue] Success response:", responseData);
        setSuccessResponse(responseData);
        setShowSuccessModal(true);
      } else {
        console.log(`[ReportIssue] Error response status: ${response.status}`);
        const errorData = await response.json().catch(() => ({ message: "Unknown error" }));
        console.log("[ReportIssue] Error data:", errorData);
        Alert.alert(
          "Error",
          `Failed to report issue: ${errorData.message || "Unknown error"}`
        );
      }
    } catch (error: any) {
      console.error("Error reporting issue:", error);
      console.error("Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      Alert.alert(
        "Error",
        `Failed to report issue. Please check your connection and try again.\n\nDetails: ${error.message}`
      );
    }
  };

  const getPositionStyle = () => {
    const baseStyle: any = { position: "absolute", zIndex: 999 };
    
    if (top !== undefined) baseStyle.top = top;
    if (bottom !== undefined) baseStyle.bottom = bottom;
    if (left !== undefined) baseStyle.left = left;
    if (right !== undefined) baseStyle.right = right;

    // Apply default positions if not overridden
    if (top === undefined && bottom === undefined) {
      baseStyle.top = position.includes("top") ? 20 : undefined;
      baseStyle.bottom = position.includes("bottom") ? 20 : undefined;
    }
    if (left === undefined && right === undefined) {
      baseStyle.left = position.includes("left") ? 20 : undefined;
      baseStyle.right = position.includes("right") ? 20 : undefined;
    }

    return baseStyle;
  };

  return (
    <>
      <TouchableOpacity
        style={[styles.flagButton, getPositionStyle()]}
        onPress={handleOpenModal}
        activeOpacity={0.7}
      >
        <MaterialIcons
          name="flag"
          size={24}
          color={Colors[colorScheme ?? "light"].error}
        />
      </TouchableOpacity>

      <Modal
        visible={isModalVisible}
        transparent
        animationType="fade"
        onRequestClose={handleCloseModal}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalOverlay}
        >
          <Pressable
            style={styles.modalBackground}
            onPress={handleCloseModal}
          >
            <Pressable
              onPress={(e) => e.stopPropagation()}
            >
              <View
                style={[
                  styles.modalContent,
                  {
                    backgroundColor:
                      colorScheme === "dark"
                        ? Colors.dark.background
                        : Colors.light.background,
                  },
                ]}
              >
              <View style={styles.modalHeader}>
                <MaterialIcons
                  name="flag"
                  size={24}
                  color={Colors[colorScheme ?? "light"].error}
                />
                <ThemedText type="subtitle" style={styles.modalTitle}>
                  Report an Issue
                </ThemedText>
                <TouchableOpacity onPress={handleCloseModal}>
                  <MaterialIcons
                    name="close"
                    size={24}
                    color={Colors[colorScheme ?? "light"].text}
                  />
                </TouchableOpacity>
              </View>

              <ThemedText style={styles.modalDescription}>
                Please provide details about the issue you&#39;re experiencing:
              </ThemedText>

              <TextInput
                style={[
                  styles.titleInput,
                  {
                    color: Colors[colorScheme ?? "light"].text,
                    borderColor: Colors[colorScheme ?? "light"].icon,
                    backgroundColor:
                      colorScheme === "dark"
                        ? "rgba(255, 255, 255, 0.05)"
                        : "rgba(0, 0, 0, 0.02)",
                  },
                ]}
                placeholder="Issue title..."
                placeholderTextColor={Colors[colorScheme ?? "light"].icon}
                value={issueTitle}
                onChangeText={setIssueTitle}
                returnKeyType="next"
              />

              <ScrollView style={styles.scrollContainer}>
                <TextInput
                  style={[
                    styles.textInput,
                    {
                      color: Colors[colorScheme ?? "light"].text,
                      borderColor: Colors[colorScheme ?? "light"].icon,
                      backgroundColor:
                        colorScheme === "dark"
                          ? "rgba(255, 255, 255, 0.05)"
                          : "rgba(0, 0, 0, 0.02)",
                    },
                  ]}
                  placeholder="Describe the issue..."
                  placeholderTextColor={Colors[colorScheme ?? "light"].icon}
                  multiline
                  numberOfLines={6}
                  value={issueDescription}
                  onChangeText={setIssueDescription}
                  textAlignVertical="top"
                />
              </ScrollView>

              <TouchableOpacity
                style={styles.checkboxContainer}
                onPress={() => setZipFolder(!zipFolder)}
                activeOpacity={0.7}
              >
                <View
                  style={[
                    styles.checkbox,
                    {
                      borderColor: Colors[colorScheme ?? "light"].icon,
                      backgroundColor: zipFolder
                        ? Colors[colorScheme ?? "light"].appPrimary
                        : "transparent",
                    },
                  ]}
                >
                  {zipFolder && (
                    <MaterialIcons name="check" size={18} color="#fff" />
                  )}
                </View>
                <ThemedText style={styles.checkboxLabel}>
                  Zip the folder
                </ThemedText>
              </TouchableOpacity>

              <View style={styles.buttonContainer}>
                <TouchableOpacity
                  style={[
                    styles.button,
                    styles.cancelButton,
                    {
                      backgroundColor:
                        colorScheme === "dark"
                          ? "rgba(255, 255, 255, 0.1)"
                          : "rgba(0, 0, 0, 0.05)",
                    },
                  ]}
                  onPress={handleCloseModal}
                >
                  <ThemedText style={styles.buttonText}>Cancel</ThemedText>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.button,
                    styles.submitButton,
                    {
                      backgroundColor: Colors[colorScheme ?? "light"].appPrimary,
                    },
                  ]}
                  onPress={handleSubmit}
                >
                  <ThemedText
                    style={[
                      styles.buttonText,
                      { color: Colors.light.background },
                    ]}
                  >
                    Submit
                  </ThemedText>
                </TouchableOpacity>
              </View>
            </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Success Response Modal */}
      <Modal
        visible={showSuccessModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSuccessModal(false)}
      >
        <Pressable
          style={styles.modalBackground}
          onPress={() => setShowSuccessModal(false)}
        >
          <Pressable onPress={(e) => e.stopPropagation()}>
            <View
              style={[
                styles.modalContent,
                {
                  backgroundColor:
                    colorScheme === "dark"
                      ? Colors.dark.background
                      : Colors.light.background,
                },
              ]}
            >
              <View style={styles.successHeader}>
                <MaterialIcons
                  name="check-circle"
                  size={48}
                  color={Colors[colorScheme ?? "light"].appPrimary}
                />
                <ThemedText type="subtitle" style={styles.successTitle}>
                  Issue Reported Successfully!
                </ThemedText>
              </View>

              <ScrollView style={styles.successScrollView}>
              {successResponse && (
                <View style={styles.responseDetails}>
                  <ThemedText style={styles.responseMessage}>
                    {successResponse.message}
                  </ThemedText>

                  {successResponse.issueNumber && (
                    <View style={styles.detailRow}>
                      <MaterialIcons
                        name="tag"
                        size={20}
                        color={Colors[colorScheme ?? "light"].icon}
                      />
                      <ThemedText style={styles.detailLabel}>Issue #:</ThemedText>
                      <ThemedText style={styles.detailValue}>
                        {successResponse.issueNumber}
                      </ThemedText>
                    </View>
                  )}

                  {successResponse.issueUuid && (
                    <View style={styles.detailRow}>
                      <MaterialIcons
                        name="fingerprint"
                        size={20}
                        color={Colors[colorScheme ?? "light"].icon}
                      />
                      <ThemedText style={styles.detailLabel}>UUID:</ThemedText>
                      <ThemedText
                        style={[styles.detailValue, styles.uuidText]}
                        numberOfLines={1}
                      >
                        {successResponse.issueUuid}
                      </ThemedText>
                    </View>
                  )}

                  {successResponse.zipFileStored && (
                    <View style={styles.detailRow}>
                      <MaterialIcons
                        name="folder-zip"
                        size={20}
                        color={Colors[colorScheme ?? "light"].appPrimary}
                      />
                      <ThemedText style={styles.detailLabel}>Zip File:</ThemedText>
                      <ThemedText style={[styles.detailValue, styles.successText]}>
                        Stored
                      </ThemedText>
                    </View>
                  )}

                  {successResponse.githubIssueUrl && (
                    <TouchableOpacity
                      style={[
                        styles.githubButton,
                        {
                          backgroundColor:
                            Colors[colorScheme ?? "light"].appPrimary,
                        },
                      ]}
                      onPress={() => {
                        if (successResponse.githubIssueUrl) {
                          Linking.openURL(successResponse.githubIssueUrl);
                        }
                      }}
                    >
                      <MaterialIcons
                        name="open-in-new"
                        size={20}
                        color={Colors.light.background}
                      />
                      <ThemedText
                        style={[
                          styles.githubButtonText,
                          { color: Colors.light.background },
                        ]}
                      >
                        View on GitHub
                      </ThemedText>
                    </TouchableOpacity>
                  )}
                </View>
              )}
              </ScrollView>

              <View style={styles.closeButtonContainer}>
                <TouchableOpacity
                  style={[
                    styles.closeButton,
                    {
                      backgroundColor: Colors[colorScheme ?? "light"].appPrimary,
                    },
                  ]}
                  onPress={() => setShowSuccessModal(false)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.closeButtonText}>Close</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  flagButton: {
    width: 41,
    height: 41,
    borderRadius: 20,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  modalBackground: {
    flex: 1,
    width: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    width: "100%",
    maxWidth: 500,
    borderRadius: 16,
    padding: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  modalTitle: {
    flex: 1,
    marginLeft: 12,
    fontFamily: "Roboto-Bold",
  },
  modalDescription: {
    fontSize: 14,
    marginBottom: 16,
    opacity: 0.8,
    fontFamily: "Roboto-Regular",
  },
  titleInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    fontFamily: "Roboto-Regular",
    marginBottom: 12,
  },
  scrollContainer: {
    maxHeight: 200,
    marginBottom: 20,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    fontFamily: "Roboto-Regular",
    minHeight: 120,
  },
  checkboxContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 20,
    marginTop: 4,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 4,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  checkboxLabel: {
    fontSize: 14,
    fontFamily: "Roboto-Regular",
  },
  buttonContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelButton: {},
  submitButton: {},
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
    fontFamily: "Roboto-Bold",
  },
  successHeader: {
    alignItems: "center",
    marginBottom: 24,
  },
  successTitle: {
    marginTop: 12,
    textAlign: "center",
    fontFamily: "Roboto-Bold",
  },
  successScrollView: {
    maxHeight: 400,
  },
  responseDetails: {
    width: "100%",
  },
  responseMessage: {
    fontSize: 14,
    marginBottom: 20,
    textAlign: "center",
    opacity: 0.8,
    fontFamily: "Roboto-Regular",
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "rgba(128, 128, 128, 0.1)",
  },
  detailLabel: {
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 8,
    marginRight: 8,
    fontFamily: "Roboto-Bold",
  },
  detailValue: {
    fontSize: 14,
    flex: 1,
    fontFamily: "Roboto-Regular",
  },
  uuidText: {
    fontSize: 12,
    opacity: 0.7,
  },
  successText: {
    color: "#4CAF50",
    fontWeight: "600",
  },
  githubButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    marginTop: 16,
    marginBottom: 8,
  },
  githubButtonText: {
    fontSize: 16,
    fontWeight: "600",
    marginLeft: 8,
    fontFamily: "Roboto-Bold",
  },
  closeButtonContainer: {
  //   width: "100%",
  //   paddingTop: 16,
  },
  closeButton: {
    width: "100%",
    height: 48,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  closeButtonText: {
    fontSize: 16,
    fontWeight: "600",
    fontFamily: "Roboto-Bold",
    color: "#FFFFFF",
  },
});
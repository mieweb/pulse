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
} from "react-native";
import { ThemedText } from "./ThemedText";
import { Colors } from "@/constants/Colors";
import { useColorScheme } from "@/hooks/useColorScheme";

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
  const [issueDescription, setIssueDescription] = useState("");

  const handleOpenModal = () => {
    setIsModalVisible(true);
  };

  const handleCloseModal = () => {
    console.log("This is a close call")
    setIsModalVisible(false);
    setIssueDescription("");
  };
  const showAlert = () => {
    Alert.alert(
        "Issue Reported",
        "Thank you for reporting this issue. We'll look into it."
      );
  }

  const handleSubmit = () => {
    if (issueDescription.trim() === "") {
      Alert.alert("Empty Issue", "Please describe the issue before submitting.");
      return;
    }

    // Dismiss keyboard first
    Keyboard.dismiss();

    // TODO: Implement actual issue reporting logic
    console.log("Issue reported:", issueDescription);
    
    // Close the modal immediately
    setIsModalVisible(false);
    setIssueDescription("");
    // Show success alert after a short delay to allow modal to close smoothly
    showAlert()
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
                Please describe the issue you're experiencing:
              </ThemedText>

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
});

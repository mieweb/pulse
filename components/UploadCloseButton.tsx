import { ThemedText } from "@/components/ThemedText";
import React from "react";
import { StyleSheet, TouchableOpacity } from "react-native";

interface UploadCloseButtonProps {
  onClose: () => void;
}

export default function UploadCloseButton({ onClose }: UploadCloseButtonProps) {
  return (
    <TouchableOpacity style={styles.closeButton} onPress={onClose}>
      <ThemedText style={styles.closeText}>×</ThemedText>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  closeButton: {
    position: "absolute",
    top: 80,
    left: 20,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    width: 40,
    height: 40,
    borderRadius: 25,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  closeText: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "600",
    fontFamily: "Roboto-Bold",
    textAlign: "center",
    textAlignVertical: "center",
    includeFontPadding: false,
  },
});

import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import ReportIssueButton from "@/components/ReportIssueButton";
import React from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  
  return (
    <ThemedView
      style={{ flex: 1, justifyContent: "center", alignItems: "center" }}
    >
      <ThemedText type="title">Profile</ThemedText>
      <ThemedText>This is your profile page.</ThemedText>
      <ReportIssueButton top={insets.top + 10} />
    </ThemedView>
  );
}

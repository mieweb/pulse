import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import ReportIssueButton from "@/components/ReportIssueButton";
import React from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  
  return (
    <ThemedView
      style={{ flex: 1, justifyContent: "center", alignItems: "center" }}
    >
      <ThemedText type="title">Welcome to Pulse!</ThemedText>
      <ThemedText>This is the main tab of the app.</ThemedText>
      <ReportIssueButton top={insets.top + 20} />
    </ThemedView>
  );
}

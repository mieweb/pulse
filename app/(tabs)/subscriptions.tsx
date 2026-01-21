import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import ReportIssueButton from "@/components/ReportIssueButton";
import React from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function SubscriptionsScreen() {
  const insets = useSafeAreaInsets();
  
  return (
    <ThemedView
      style={{ flex: 1, justifyContent: "center", alignItems: "center" }}
    >
      <ThemedText type="title">Subscriptions</ThemedText>
      <ThemedText>See your subscribed channels here.</ThemedText>
      <ReportIssueButton top={insets.top + 10} />
    </ThemedView>
  );
}

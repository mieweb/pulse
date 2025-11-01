import { ThemedText } from "@/components/ThemedText";
import { router, useLocalSearchParams } from "expo-router";
import React from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function SplitTrimScreen() {
  const { draftId, segmentId } = useLocalSearchParams<{
    draftId: string;
    segmentId: string;
  }>();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      {/* Content will be added here */}
      <ThemedText>Draft ID: {draftId}</ThemedText>
      <ThemedText>Segment ID: {segmentId}</ThemedText>
    </View>
  );
}

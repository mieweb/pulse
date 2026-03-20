import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { usePathname } from "expo-router";
import * as React from "react";
import { Pressable, PressableStateCallbackType, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface ReportIssueFabProps {
  onPress: () => void;
}

export function ReportIssueFab({ onPress }: ReportIssueFabProps) {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const keepLowerOffset =
    pathname.includes("shorts") || pathname.includes("trim-segment");
  const topOffset = keepLowerOffset
    ? insets.top + 104
    : insets.top + 15;

  return (
    <Pressable
      accessibilityLabel="Report an issue"
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }: PressableStateCallbackType) => [
        styles.button,
        {
          top: topOffset,
          opacity: pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
      ]}
    >
      <MaterialIcons name="bug-report" size={22} color="#FFFFFF" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: "absolute",
    right: 25,
    width: 40,
    height: 40,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.78)",
    borderWidth: 1.5,
    borderColor: "rgba(255, 255, 255, 0.65)",
    zIndex: 950,
    elevation: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 5,
  },
});

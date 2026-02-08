import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import ReportIssueButton from "@/components/ReportIssueButton";
import React, { useEffect, useState } from "react";
import { StyleSheet, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { isLoggedIn, getAuthConfig } from "@/utils/authStorage";
import { useColorScheme } from "@/hooks/useColorScheme";
import { Colors } from "@/constants/Colors";

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const [loggedIn, setLoggedIn] = useState(false);
  const [authType, setAuthType] = useState<string | null>(null);

  useEffect(() => {
    checkLoginStatus();
  }, []);

  // Refresh login status when screen comes into focus
  useFocusEffect(
    React.useCallback(() => {
      checkLoginStatus();
    }, [])
  );

  const checkLoginStatus = async () => {
    const isUserLoggedIn = await isLoggedIn();
    const config = await getAuthConfig();
    setLoggedIn(isUserLoggedIn);
    setAuthType(config.authType);
  };

  const handleLoginPress = () => {
    router.push("/login");
  };
  
  return (
    <ThemedView style={{ flex: 1 }}>
      {/* Login Button in top left */}
      {!loggedIn && (
        <TouchableOpacity
          style={[
            styles.loginButton,
            {
              top: insets.top + 10,
              backgroundColor: colors.appPrimary,
            },
          ]}
          onPress={handleLoginPress}
          activeOpacity={0.7}
        >
          <ThemedText style={styles.loginButtonText}>Login</ThemedText>
        </TouchableOpacity>
      )}

      {loggedIn && authType && (
        <TouchableOpacity
          style={[
            styles.statusBadge,
            {
              top: insets.top + 10,
              backgroundColor: colors.success,
            },
          ]}
          onPress={handleLoginPress}
          activeOpacity={0.7}
        >
          <ThemedText style={styles.statusText}>
            {authType === "guest" ? "Guest Mode" : authType.toUpperCase()}
          </ThemedText>
        </TouchableOpacity>
      )}

      <ThemedView
        style={{ flex: 1, justifyContent: "center", alignItems: "center" }}
      >
        <ThemedText type="title">Welcome to Pulse!</ThemedText>
        <ThemedText>This is the main tab of the app.</ThemedText>
      </ThemedView>
      
      <ReportIssueButton top={insets.top + 20} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  loginButton: {
    position: "absolute",
    left: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    zIndex: 10,
  },
  loginButtonText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 16,
    fontFamily: "Roboto-Bold",
  },
  statusBadge: {
    position: "absolute",
    left: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    zIndex: 10,
  },
  statusText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 14,
    fontFamily: "Roboto-Bold",
  },
});

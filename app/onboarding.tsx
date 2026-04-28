import AsyncStorage from "@react-native-async-storage/async-storage";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { router } from "expo-router";
import React, { useEffect } from "react";
import { ScrollView, StyleSheet, TouchableOpacity } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { Colors } from "@/constants/Colors";

export default function OnboardingScreen() {
  const scale = useSharedValue(1);

  useEffect(() => {
    scale.value = withRepeat(withTiming(1.1, { duration: 1000 }), -1, true);
  }, [scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const renderLogo = () => (
    <Animated.View style={animatedStyle}>
      <Image
        source={require("@/assets/images/pulse-logo.png")}
        style={styles.pulseLogo}
        contentFit="contain"
      />
    </Animated.View>
  );

  async function handleGetStarted() {
    await AsyncStorage.setItem("onboardingComplete", "true");
    router.replace("/(tabs)");
  }

  return (
    <ThemedView style={styles.view}>
      {renderLogo()}
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        <ThemedView style={styles.welcomeContainer}>
          <ThemedText type="title" style={styles.welcomeText}>
            Welcome to Pulse
          </ThemedText>
          <ThemedText style={styles.welcomeSubtext}>
            Record, edit, and share institutional knowledge — on your own infrastructure
          </ThemedText>
        </ThemedView>

        <ThemedView style={styles.featureCard}>
          <ThemedView style={styles.iconContainer}>
            <MaterialIcons name="videocam" size={22} color={Colors.light.appPrimary} />
          </ThemedView>
          <ThemedView style={styles.featureText}>
            <ThemedText type="subtitle">Tap or Hold to Record</ThemedText>
            <ThemedText style={styles.featureDescription}>
              Tap for a single clip or hold to record continuously. Set duration limits from 15 s to 3 min.
            </ThemedText>
          </ThemedView>
        </ThemedView>

        <ThemedView style={styles.featureCard}>
          <ThemedView style={styles.iconContainer}>
            <MaterialIcons name="reorder" size={22} color={Colors.light.appPrimary} />
          </ThemedView>
          <ThemedView style={styles.featureText}>
            <ThemedText type="subtitle">Edit & Reorder</ThemedText>
            <ThemedText style={styles.featureDescription}>
              Drag-and-drop segments into any order, trim in/out points per clip, and undo/redo across sessions.
            </ThemedText>
          </ThemedView>
        </ThemedView>

        <ThemedView style={styles.featureCard}>
          <ThemedView style={styles.iconContainer}>
            <MaterialIcons name="photo-library" size={22} color={Colors.light.appPrimary} />
          </ThemedView>
          <ThemedView style={styles.featureText}>
            <ThemedText type="subtitle">Import from Library</ThemedText>
            <ThemedText style={styles.featureDescription}>
              Mix new recordings with existing clips from your photo library.
            </ThemedText>
          </ThemedView>
        </ThemedView>

        <ThemedView style={styles.featureCard}>
          <ThemedView style={styles.iconContainer}>
            <MaterialIcons name="save" size={22} color={Colors.light.appPrimary} />
          </ThemedView>
          <ThemedView style={styles.featureText}>
            <ThemedText type="subtitle">Auto-saved Drafts</ThemedText>
            <ThemedText style={styles.featureDescription}>
              Work saves automatically — pick up exactly where you left off.
            </ThemedText>
          </ThemedView>
        </ThemedView>

        <ThemedView style={styles.featureCard}>
          <ThemedView style={styles.iconContainer}>
            <MaterialIcons name="cloud-upload" size={22} color={Colors.light.appPrimary} />
          </ThemedView>
          <ThemedView style={styles.featureText}>
            <ThemedText type="subtitle">Upload to Your Server</ThemedText>
            <ThemedText style={styles.featureDescription}>
              Resumable TUS uploads direct to your organization&apos;s own PulseVault instance.
            </ThemedText>
          </ThemedView>
        </ThemedView>
      </ScrollView>
      <ThemedView style={styles.bottomContainer}>
        <ThemedView style={styles.poweredByContainer}>
          <ThemedText style={styles.poweredByText}>Powered by</ThemedText>
          <ThemedText style={[styles.mieText, { color: Colors.light.success }]}>
            MIE
          </ThemedText>
        </ThemedView>
        <TouchableOpacity
          style={[
            styles.getStartedButton,
            { backgroundColor: Colors.light.appPrimary },
          ]}
          onPress={handleGetStarted}
        >
          <ThemedText
            style={[styles.buttonText, { color: Colors.light.background }]}
            type="defaultSemiBold"
          >
            Get Started
          </ThemedText>
        </TouchableOpacity>
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  view: {
    display: "flex",
    flex: 1,
  },
  pulseLogo: {
    height: 180,
    width: 320,
    alignSelf: "center",
    marginTop: "15%",
    marginBottom: "5%",
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 20,
    marginTop: 20,
  },
  featureCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    marginBottom: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    marginHorizontal: 16,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "rgba(240, 30, 33, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  featureText: {
    flex: 1,
    gap: 4,
  },
  featureDescription: {
    fontSize: 14,
    opacity: 0.75,
    lineHeight: 20,
  },
  getStartedButton: {
    marginHorizontal: 24,
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignSelf: "stretch",
    marginTop: 8,
    marginBottom: 20,
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  buttonText: {
    textAlign: "center",
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  welcomeContainer: {
    alignItems: "center",
    marginBottom: 24,
    paddingHorizontal: 24,
  },
  welcomeText: {
    fontSize: 32,
    fontWeight: "bold",
    marginBottom: 8,
  },
  welcomeSubtext: {
    fontSize: 18,
    opacity: 0.8,
  },
  poweredByContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  poweredByText: {
    fontSize: 14,
    opacity: 0.7,
  },
  mieText: {
    fontSize: 16,
    fontWeight: "bold",
    marginLeft: 4,
  },
  bottomContainer: {
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
});

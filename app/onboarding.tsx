import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { router } from "expo-router";
import React, { useEffect } from "react";
import { StyleSheet, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { Colors } from "@/constants/Colors";
import ReportIssueButton from "@/components/ReportIssueButton";

export default function OnboardingScreen() {
  const insets = useSafeAreaInsets();
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
    router.replace("/login");
  }

  return (
    <ThemedView style={styles.view}>
      <ReportIssueButton top={insets.top + 10} />
      {renderLogo()}
      <ThemedView style={styles.contentContainer}>
        <ThemedView style={styles.welcomeContainer}>
          <ThemedText type="title" style={styles.welcomeText}>
            Welcome to Pulse
          </ThemedText>
          <ThemedText style={styles.welcomeSubtext}>
            Secure institutional knowledge sharing through video
          </ThemedText>
        </ThemedView>
        <ThemedView style={styles.stepContainer}>
          <ThemedText type="subtitle">Hold to Record</ThemedText>
          <ThemedText>
            Hold the record button to capture video segments. Set duration
            limits from 15s to 3 minutes.
          </ThemedText>
        </ThemedView>
        <ThemedView style={styles.stepContainer}>
          <ThemedText type="subtitle">Drag & Drop Reordering</ThemedText>
          <ThemedText>
            Reorder your video segments with intuitive drag & drop interface for
            perfect content flow.
          </ThemedText>
        </ThemedView>
        <ThemedView style={styles.stepContainer}>
          <ThemedText type="subtitle">Smart Draft System</ThemedText>
          <ThemedText>
            Auto-save your work with intelligent draft management.
          </ThemedText>
        </ThemedView>
      </ThemedView>
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
  contentContainer: {
    flex: 1,
    paddingBottom: 20,
    marginTop: 20,
  },
  stepContainer: {
    gap: 4,
    marginBottom: 4,
    paddingHorizontal: 24,
    padding: 10,
    borderRadius: 12,
    marginHorizontal: 16,
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

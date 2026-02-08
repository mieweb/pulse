import { useRouter } from "expo-router";
import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  StatusBar,
} from "react-native";
import { useColorScheme } from "@/hooks/useColorScheme";
import { Colors } from "@/constants/Colors";
import { storeAuthConfig } from "@/utils/authStorage";

const { width } = Dimensions.get("window");

export default function LoginScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleGuestLogin = async () => {
    setIsLoading(true);
    try {
      // Store guest mode
      await storeAuthConfig("guest", "");
      // Navigate to home (tabs)
      router.replace("/(tabs)");
    } catch (error) {
      console.error("Error logging in as guest:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMIELogin = () => {
    // TODO: Implement MIE (PulseVault) login
    console.log("MIE login selected - to be implemented");
  };

  const handleCustomBackendLogin = () => {
    // TODO: Implement custom backend login
    console.log("Custom backend login selected - to be implemented");
  };

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <StatusBar barStyle={colorScheme === "dark" ? "light-content" : "dark-content"} />
      
      <View style={styles.content}>
        {/* Logo/Title Section */}
        <View style={styles.header}>
          <Text style={[styles.logo, { color: colors.appPrimary }]}>
            Pulse
          </Text>
          <Text style={[styles.subtitle, { color: colors.text }]}>
            Choose your backend
          </Text>
        </View>

        {/* Login Options */}
        <View style={styles.optionsContainer}>
          {/* MIE (PulseVault) Option */}
          <TouchableOpacity
            style={[
              styles.optionButton,
              { backgroundColor: colors.tabBarButtonColorBg },
            ]}
            onPress={handleMIELogin}
            activeOpacity={0.7}
          >
            <View style={styles.optionContent}>
              <Text style={[styles.optionTitle, { color: colors.text }]}>
                MIE (PulseVault)
              </Text>
              <Text style={[styles.optionDescription, { color: colors.icon }]}>
                Connect to MIE backend
              </Text>
            </View>
          </TouchableOpacity>

          {/* Custom Backend Option */}
          <TouchableOpacity
            style={[
              styles.optionButton,
              { backgroundColor: colors.tabBarButtonColorBg },
            ]}
            onPress={handleCustomBackendLogin}
            activeOpacity={0.7}
          >
            <View style={styles.optionContent}>
              <Text style={[styles.optionTitle, { color: colors.text }]}>
                Custom Backend
              </Text>
              <Text style={[styles.optionDescription, { color: colors.icon }]}>
                Enter your own backend URL
              </Text>
            </View>
          </TouchableOpacity>

          {/* Guest Option */}
          <TouchableOpacity
            style={[
              styles.optionButton,
              styles.guestButton,
              { backgroundColor: colors.appPrimary },
            ]}
            onPress={handleGuestLogin}
            activeOpacity={0.7}
            disabled={isLoading}
          >
            <View style={styles.optionContent}>
              <Text style={[styles.optionTitle, styles.guestText]}>
                Continue as Guest
              </Text>
              <Text style={[styles.optionDescription, styles.guestText]}>
                Use the app without a backend
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    marginBottom: 60,
  },
  logo: {
    fontSize: 48,
    fontWeight: "bold",
    marginBottom: 12,
    fontFamily: "Roboto-Bold",
  },
  subtitle: {
    fontSize: 18,
    opacity: 0.7,
    fontFamily: "Roboto-Regular",
  },
  optionsContainer: {
    width: "100%",
    maxWidth: 400,
    alignSelf: "center",
  },
  optionButton: {
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
    minHeight: 80,
    justifyContent: "center",
  },
  guestButton: {
    marginTop: 20,
  },
  optionContent: {
    flexDirection: "column",
  },
  optionTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 4,
    fontFamily: "Roboto-Bold",
  },
  optionDescription: {
    fontSize: 14,
    opacity: 0.7,
    fontFamily: "Roboto-Regular",
  },
  guestText: {
    color: "#FFFFFF",
  },
});

import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Linking from "expo-linking";
import { useEffect, useState } from "react";
import "react-native-reanimated";

import { PermissionMonitor } from "@/components/PermissionMonitor";
import { useColorScheme } from "@/hooks/useColorScheme";
import AuthService from "@/services/AuthService";
import { storeAuthConfig } from "@/utils/authStorage";

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const segments = useSegments();
  const [isHandlingDeepLink, setIsHandlingDeepLink] = useState(false);
  
  const [loaded] = useFonts({
    "Roboto-Regular": require("../assets/fonts/Roboto-Regular.ttf"),
    "Roboto-Bold": require("../assets/fonts/Roboto-Bold.ttf"),
  });

  /**
   * Handle OAuth callback deep links
   */
  const handleDeepLink = async (url: string) => {
    console.log("🔗 Deep link received:", url);

    try {
      // Check if it's an OAuth callback
      if (url.includes("/auth/callback")) {
        console.log("🔐 OAuth callback detected");
        setIsHandlingDeepLink(true);

        // Parse the callback URL and complete login
        const result = await AuthService.completeLogin(url);

        if (result.success) {
          console.log("✅ OAuth login successful");
          
          // Get the vault URL from AuthService storage
          const vaultUrl = await AuthService.securelyRetrieve('vaultUrl');
          
          // Store auth config to mark user as logged in
          await storeAuthConfig('mie', vaultUrl || '');
          console.log("✅ Auth config stored");
          
          // Navigate to home
          router.replace("/(tabs)");
        } else {
          console.error("❌ OAuth login failed:", result.error);
          
          // Navigate back to login with error
          router.replace("/login");
        }

        setIsHandlingDeepLink(false);
      }
    } catch (error) {
      console.error("❌ Error handling deep link:", error);
      setIsHandlingDeepLink(false);
    }
  };

  /**
   * Setup deep link listener
   */
  useEffect(() => {
    // Handle initial URL (when app is opened from link)
    Linking.getInitialURL().then((url) => {
      if (url) {
        console.log("📱 App opened with URL:", url);
        handleDeepLink(url);
      }
    });

    // Listen for URL changes (when app is already open)
    const subscription = Linking.addEventListener("url", (event) => {
      console.log("📱 URL event:", event.url);
      handleDeepLink(event.url);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  if (!loaded) {
    // Async font loading only occurs in development.
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        <Stack
          screenOptions={{
            headerShown: false,
          }}
        >
          <Stack.Screen
            name="login"
            options={{
              headerShown: false,
              presentation: "card",
              animation: "fade",
            }}
          />
          <Stack.Screen
            name="(tabs)"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "none",
            }}
          />
          <Stack.Screen name="+not-found" />
          <Stack.Screen
            name="onboarding"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "fade",
            }}
          />
          <Stack.Screen
            name="(camera)"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "slide_from_bottom",
            }}
          />
          <Stack.Screen
            name="preview-new"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "none",
            }}
          />
          <Stack.Screen
            name="reordersegments"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "none",
            }}
          />
          <Stack.Screen
            name="trim-segment"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "slide_from_bottom",
            }}
          />
          <Stack.Screen
            name="merged-video"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "none",
            }}
          />
        </Stack>
        <StatusBar style="auto" />
        <PermissionMonitor />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

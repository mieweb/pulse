import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { storeUploadConfig } from "@/utils/uploadConfig";
import { isLoggedIn, hasCompletedInitialLogin } from "@/utils/authStorage";
import AuthService from "@/services/AuthService";

// Simple UUID v4 validation (basic format check)
const isUUIDv4 = (uuid: string) => {
  const uuidv4Regex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidv4Regex.test(uuid);
};

export default function Index() {
  const params = useLocalSearchParams<{
    mode?: string;
    draftId?: string;
    server?: string;
    token?: string;
  }>();
  const router = useRouter();
  const [hasRedirected, setHasRedirected] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Debug logging for deeplink parameters
  console.log("🔗 Deeplink params:", params);

  // Check onboarding and authentication status on mount
  useEffect(() => {
    const checkAppStatus = async () => {
      try {
        console.log("🔍 Checking app status...");
        
        // Check if onboarding is complete
        const onboardingComplete = await AsyncStorage.getItem("onboardingComplete");
        
        if (onboardingComplete === null) {
          // First time user - show onboarding
          console.log("📋 First time user - showing onboarding");
          setShowOnboarding(true);
          setIsChecking(false);
          return;
        }

        // Check authentication using AuthService
        const authenticated = await AuthService.isAuthenticated();
        console.log("🔐 Authentication status:", authenticated);
        
        if (authenticated) {
          // User is authenticated with valid token
          setIsAuthenticated(true);
        } else {
          // Check if user has completed initial login
          const completedInitialLogin = await hasCompletedInitialLogin();
          
          if (!completedInitialLogin) {
            // User has completed onboarding but not logged in yet
            console.log("🔑 Showing login screen");
            setShowLogin(true);
          } else {
            // User was logged in before but token expired/logged out
            // Check if they have any stored auth (guest mode, etc)
            const loggedIn = await isLoggedIn();
            
            if (!loggedIn) {
              // No auth at all - can go to tabs (will show login button)
              console.log("👤 No auth - going to tabs with login option");
              setShowLogin(false);
            } else {
              // Has some auth but not valid token - go to tabs
              console.log("⚠️ Invalid token - going to tabs");
              setIsAuthenticated(true);
            }
          }
        }
      } catch (error) {
        console.error("❌ Error checking app status:", error);
      } finally {
        setIsChecking(false);
      }
    };
    checkAppStatus();
  }, []);

  // Store server and token when provided in deeplink, then redirect
  useEffect(() => {
    const handleDeeplink = async () => {
      if (params.mode === "upload") {
        // Store server and token if provided
        if (params.server && params.token) {
          try {
            await storeUploadConfig(params.server, params.token);
            console.log("✅ Stored upload config from deeplink");
          } catch (error) {
            console.error("❌ Failed to store upload config:", error);
          }
        }

        // Build redirect URL with all parameters
        const redirectParams: Record<string, string> = {
          mode: "upload",
        };

        if (params.draftId && isUUIDv4(params.draftId)) {
          redirectParams.draftId = params.draftId;
        }

        // Include server and token in URL (they're also stored in AsyncStorage)
        if (params.server) {
          redirectParams.server = params.server;
        }
        if (params.token) {
          redirectParams.token = params.token;
        }

        // Redirect to shorts screen
        if (!hasRedirected) {
          setHasRedirected(true);
          router.push({
            pathname: "/(camera)/shorts",
            params: redirectParams,
          });
        }
      }
    };

    handleDeeplink();
  }, [params.mode, params.draftId, params.server, params.token, router, hasRedirected]);

  // Handle upload mode - redirect happens in useEffect
  if (params.mode === "upload") {
    // Show nothing while processing (or a loading indicator)
    return null;
  }

  // Show loading screen while checking authentication
  if (isChecking) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#F01E21" />
      </View>
    );
  }

  // Show onboarding if first time
  if (showOnboarding) {
    return <Redirect href="/onboarding" />;
  }

  // Show login if onboarding complete but not logged in yet (first time login)
  if (showLogin) {
    return <Redirect href="/login" />;
  }

  // Default to tabs (user is authenticated or can access as guest)
  return <Redirect href="/(tabs)" />;
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
});

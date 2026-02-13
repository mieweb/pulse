import { useEffect, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import AuthService from "@/services/AuthService";
import { storeAuthConfig } from "@/utils/authStorage";

/**
 * OAuth Callback Handler Screen
 * Handles the OAuth callback from Pulse Vault after user authentication
 */
export default function AuthCallbackScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }>();
  
  const [status, setStatus] = useState<string>("Processing authentication...");

  useEffect(() => {
    handleCallback();
  }, []);

  const handleCallback = async () => {
    try {
      console.log("🔐 Handling OAuth callback...");
      console.log("📋 Callback params:", params);

      // Check for error in callback
      if (params.error) {
        console.error("❌ OAuth error:", params.error, params.error_description);
        setStatus("Authentication failed");
        
        setTimeout(() => {
          router.replace("/login");
        }, 2000);
        return;
      }

      // Verify we have the authorization code
      if (!params.code) {
        console.error("❌ No authorization code in callback");
        setStatus("Invalid callback - no authorization code");
        
        setTimeout(() => {
          router.replace("/login");
        }, 2000);
        return;
      }

      setStatus("Verifying authentication...");

      // Complete the OAuth flow
      const result = await AuthService.handleCallback(
        `pulsecam://auth/callback?code=${params.code}&state=${params.state || ""}`
      );

      if (!result.success) {
        console.error("❌ Callback validation failed:", result.error);
        setStatus("Authentication failed");
        
        setTimeout(() => {
          router.replace("/login");
        }, 2000);
        return;
      }

      setStatus("Exchanging token...");

      // Exchange code for token
      const tokenResult = await AuthService.exchangeCodeForToken(result.code!);

      if (!tokenResult.success) {
        console.error("❌ Token exchange failed:", tokenResult.error);
        setStatus("Token exchange failed");
        
        setTimeout(() => {
          router.replace("/login");
        }, 2000);
        return;
      }

      console.log("✅ OAuth login successful!");
      setStatus("Login successful!");

      // Get vault URL for storing in auth config
      const vaultUrl = await AuthService.getVaultUrl();
      
      // Store auth config to mark user as logged in
      await storeAuthConfig("mie", vaultUrl || "");

      // Navigate to home
      setTimeout(() => {
        router.replace("/(tabs)");
      }, 1000);

    } catch (error) {
      console.error("❌ Callback error:", error);
      setStatus("An error occurred");
      
      setTimeout(() => {
        router.replace("/login");
      }, 2000);
    }
  };

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#F01E21" />
      <Text style={styles.statusText}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    padding: 20,
  },
  statusText: {
    marginTop: 20,
    fontSize: 16,
    color: "#666",
    textAlign: "center",
    fontFamily: "Roboto-Regular",
  },
});

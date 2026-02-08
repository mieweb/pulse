import AsyncStorage from "@react-native-async-storage/async-storage";

const AUTH_TYPE_KEY = "authType";
const BACKEND_URL_KEY = "backendUrl";
const INITIAL_LOGIN_COMPLETE_KEY = "initialLoginComplete";

export type AuthType = "guest" | "mie" | "custom" | null;

/**
 * Store authentication configuration
 * @param authType - Type of authentication: 'guest', 'mie', or 'custom'
 * @param backendUrl - Backend URL (empty for guest mode)
 */
export async function storeAuthConfig(
  authType: AuthType,
  backendUrl: string
): Promise<void> {
  try {
    await AsyncStorage.multiSet([
      [AUTH_TYPE_KEY, authType || ""],
      [BACKEND_URL_KEY, backendUrl],
      [INITIAL_LOGIN_COMPLETE_KEY, "true"], // Mark that initial login is complete
    ]);
    console.log("✅ Stored auth config:", { authType, backendUrl });
  } catch (error) {
    console.error("❌ Failed to store auth config:", error);
    throw error;
  }
}

/**
 * Get the current authentication configuration
 * @returns Object with authType and backendUrl
 */
export async function getAuthConfig(): Promise<{
  authType: AuthType;
  backendUrl: string;
}> {
  try {
    const [[, authType], [, backendUrl]] = await AsyncStorage.multiGet([
      AUTH_TYPE_KEY,
      BACKEND_URL_KEY,
    ]);

    return {
      authType: (authType as AuthType) || null,
      backendUrl: backendUrl || "",
    };
  } catch (error) {
    console.error("❌ Failed to get auth config:", error);
    return {
      authType: null,
      backendUrl: "",
    };
  }
}

/**
 * Check if user is logged in (has any auth configuration)
 * @returns true if user is logged in (guest or backend), false otherwise
 */
export async function isLoggedIn(): Promise<boolean> {
  try {
    const { authType } = await getAuthConfig();
    return authType !== null;
  } catch (error) {
    console.error("❌ Failed to check login status:", error);
    return false;
  }
}

/**
 * Clear authentication configuration (logout)
 */
export async function clearAuthConfig(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([AUTH_TYPE_KEY, BACKEND_URL_KEY]);
    // Keep INITIAL_LOGIN_COMPLETE_KEY so login page doesn't show again
    console.log("✅ Cleared auth config");
  } catch (error) {
    console.error("❌ Failed to clear auth config:", error);
    throw error;
  }
}

/**
 * Check if user has completed the initial login after onboarding
 * @returns true if initial login was completed, false otherwise
 */
export async function hasCompletedInitialLogin(): Promise<boolean> {
  try {
    const initialLoginComplete = await AsyncStorage.getItem(INITIAL_LOGIN_COMPLETE_KEY);
    return initialLoginComplete === "true";
  } catch (error) {
    console.error("❌ Failed to check initial login status:", error);
    return false;
  }
}

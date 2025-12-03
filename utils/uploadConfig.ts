import AsyncStorage from "@react-native-async-storage/async-storage";

const UPLOAD_SERVER_KEY = "upload_server_url";
const UPLOAD_TOKEN_KEY = "upload_token";

export interface UploadConfig {
  server: string;
  token: string;
}

/**
 * Store upload server URL and token from deeplink
 */
export async function storeUploadConfig(
  server: string,
  token: string
): Promise<void> {
  try {
    await AsyncStorage.multiSet([
      [UPLOAD_SERVER_KEY, server],
      [UPLOAD_TOKEN_KEY, token],
    ]);
    console.log("[UploadConfig] Stored server and token");
  } catch (error) {
    console.error("[UploadConfig] Error storing upload config:", error);
    throw error;
  }
}

/**
 * Retrieve stored upload server URL and token
 */
export async function getUploadConfig(): Promise<UploadConfig | null> {
  try {
    const [server, token] = await AsyncStorage.multiGet([
      UPLOAD_SERVER_KEY,
      UPLOAD_TOKEN_KEY,
    ]);

    if (server[1] && token[1]) {
      return {
        server: server[1],
        token: token[1],
      };
    }
    return null;
  } catch (error) {
    console.error("[UploadConfig] Error retrieving upload config:", error);
    return null;
  }
}

/**
 * Clear stored upload config
 */
export async function clearUploadConfig(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([UPLOAD_SERVER_KEY, UPLOAD_TOKEN_KEY]);
    console.log("[UploadConfig] Cleared server and token");
  } catch (error) {
    console.error("[UploadConfig] Error clearing upload config:", error);
  }
}


import AsyncStorage from "@react-native-async-storage/async-storage";

const UPLOAD_SERVER_KEY = "upload_server_url";
const UPLOAD_TOKEN_KEY = "upload_token";
const UPLOAD_CONFIG_PREFIX = "upload_config_";

export interface UploadConfig {
  server: string;
  token: string;
}

/**
 * Store upload server URL and token from deeplink (global fallback).
 * Prefer storeUploadConfigForDraft(draftId, ...) so each draft keeps its own server.
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
    console.log("[UploadConfig] Stored server and token (global)");
  } catch (error) {
    console.error("[UploadConfig] Error storing upload config:", error);
    throw error;
  }
}

/**
 * Retrieve stored upload server URL and token (global fallback).
 * Use getUploadConfigForDraft(draftId) when uploading a specific draft.
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
 * Store upload config for a specific draft (from QR scan).
 * Each draft can have its own server URL (e.g. Pulse Vault vs Pulse Clip).
 */
export async function storeUploadConfigForDraft(
  draftId: string,
  server: string,
  token: string
): Promise<void> {
  try {
    const key = UPLOAD_CONFIG_PREFIX + draftId;
    await AsyncStorage.setItem(
      key,
      JSON.stringify({ server, token })
    );
    console.log("[UploadConfig] Stored config for draft:", draftId);
  } catch (error) {
    console.error("[UploadConfig] Error storing upload config for draft:", error);
    throw error;
  }
}

/**
 * Retrieve upload config for a specific draft.
 * Returns null if this draft has no per-draft config (e.g. camera-only or old draft).
 */
export async function getUploadConfigForDraft(
  draftId: string
): Promise<UploadConfig | null> {
  try {
    const key = UPLOAD_CONFIG_PREFIX + draftId;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { server?: string; token?: string };
    if (parsed?.server && parsed?.token) {
      return { server: parsed.server, token: parsed.token };
    }
    return null;
  } catch (error) {
    console.error("[UploadConfig] Error retrieving upload config for draft:", error);
    return null;
  }
}

/**
 * Get upload config for a draft: per-draft first, then global fallback.
 * Use this when uploading so the correct server is used for each draft.
 */
export async function getUploadConfigForDraftOrGlobal(
  draftId: string | undefined
): Promise<UploadConfig | null> {
  if (draftId) {
    const perDraft = await getUploadConfigForDraft(draftId);
    if (perDraft) return perDraft;
  }
  return getUploadConfig();
}

/**
 * Retrieve upload configs for multiple drafts in one call (for draft list).
 */
export async function getUploadConfigsForDraftIds(
  draftIds: string[]
): Promise<Map<string, UploadConfig>> {
  const map = new Map<string, UploadConfig>();
  if (draftIds.length === 0) return map;
  try {
    const keys = draftIds.map((id) => UPLOAD_CONFIG_PREFIX + id);
    const pairs = await AsyncStorage.multiGet(keys);
    for (let i = 0; i < pairs.length; i++) {
      const [, value] = pairs[i];
      if (value) {
        try {
          const parsed = JSON.parse(value) as { server?: string; token?: string };
          if (parsed?.server && parsed?.token) {
            map.set(draftIds[i], { server: parsed.server, token: parsed.token });
          }
        } catch {
          // skip invalid entry
        }
      }
    }
  } catch (error) {
    console.error("[UploadConfig] Error getting configs for drafts:", error);
  }
  return map;
}

/**
 * Clear stored upload config for a draft (e.g. when draft is deleted).
 */
export async function clearUploadConfigForDraft(draftId: string): Promise<void> {
  try {
    const key = UPLOAD_CONFIG_PREFIX + draftId;
    await AsyncStorage.removeItem(key);
    console.log("[UploadConfig] Cleared config for draft:", draftId);
  } catch (error) {
    console.error("[UploadConfig] Error clearing upload config for draft:", error);
  }
}

/**
 * Clear stored upload config (global)
 */
export async function clearUploadConfig(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([UPLOAD_SERVER_KEY, UPLOAD_TOKEN_KEY]);
    console.log("[UploadConfig] Cleared server and token");
  } catch (error) {
    console.error("[UploadConfig] Error clearing upload config:", error);
  }
}


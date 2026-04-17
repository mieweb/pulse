import AsyncStorage from "@react-native-async-storage/async-storage";

const UPLOAD_CONFIG_PREFIX = "upload_config_";

export interface UploadConfig {
  server: string;
  token?: string;
}

/**
 * Store upload config for a specific draft (from QR scan with draftId).
 * Each draft has its own server URL (e.g. Pulse Vault vs Pulse Clip).
 * Upload mode requires a draftId in the QR code. Token is optional — when
 * present it is forwarded as a Bearer auth header on uploads.
 */
export async function storeUploadConfigForDraft(
  draftId: string,
  server: string,
  token?: string
): Promise<void> {
  try {
    const key = UPLOAD_CONFIG_PREFIX + draftId;
    const payload: UploadConfig = token ? { server, token } : { server };
    await AsyncStorage.setItem(key, JSON.stringify(payload));
    console.log("[UploadConfig] Stored config for draft:", draftId);
  } catch (error) {
    console.error("[UploadConfig] Error storing upload config for draft:", error);
    throw error;
  }
}

/**
 * Retrieve upload config for a specific draft.
 * Returns null if this draft has no per-draft config (e.g. QR had no draftId).
 */
export async function getUploadConfigForDraft(
  draftId: string
): Promise<UploadConfig | null> {
  try {
    const key = UPLOAD_CONFIG_PREFIX + draftId;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { server?: string; token?: string };
    if (parsed?.server) {
      return parsed.token
        ? { server: parsed.server, token: parsed.token }
        : { server: parsed.server };
    }
    return null;
  } catch (error) {
    console.error("[UploadConfig] Error retrieving upload config for draft:", error);
    return null;
  }
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
          if (parsed?.server) {
            map.set(
              draftIds[i],
              parsed.token
                ? { server: parsed.server, token: parsed.token }
                : { server: parsed.server }
            );
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

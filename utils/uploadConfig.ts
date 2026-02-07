import AsyncStorage from "@react-native-async-storage/async-storage";

const UPLOAD_CONFIG_PREFIX = "upload_config_";

export interface UploadConfig {
  server: string;
  token: string;
}

/**
 * Store upload config for a specific draft (from QR scan with draftId).
 * Each draft has its own server URL (e.g. Pulse Vault vs Pulse Clip).
 * Upload mode requires a draftId in the QR code.
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

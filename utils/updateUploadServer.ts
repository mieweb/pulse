import { getUploadConfig, storeUploadConfig } from "./uploadConfig";

/**
 * Update the server URL in stored upload config
 * Useful when switching from localhost to local IP for device testing
 */
export async function updateUploadServerUrl(newServerUrl: string): Promise<void> {
  const config = await getUploadConfig();
  
  if (!config) {
    throw new Error("No upload config found. Please scan a QR code first.");
  }

  // Update with new server URL but keep the same token
  await storeUploadConfig(newServerUrl, config.token);
  console.log(`[UploadConfig] Updated server URL to: ${newServerUrl}`);
}

/**
 * Replace localhost with local IP in server URL
 * Detects common localhost patterns and suggests replacement
 */
export function replaceLocalhostWithIP(serverUrl: string, localIP: string): string {
  return serverUrl
    .replace(/localhost/g, localIP)
    .replace(/127\.0\.0\.1/g, localIP);
}


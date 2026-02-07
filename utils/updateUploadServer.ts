import {
  getUploadConfigForDraft,
  storeUploadConfigForDraft,
} from "./uploadConfig";

/**
 * Update the server URL in stored upload config for a specific draft.
 * Useful when switching from localhost to local IP for device testing.
 */
export async function updateUploadServerUrl(
  draftId: string,
  newServerUrl: string
): Promise<void> {
  const config = await getUploadConfigForDraft(draftId);

  if (!config) {
    throw new Error("Server not set up for upload.");
  }

  await storeUploadConfigForDraft(draftId, newServerUrl, config.token);
  console.log("[UploadConfig] Updated server URL for draft:", draftId);
}

/**
 * Replace localhost with local IP in server URL
 */
export function replaceLocalhostWithIP(
  serverUrl: string,
  localIP: string
): string {
  return serverUrl
    .replace(/localhost/g, localIP)
    .replace(/127\.0\.0\.1/g, localIP);
}

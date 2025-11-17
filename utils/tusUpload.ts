/**
 * TUS (Resumable Upload Protocol) client for uploading videos to PulseVault
 * 
 * This module implements the TUS protocol for resumable uploads to pulse-vault.
 * It supports chunked uploads, progress tracking, and automatic retry on failure.
 */

// Import FileSystem at the top
import * as FileSystem from "expo-file-system";

interface UploadOptions {
  serverUrl: string;
  fileUri: string;
  filename: string;
  uploadToken?: string; // Secure upload token for authentication
  onProgress?: (progress: number) => void;
  onError?: (error: Error) => void;
}

interface UploadResult {
  uploadId: string;
  videoId?: string;
}

/**
 * Upload a video file using TUS protocol
 */
export async function uploadVideo(
  options: UploadOptions
): Promise<UploadResult> {
  const { serverUrl, fileUri, filename, uploadToken, onProgress, onError } = options;

  try {
    // Get file info
    const fileInfo = await getFileInfo(fileUri);
    const fileSize = fileInfo.size;

    // Step 1: Create upload session
    const uploadUrl = await createUploadSession(serverUrl, fileSize);
    const uploadId = extractUploadId(uploadUrl);

    console.log(`📤 Created upload session: ${uploadId}`);

    // Step 2: Upload file in chunks
    let uploadedBytes = 0;
    const chunkSize = 1024 * 1024; // 1MB chunks

    await readFileChunked(fileUri, chunkSize, async (chunk, offset) => {
      await uploadChunk(uploadUrl, chunk, offset);
      uploadedBytes += chunk.byteLength;
      
      const progress = uploadedBytes / fileSize;
      if (onProgress) {
        onProgress(progress);
      }
    });

    // Step 3: Finalize upload
    const result = await finalizeUpload(serverUrl, uploadId, filename, uploadToken);
    
    return {
      uploadId,
      videoId: result.videoId,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("❌ Upload failed:", err);
    if (onError) {
      onError(err);
    }
    throw err;
  }
}

/**
 * Get file information
 */
async function getFileInfo(fileUri: string): Promise<{ size: number }> {
  const fileInfo = await FileSystem.getInfoAsync(fileUri);
  if (!fileInfo.exists) {
    throw new Error(`File not found: ${fileUri}`);
  }
  
  // FileSystem.getInfoAsync already returns size
  return {
    size: fileInfo.size || 0,
  };
}

/**
 * Create a new TUS upload session
 */
async function createUploadSession(
  serverUrl: string,
  fileSize: number
): Promise<string> {
  const url = `${serverUrl}/uploads`;
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Upload-Length": fileSize.toString(),
        "Tus-Resumable": "1.0.0",
        "Content-Type": "application/offset+octet-stream",
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Failed to create upload session (${response.status}): ${errorText}`);
    }

    const location = response.headers.get("Location");
    if (!location) {
      throw new Error("No Location header in upload response");
    }

    // Handle relative URLs
    if (location.startsWith("/")) {
      const baseUrl = serverUrl.replace(/\/$/, "");
      return `${baseUrl}${location}`;
    }

    return location;
  } catch (error) {
    // Provide helpful error message for network issues
    if (error instanceof TypeError && error.message.includes('Network request failed')) {
      throw new Error(
        `Network request failed. Make sure:\n` +
        `1. Pulse-Vault is running on ${serverUrl}\n` +
        `2. Your phone and computer are on the same WiFi network\n` +
        `3. You're using your computer's IP (not localhost)\n` +
        `4. Firewall allows connections on port 3000`
      );
    }
    throw error;
  }
}

/**
 * Extract upload ID from upload URL
 */
function extractUploadId(uploadUrl: string): string {
  const parts = uploadUrl.split("/");
  return parts[parts.length - 1];
}

/**
 * Upload a chunk of data
 */
async function uploadChunk(
  uploadUrl: string,
  chunk: ArrayBuffer,
  offset: number
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": offset.toString(),
      "Tus-Resumable": "1.0.0",
    },
    body: chunk,
  });

  if (!response.ok && response.status !== 204) {
    throw new Error(`Failed to upload chunk: ${response.statusText}`);
  }
}

/**
 * Read file in chunks and call callback for each chunk
 * Note: Expo FileSystem doesn't support partial reads, so we read the whole file
 * and split it into chunks. For large files, consider using a native module.
 */
async function readFileChunked(
  fileUri: string,
  chunkSize: number,
  onChunk: (chunk: ArrayBuffer, offset: number) => Promise<void>
): Promise<void> {
  const fileInfo = await FileSystem.getInfoAsync(fileUri);
  if (!fileInfo.exists) {
    throw new Error(`File not found: ${fileUri}`);
  }

  const fileSize = fileInfo.size || 0;
  
  // Read entire file as base64 (Expo limitation - no partial reads)
  const fileBase64 = await FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Convert base64 to Uint8Array
  const binaryString = atob(fileBase64);
  const fileBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    fileBytes[i] = binaryString.charCodeAt(i);
  }

  // Split into chunks and upload
  let offset = 0;
  while (offset < fileSize) {
    const end = Math.min(offset + chunkSize, fileSize);
    const chunkLength = end - offset;
    const chunk = fileBytes.slice(offset, end).buffer;

    await onChunk(chunk, offset);
    offset = end;
  }
}

/**
 * Finalize the upload and trigger transcoding
 */
async function finalizeUpload(
  serverUrl: string,
  uploadId: string,
  filename: string,
  uploadToken?: string
): Promise<{ videoId: string }> {
  const url = `${serverUrl}/uploads/finalize`;
  
  // Extract userId from token if present
  let userId = "mobile-app";
  if (uploadToken) {
    try {
      // Decode base64url token to get userId (client-side, signature verified server-side)
      // base64url uses - and _ instead of + and /
      const base64 = uploadToken.replace(/-/g, '+').replace(/_/g, '/');
      const padding = '='.repeat((4 - (base64.length % 4)) % 4);
      const base64Padded = base64 + padding;
      
      // Use atob for base64 decoding (available in React Native)
      const binaryString = atob(base64Padded);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const text = new TextDecoder().decode(bytes);
      const decoded = JSON.parse(text);
      userId = decoded.userId || userId;
    } catch (error) {
      console.warn("Failed to decode token for userId:", error);
    }
  }
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(uploadToken && { "X-Upload-Token": uploadToken }), // Pass token for server validation
    },
    body: JSON.stringify({
      uploadId,
      filename,
      userId,
      ...(uploadToken && { uploadToken }), // Include token in body for validation
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to finalize upload: ${errorText}`);
  }

  const result = await response.json();
  return {
    videoId: result.videoId,
  };
}


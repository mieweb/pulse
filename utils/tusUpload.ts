import * as FileSystem from "expo-file-system";
import { getUploadConfig } from "./uploadConfig";

export interface UploadProgress {
  bytesUploaded: number;
  bytesTotal: number;
  percentage: number;
}

export interface UploadResult {
  videoId: string;
  status: string;
  size: number;
  checksum: string;
}

/**
 * Upload video using TUS protocol to PulseVault
 */
export async function uploadVideo(
  videoUri: string,
  filename: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult> {
  // Get stored upload config
  const config = await getUploadConfig();
  if (!config) {
    throw new Error(
      "No upload configuration found. Please scan a QR code to configure upload settings."
    );
  }

  let { server, token } = config;

  // Detect if we're on a physical device and server is localhost
  // Try to auto-fix by replacing localhost with a common local IP pattern
  // Note: This is a best-effort fix - user should regenerate QR with correct IP
  if (server.includes("localhost") || server.includes("127.0.0.1")) {
    console.warn(
      "[TUS Upload] Warning: Server URL uses localhost. Attempting to detect local IP..."
    );
    
    // Try to get local IP from Expo constants (if available)
    try {
      const Constants = require("expo-constants");
      const debuggerHost = Constants.expoConfig?.hostUri?.split(":")[0];
      if (debuggerHost && !debuggerHost.includes("localhost") && !debuggerHost.includes("127.0.0.1")) {
        const port = server.split(":")[2] || "3000";
        server = server.replace(/localhost|127\.0\.0\.1/, debuggerHost);
        console.log(`[TUS Upload] Auto-replaced localhost with detected IP: ${server}`);
      }
    } catch (e) {
      // Constants not available, will show error below
    }
  }

  // Normalize server URL (remove trailing slash)
  const normalizedServer = server.replace(/\/$/, "");

  // Get file info
  const fileInfo = await FileSystem.getInfoAsync(videoUri);
  if (!fileInfo.exists) {
    throw new Error("Video file not found");
  }

  const fileSize = fileInfo.size || 0;
  if (fileSize === 0) {
    throw new Error("Video file is empty");
  }

  // Step 1: Create upload session
  let createUploadResponse: Response;
  try {
    createUploadResponse = await fetch(`${normalizedServer}/uploads`, {
      method: "POST",
      headers: {
        "Upload-Length": fileSize.toString(),
        "Tus-Resumable": "1.0.0",
      },
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown network error";
    
    // Provide helpful error message for network failures
    if (errorMessage.includes("Network request failed") || errorMessage.includes("Failed to connect")) {
      if (normalizedServer.includes("localhost") || normalizedServer.includes("127.0.0.1")) {
        throw new Error(
          `Cannot connect to server. If testing on a physical device, replace "localhost" with your computer's IP address (e.g., http://192.168.1.100:3000). Current server: ${normalizedServer}`
        );
      } else {
        throw new Error(
          `Cannot connect to server at ${normalizedServer}. Please check:\n1. Server is running\n2. Device and server are on the same network\n3. Firewall allows connections\n\nError: ${errorMessage}`
        );
      }
    }
    throw error;
  }

  if (!createUploadResponse.ok) {
    const errorText = await createUploadResponse.text().catch(() => "");
    throw new Error(
      `Failed to create upload session: ${createUploadResponse.status} ${createUploadResponse.statusText}${errorText ? ` - ${errorText}` : ""}`
    );
  }

  // Extract upload ID from Location header
  const location = createUploadResponse.headers.get("Location");
  if (!location) {
    throw new Error("No upload location returned from server");
  }

  const uploadId = location.split("/uploads/").pop() || location;
  // Handle both absolute and relative Location headers
  const uploadUrl = location.startsWith("http")
    ? location
    : `${normalizedServer}${location.startsWith("/") ? location : `/uploads/${uploadId}`}`;

  console.log(`[TUS Upload] Created upload session: ${uploadId}`);

  // Step 2: Upload file in chunks using FileSystem.uploadAsync
  // Note: We'll use a workaround with fetch and base64 encoding
  // For production, consider using a TUS client library
  const chunkSize = 1024 * 1024; // 1MB chunks
  let offset = 0;
  let bytesUploaded = 0;

  while (offset < fileSize) {
    const end = Math.min(offset + chunkSize, fileSize);
    const chunkLength = end - offset;

    // Read chunk as base64
    const base64Chunk = await FileSystem.readAsStringAsync(videoUri, {
      encoding: FileSystem.EncodingType.Base64,
      position: offset,
      length: chunkLength,
    });

    // Convert base64 to Uint8Array
    const binaryString = atob(base64Chunk);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Upload chunk
    let retries = 3;
    let uploadResponse: Response | null = null;

    while (retries > 0) {
      try {
        uploadResponse = await fetch(uploadUrl, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/offset+octet-stream",
            "Upload-Offset": offset.toString(),
            "Tus-Resumable": "1.0.0",
          },
          body: bytes,
        });

        if (uploadResponse.ok) {
          break;
        }

        // If not ok, retry
        retries--;
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        retries--;
        if (retries === 0) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (!uploadResponse || !uploadResponse.ok) {
      throw new Error(
        `Failed to upload chunk: ${uploadResponse?.statusText || "Unknown error"} (offset: ${offset})`
      );
    }

    const newOffset = parseInt(
      uploadResponse.headers.get("Upload-Offset") || "0",
      10
    );
    offset = newOffset;
    bytesUploaded = offset;

    // Report progress
    if (onProgress) {
      onProgress({
        bytesUploaded,
        bytesTotal: fileSize,
        percentage: (bytesUploaded / fileSize) * 100,
      });
    }

    console.log(
      `[TUS Upload] Progress: ${bytesUploaded}/${fileSize} (${Math.round(
        (bytesUploaded / fileSize) * 100
      )}%)`
    );
  }

  console.log(`[TUS Upload] Upload complete: ${uploadId}`);

  // Step 3: Finalize upload
  const finalizeResponse = await fetch(`${normalizedServer}/uploads/finalize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Upload-Token": token, // Send token in header
    },
    body: JSON.stringify({
      uploadId,
      filename,
      userId: "anonymous", // Could be extracted from token if needed
      uploadToken: token, // Also send in body
    }),
  });

  if (!finalizeResponse.ok) {
    const errorText = await finalizeResponse.text();
    throw new Error(
      `Failed to finalize upload: ${finalizeResponse.statusText} - ${errorText}`
    );
  }

  const result = await finalizeResponse.json();
  console.log(`[TUS Upload] Finalized: ${result.videoId}`);

  return result;
}


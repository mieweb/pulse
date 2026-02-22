import * as FileSystem from "expo-file-system";
import { getUploadConfigForDraft } from "./uploadConfig";

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

/** When using a saved destination (long-lived token), app sends draftId in finalize body. */
export interface UploadConfigOverride {
  server: string;
  token: string;
}

/**
 * Upload video using TUS protocol to PulseVault.
 * Uses per-draft config if no override; otherwise uses configOverride and sends draftId in finalize (destination token).
 */
export async function uploadVideo(
  videoUri: string,
  filename: string,
  onProgress?: (progress: UploadProgress) => void,
  draftId?: string,
  configOverride?: UploadConfigOverride
): Promise<UploadResult> {
  console.log(`[TUS Upload] Starting upload process for: ${filename}`);
  console.log(`[TUS Upload] Video URI: ${videoUri}`);

  let config: { server: string; token: string } | null;
  let sendDraftIdInBody = false;
  if (configOverride) {
    config = configOverride;
    sendDraftIdInBody = true;
    if (!draftId) {
      throw new Error("Draft ID is required when using a configured destination.");
    }
  } else {
    if (!draftId) {
      throw new Error("Server not set up for upload.");
    }
    console.log(`[TUS Upload] Step 1: Getting upload config for draft...`);
    config = await getUploadConfigForDraft(draftId);
    if (!config) {
      throw new Error("Server not set up for upload.");
    }
  }

  let { server, token } = config;
  console.log(`[TUS Upload] Config loaded - Server: ${server}, Token: ${token ? 'present' : 'missing'}`);

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
      }
    } catch (e) {
      // Constants not available, will show error below
    }
  }

  // Normalize server URL (remove trailing slash)
  const normalizedServer = server.replace(/\/$/, "");
  console.log(`[TUS Upload] Normalized server URL: ${normalizedServer}`);

  // Get file info
  console.log(`[TUS Upload] Step 2: Getting file info...`);
  const fileInfo = await FileSystem.getInfoAsync(videoUri);
  if (!fileInfo.exists) {
    throw new Error("Video file not found");
  }

  const fileSize = fileInfo.size || 0;
  console.log(`[TUS Upload] File size: ${fileSize} bytes (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
  if (fileSize === 0) {
    throw new Error("Video file is empty");
  }

  // Step 1: Create upload session
  console.log(`[TUS Upload] Step 3: Creating upload session...`);
  console.log(`[TUS Upload] POST ${normalizedServer}/uploads`);
  console.log(`[TUS Upload] Headers: Upload-Length=${fileSize}, Tus-Resumable=1.0.0`);
  
  const createUploadStartTime = Date.now();
  let createUploadResponse: Response;
  try {
    createUploadResponse = await fetch(
      `${normalizedServer}/uploads`,
      {
        method: "POST",
        headers: {
          "Upload-Length": fileSize.toString(),
          "Tus-Resumable": "1.0.0",
        },
      }
    );
    const createUploadDuration = Date.now() - createUploadStartTime;
    console.log(`[TUS Upload] Create session response received in ${createUploadDuration}ms`);
    console.log(`[TUS Upload] Response status: ${createUploadResponse.status} ${createUploadResponse.statusText}`);
  } catch (error) {
    const createUploadDuration = Date.now() - createUploadStartTime;
    console.error(`[TUS Upload] Create session failed after ${createUploadDuration}ms:`, error);
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
    console.error(`[TUS Upload] Create session failed - Status: ${createUploadResponse.status}, Error: ${errorText}`);
    throw new Error(
      `Failed to create upload session: ${createUploadResponse.status} ${createUploadResponse.statusText}${errorText ? ` - ${errorText}` : ""}`
    );
  }

  // Extract upload ID from Location header
  const location = createUploadResponse.headers.get("Location");
  console.log(`[TUS Upload] Location header: ${location}`);
  if (!location) {
    console.error(`[TUS Upload] No Location header in response. All headers:`, Object.fromEntries(createUploadResponse.headers.entries()));
    throw new Error("No upload location returned from server");
  }

  const uploadId = location.split("/uploads/").pop() || location;
  // Handle both absolute and relative Location headers
  let uploadUrl: string;
  if (location.startsWith("http")) {
    // If Location is absolute URL, use it but ensure it matches server's scheme and port
    try {
      const locationUrl = new URL(location);
      const serverUrl = new URL(normalizedServer);
      console.log(`[TUS Upload] Location URL: ${locationUrl.toString()}, Server URL: ${serverUrl.toString()}`);
      
      // If server uses HTTPS but Location is HTTP, upgrade to HTTPS (Proxmox SSL termination issue)
      if (serverUrl.protocol === "https:" && locationUrl.protocol === "http:") {
        locationUrl.protocol = "https:";
        console.log(`[TUS Upload] Upgraded Location URL from HTTP to HTTPS: ${locationUrl.toString()}`);
      }
      
      // If Location URL is missing port but server URL has one, add it
      if (!locationUrl.port && serverUrl.port) {
        locationUrl.port = serverUrl.port;
        console.log(`[TUS Upload] Added port ${serverUrl.port} to Location URL: ${locationUrl.toString()}`);
      }
      
      uploadUrl = locationUrl.toString();
    } catch (error) {
      console.error(`[TUS Upload] URL parsing failed:`, error);
      // If URL parsing fails, use location as-is
      uploadUrl = location;
    }
  } else {
    // Relative URL - prepend server
    uploadUrl = `${normalizedServer}${location.startsWith("/") ? location : `/uploads/${uploadId}`}`;
  }
  console.log(`[TUS Upload] Final upload URL: ${uploadUrl}`);

  // Step 2: Upload file in chunks using FileSystem.uploadAsync
  // Note: We'll use a workaround with fetch and base64 encoding
  // For production, consider using a TUS client library
  const chunkSize = 1024 * 1024; // 1MB chunks
  const totalChunks = Math.ceil(fileSize / chunkSize);
  console.log(`[TUS Upload] Step 4: Starting chunked upload...`);
  console.log(`[TUS Upload] Chunk size: ${chunkSize} bytes, Total chunks: ${totalChunks}`);
  
  let offset = 0;
  let bytesUploaded = 0;
  let chunkNumber = 0;

  while (offset < fileSize) {
    chunkNumber++;
    const end = Math.min(offset + chunkSize, fileSize);
    const chunkLength = end - offset;
    
    console.log(`[TUS Upload] Chunk ${chunkNumber}/${totalChunks}: Reading ${chunkLength} bytes from offset ${offset}...`);
    const readStartTime = Date.now();
    
    // Read chunk as base64
    const base64Chunk = await FileSystem.readAsStringAsync(videoUri, {
      encoding: FileSystem.EncodingType.Base64,
      position: offset,
      length: chunkLength,
    });

    const readDuration = Date.now() - readStartTime;
    console.log(`[TUS Upload] Chunk ${chunkNumber}: Read completed in ${readDuration}ms (${base64Chunk.length} base64 chars)`);

    // Convert base64 to Uint8Array
    const convertStartTime = Date.now();
    const binaryString = atob(base64Chunk);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const convertDuration = Date.now() - convertStartTime;
    console.log(`[TUS Upload] Chunk ${chunkNumber}: Converted to binary in ${convertDuration}ms (${bytes.length} bytes)`);

    // Upload chunk
    let retries = 3;
    let uploadResponse: Response | null = null;

    while (retries > 0) {
      const attemptNumber = 4 - retries;
      const uploadStartTime = Date.now();
      try {
        console.log(`[TUS Upload] Chunk ${chunkNumber}/${totalChunks}: Uploading (attempt ${attemptNumber}/3)...`);
        console.log(`[TUS Upload] Chunk ${chunkNumber}: PATCH ${uploadUrl}`);
        console.log(`[TUS Upload] Chunk ${chunkNumber}: Headers - Upload-Offset=${offset}, Content-Type=application/offset+octet-stream, Tus-Resumable=1.0.0`);
        console.log(`[TUS Upload] Chunk ${chunkNumber}: Body size: ${bytes.length} bytes`);
        
        uploadResponse = await fetch(uploadUrl, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/offset+octet-stream",
            "Upload-Offset": offset.toString(),
            "Tus-Resumable": "1.0.0",
          },
          body: bytes,
        });

        const uploadDuration = Date.now() - uploadStartTime;
        console.log(`[TUS Upload] Chunk ${chunkNumber}: Response received in ${uploadDuration}ms`);
        console.log(`[TUS Upload] Chunk ${chunkNumber}: Status: ${uploadResponse.status} ${uploadResponse.statusText}`);

        if (uploadResponse.ok) {
          const uploadOffset = uploadResponse.headers.get("Upload-Offset");
          console.log(`[TUS Upload] Chunk ${chunkNumber}: Upload-Offset header: ${uploadOffset}`);
          break;
        }

        // If not ok, retry
        console.warn(`[TUS Upload] Chunk ${chunkNumber}: Upload failed with status ${uploadResponse.status}, retrying...`);
        retries--;
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        const uploadDuration = Date.now() - uploadStartTime;
        console.error(`[TUS Upload] Chunk ${chunkNumber}: Upload error after ${uploadDuration}ms:`, error);
        if (error instanceof Error) {
          console.error(`[TUS Upload] Chunk ${chunkNumber}: Error name: ${error.name}, message: ${error.message}`);
        }
        retries--;
        if (retries === 0) {
          throw error;
        }
        console.log(`[TUS Upload] Chunk ${chunkNumber}: Retrying in 1 second...`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (!uploadResponse || !uploadResponse.ok) {
      console.error(`[TUS Upload] Chunk ${chunkNumber}: Final failure - Status: ${uploadResponse?.status}, StatusText: ${uploadResponse?.statusText}`);
      throw new Error(
        `Failed to upload chunk: ${uploadResponse?.statusText || "Unknown error"} (offset: ${offset})`
      );
    }

    const newOffset = parseInt(
      uploadResponse.headers.get("Upload-Offset") || "0",
      10
    );
    console.log(`[TUS Upload] Chunk ${chunkNumber}: Server confirmed offset: ${newOffset}`);
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

    const progressPercent = Math.round((bytesUploaded / fileSize) * 100);
    console.log(`[TUS Upload] Progress: ${bytesUploaded}/${fileSize} (${progressPercent}%) - Chunk ${chunkNumber}/${totalChunks} complete`);
  }

  console.log(`[TUS Upload] All chunks uploaded successfully. Upload ID: ${uploadId}`);

  // Step 3: Finalize upload
  console.log(`[TUS Upload] Step 5: Finalizing upload...`);
  console.log(`[TUS Upload] POST ${normalizedServer}/uploads/finalize`);
  console.log(`[TUS Upload] Finalize payload: uploadId=${uploadId}, filename=${filename}`);
  
  const finalizeStartTime = Date.now();
  const finalizeBody: Record<string, unknown> = {
    uploadId,
    filename,
    userId: "anonymous",
    uploadToken: token,
  };
  if (sendDraftIdInBody && draftId) {
    finalizeBody.draftId = draftId;
  }
  const finalizeResponse = await fetch(`${normalizedServer}/uploads/finalize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Upload-Token": token,
    },
    body: JSON.stringify(finalizeBody),
  });

  const finalizeDuration = Date.now() - finalizeStartTime;
  console.log(`[TUS Upload] Finalize response received in ${finalizeDuration}ms`);
  console.log(`[TUS Upload] Finalize status: ${finalizeResponse.status} ${finalizeResponse.statusText}`);

  if (!finalizeResponse.ok) {
    const errorText = await finalizeResponse.text();
    console.error(`[TUS Upload] Finalize failed - Status: ${finalizeResponse.status}, Error: ${errorText}`);
    throw new Error(
      `Failed to finalize upload: ${finalizeResponse.statusText} - ${errorText}`
    );
  }

  const result = await finalizeResponse.json();
  console.log(`[TUS Upload] Finalized successfully: ${result.videoId}`);
  console.log(`[TUS Upload] Upload process completed successfully!`);
  return result;
}


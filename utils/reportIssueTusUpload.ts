import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import * as tus from "tus-js-client";

export interface ReportIssueTusProgress {
  bytesUploaded: number;
  bytesTotal: number;
}

export interface ReportIssueTusUploadInput {
  fileUri: string;
  fileName: string;
  fileType: string;
  endpoint: string;
  reportId: string;
  onProgress?: (progress: ReportIssueTusProgress) => void;
  onNotice?: (message: string) => void;
}

export interface ReportIssueTusUploadResult {
  uploadUrl: string;
  uploadId: string;
}

const URL_STORAGE_PREFIX = "issue-report-tus:";
const UPLOAD_ACTIVITY_TIMEOUT_MS = 30_000;
const TUS_RESUMABLE_VERSION = "1.0.0";

interface StoredUploadEntry {
  fingerprint: string;
  upload: {
    size?: number;
    metadata?: Record<string, string>;
    creationTime?: string;
    uploadUrl?: string;
    urlStorageKey?: string;
  };
}

class AsyncStorageUrlStorage {
  async addUpload(fingerprint: string, upload: StoredUploadEntry["upload"]): Promise<string> {
    const storageKey = `${URL_STORAGE_PREFIX}${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const payload: StoredUploadEntry = {
      fingerprint,
      upload: {
        ...upload,
        urlStorageKey: storageKey,
      },
    };
    await AsyncStorage.setItem(storageKey, JSON.stringify(payload));
    return storageKey;
  }

  async findUploadsByFingerprint(fingerprint: string): Promise<StoredUploadEntry["upload"][]> {
    const keys = await AsyncStorage.getAllKeys();
    const tusKeys = keys.filter((key) => key.startsWith(URL_STORAGE_PREFIX));
    if (tusKeys.length === 0) return [];

    const records = await AsyncStorage.multiGet(tusKeys);
    const matches: StoredUploadEntry["upload"][] = [];

    for (const [key, raw] of records) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as StoredUploadEntry;
        if (parsed.fingerprint !== fingerprint) continue;
        matches.push({
          ...parsed.upload,
          urlStorageKey: parsed.upload.urlStorageKey ?? key,
        });
      } catch {
        continue;
      }
    }

    return matches;
  }

  async removeUpload(urlStorageKey: string): Promise<void> {
    await AsyncStorage.removeItem(urlStorageKey);
  }
}

function parseUploadId(uploadUrl: string): string {
  try {
    const url = new URL(uploadUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? uploadUrl;
  } catch {
    const segments = uploadUrl.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? uploadUrl;
  }
}

function getHttpStatus(error: unknown): number | undefined {
  const originalResponse = (error as { originalResponse?: { getStatus?: () => number } })
    ?.originalResponse;

  const maybeStatus = originalResponse?.getStatus;
  if (typeof maybeStatus === "function") {
    try {
      const value = maybeStatus.call(originalResponse);
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    } catch {
      // continue with fallback parsing
    }
  }

  const message = error instanceof Error ? error.message : "";
  const statusMatch = message.match(/response code:\s*(\d{3})/i) ?? message.match(/\b(\d{3})\b/);
  if (statusMatch) {
    const parsed = Number(statusMatch[1]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function isLikelyNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("network") ||
    message.includes("offline") ||
    message.includes("failed to fetch") ||
    message.includes("connection")
  );
}

function isRetryableTusError(error: unknown): boolean {
  const maybeRetryable = (
    tus.Upload as unknown as {
      isRetryableError?: (inputError: unknown) => boolean;
    }
  ).isRetryableError;

  if (typeof maybeRetryable === "function") {
    return maybeRetryable(error);
  }

  const status = getHttpStatus(error);
  if (typeof status !== "number") {
    return false;
  }

  return status >= 500 || status === 409 || status === 423 || status === 429;
}

function toUploadError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error("Issue attachment upload failed.");
  }

  const status = getHttpStatus(error);
  if (status === 401 || status === 403) {
    return new Error(
      "Issue attachment upload was rejected by the server (403). Please verify report-upload authorization on the TUS endpoint."
    );
  }

  if (typeof status === "number" && status >= 400 && status < 500) {
    return new Error(`Issue attachment upload failed with status ${status}.`);
  }

  return error;
}

function createFingerprint(params: {
  fileUri: string;
  fileName: string;
  fileSize: number;
  reportId: string;
}): string {
  return [
    "issue-report",
    params.reportId,
    params.fileName,
    params.fileSize,
    params.fileUri,
  ].join(":");
}

function normalizeTusEndpoint(endpoint: string): string {
  return endpoint.replace(/\/$/, "");
}

async function startTusUpload(
  upload: tus.Upload,
  fingerprintStorage: AsyncStorageUrlStorage,
  allowResume: boolean
): Promise<{ uploadUrl: string; resumed: boolean }> {
  let resumed = false;
  let resumedStorageKey: string | null = null;

  if (allowResume) {
    const previousUploads = await upload.findPreviousUploads();
    if (previousUploads.length > 0) {
      const previousUpload = previousUploads[0];
      resumed = true;
      resumedStorageKey = previousUpload.urlStorageKey ?? null;
      upload.resumeFromPreviousUpload(previousUpload);
    }
  }

  return new Promise((resolve, reject) => {
    let isSettled = false;
    let activityTimeout: ReturnType<typeof setTimeout> | null = null;

    const clearActivityTimeout = () => {
      if (activityTimeout) {
        clearTimeout(activityTimeout);
        activityTimeout = null;
      }
    };

    const touchActivity = () => {
      clearActivityTimeout();
      activityTimeout = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        upload.abort().catch(() => undefined);
        reject(
          new Error(
            "Issue attachment upload timed out due to no network activity. Please check connection and try again."
          )
        );
      }, UPLOAD_ACTIVITY_TIMEOUT_MS);
    };

    touchActivity();

    upload.options.onSuccess = () => {
      if (isSettled) return;
      isSettled = true;
      clearActivityTimeout();

      if (!upload.url) {
        reject(new Error("TUS upload completed without an upload URL."));
        return;
      }

      resolve({
        uploadUrl: upload.url,
        resumed,
      });
    };

    upload.options.onError = async (error: Error) => {
      if (isSettled) return;
      isSettled = true;
      clearActivityTimeout();

      const status = getHttpStatus(error);
      if (status === 404 && resumed && resumedStorageKey) {
        await fingerprintStorage.removeUpload(resumedStorageKey);
      }
      reject(error);
    };

    const previousProgressHandler = upload.options.onProgress;
    upload.options.onProgress = (bytesUploaded, bytesTotal) => {
      touchActivity();
      previousProgressHandler?.(bytesUploaded, bytesTotal);
    };

    const previousBeforeRequest = upload.options.onBeforeRequest;
    upload.options.onBeforeRequest = async (req) => {
      touchActivity();
      req.setHeader("Tus-Resumable", TUS_RESUMABLE_VERSION);
      console.log(
        `[ReportIssueTUS] ${req.getMethod()} ${req.getURL()} starting (Tus-Resumable=${req.getHeader("Tus-Resumable") ?? "missing"})`
      );
      if (previousBeforeRequest) {
        await previousBeforeRequest(req);
      }
    };

    const previousAfterResponse = upload.options.onAfterResponse;
    upload.options.onAfterResponse = async (req, res) => {
      touchActivity();
      console.log(
        `[ReportIssueTUS] ${req.getMethod()} ${req.getURL()} -> ${res.getStatus()}`
      );
      if (previousAfterResponse) {
        await previousAfterResponse(req, res);
      }
    };

    try {
      upload.start();
    } catch (error) {
      if (isSettled) return;
      isSettled = true;
      clearActivityTimeout();
      reject(error instanceof Error ? error : new Error("Failed to start TUS upload."));
    }
  });
}

export async function uploadIssueZipViaTus(
  input: ReportIssueTusUploadInput
): Promise<ReportIssueTusUploadResult> {
  console.log("[ReportIssueTUS] Starting issue attachment upload...");
  const fileInfo = await FileSystem.getInfoAsync(input.fileUri);
  if (!fileInfo.exists) {
    throw new Error("Issue attachment file not found.");
  }

  const fileSize = "size" in fileInfo && typeof fileInfo.size === "number" ? fileInfo.size : 0;
  if (fileSize <= 0) {
    throw new Error("Issue attachment file is empty.");
  }
  console.log(`[ReportIssueTUS] File size: ${fileSize} bytes`);

  const endpoint = normalizeTusEndpoint(input.endpoint);
  console.log(`[ReportIssueTUS] Endpoint: ${endpoint}`);
  const urlStorage = new AsyncStorageUrlStorage();
  const fingerprint = createFingerprint({
    fileUri: input.fileUri,
    fileName: input.fileName,
    fileSize,
    reportId: input.reportId,
  });

  const metadata: Record<string, string> = {
    filename: input.fileName,
    reportId: input.reportId,
    contentType: input.fileType,
  };

  const makeUpload = () =>
    new tus.Upload(
      {
        uri: input.fileUri,
        name: input.fileName,
        type: input.fileType,
      } as unknown as Blob,
      {
        endpoint,
        headers: {
          "tus-resumable": TUS_RESUMABLE_VERSION,
        },
        metadata,
        uploadSize: fileSize,
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        retryDelays: [0, 500, 1000, 2000, 4000, 8000, 16000],
        urlStorage: urlStorage as unknown as tus.UrlStorage,
        fingerprint: () => Promise.resolve(fingerprint),
        onProgress: (bytesUploaded, bytesTotal) => {
          input.onProgress?.({
            bytesUploaded,
            bytesTotal,
          });
        },
        onShouldRetry: (error, retryAttempt) => {
          const status = getHttpStatus(error);

          if (typeof status === "number" && status >= 400 && status < 500) {
            return false;
          }

          if (retryAttempt > 10) {
            return false;
          }

          if (status === 404) {
            return false;
          }

          return isLikelyNetworkError(error) || isRetryableTusError(error);
        },
      }
    );

  try {
    const initialUpload = makeUpload();
    console.log("[ReportIssueTUS] Attempting resume or fresh upload...");
    const result = await startTusUpload(initialUpload, urlStorage, true);
    console.log(`[ReportIssueTUS] Upload completed. URL: ${result.uploadUrl}`);
    return {
      uploadUrl: result.uploadUrl,
      uploadId: parseUploadId(result.uploadUrl),
    };
  } catch (error) {
    if (getHttpStatus(error) !== 404) {
      throw toUploadError(error);
    }

    input.onNotice?.("Previous upload expired. Retrying from start...");
    console.log("[ReportIssueTUS] Resume upload returned 404. Restarting from zero.");

    const staleUploads = await urlStorage.findUploadsByFingerprint(fingerprint);
    await Promise.all(
      staleUploads.map((entry) =>
        entry.urlStorageKey ? urlStorage.removeUpload(entry.urlStorageKey) : Promise.resolve()
      )
    );

    const retryUpload = makeUpload();
    const retryResult = await startTusUpload(retryUpload, urlStorage, false);
    console.log(`[ReportIssueTUS] Retry upload completed. URL: ${retryResult.uploadUrl}`);
    return {
      uploadUrl: retryResult.uploadUrl,
      uploadId: parseUploadId(retryResult.uploadUrl),
    };
  }
}

import {
  buildDraftsAttachment,
  ReportIssueAttachment,
} from "@/utils/reportIssueAttachment";
import { uploadIssueZipViaTus } from "@/utils/reportIssueTusUpload";

// const REPORT_ISSUE_ENDPOINT = "http://localhost:3000/api/report_issue";
const REPORT_ISSUE_ENDPOINT = "https://pulse-vault.opensource.mieweb.org/api/report_issue";
const REPORT_ISSUE_TUS_ENDPOINT = "https://pulse-vault.opensource.mieweb.org/api/report_issue/tus";
// const REPORT_ISSUE_ENDPOINT = "http://localhost:3000/api/report_issue";
// const REPORT_ISSUE_TUS_ENDPOINT = "http://localhost:3000/api/report_issue/tus";

const PREPARING_START_PROGRESS = 0;
const PREPARING_DONE_PROGRESS = 0.35;
const UPLOAD_START_PROGRESS = 0.35;
const UPLOAD_DONE_PROGRESS = 0.95;
const FINALIZING_START_PROGRESS = 0.96;
const FINALIZING_DONE_PROGRESS = 1;

export interface SubmitIssueReportInput {
  summary: string;
  description: string;
  includeDraftFolder: boolean;
}

export interface SubmitIssueReportResult {
  success: boolean;
  attachedFileName?: string;
  issueNumber?: number;
  issueUrl?: string;
  uploadId?: string | null;
  downloadUrl?: string | null;
}

export type SubmitIssueReportProgressPhase =
  | "preparing-payload"
  | "uploading"
  | "finalizing";

export interface SubmitIssueReportProgress {
  phase: SubmitIssueReportProgressPhase;
  progress: number;
  loaded?: number;
  total?: number;
  message?: string;
}

export type SubmitIssueReportProgressCallback = (
  progress: SubmitIssueReportProgress
) => void;

interface ReportIssueApiResponse {
  success?: boolean;
  issueNumber?: number;
  issueUrl?: string;
  uploadId?: string | null;
  downloadUrl?: string | null;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function emitProgress(
  onProgress: SubmitIssueReportProgressCallback | undefined,
  progress: SubmitIssueReportProgress
): void {
  if (!onProgress) return;
  onProgress({
    ...progress,
    progress: clampProgress(progress.progress),
  });
}

function postFormData(
  url: string,
  formData: FormData
): Promise<{ status: number; responseText: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open("POST", url);

    xhr.onload = () => {
      resolve({
        status: xhr.status,
        responseText: xhr.responseText ?? "",
      });
    };

    xhr.onerror = () => {
      reject(new Error("Network error while submitting issue report."));
    };

    xhr.onabort = () => {
      reject(new Error("Issue report upload was aborted."));
    };

    xhr.send(formData);
  });
}

function createReportId(): string {
  return `report-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function cleanupAttachment(attachment: ReportIssueAttachment | null): Promise<void> {
  if (!attachment) return;

  try {
    const fileSystem = await import("expo-file-system");
    await fileSystem.deleteAsync(attachment.uri, { idempotent: true });
  } catch {
    // non-blocking cleanup
  }
}

export async function submitIssueReport(
  input: SubmitIssueReportInput,
  onProgress?: SubmitIssueReportProgressCallback
): Promise<SubmitIssueReportResult> {
  const summary = input.summary.trim();
  const description = input.description.trim();

  if (!summary) {
    throw new Error("Summary is required.");
  }

  if (!description) {
    throw new Error("Description is required.");
  }

  emitProgress(onProgress, {
    phase: "preparing-payload",
    progress: PREPARING_START_PROGRESS,
    message: "Preparing payload.",
  });

  const formData = new FormData();
  formData.append("summary", summary);
  formData.append("description", description);
  const reportId = createReportId();
  formData.append("reportId", reportId);

  let attachment: ReportIssueAttachment | null = null;
  if (input.includeDraftFolder) {
    emitProgress(onProgress, {
      phase: "preparing-payload",
      progress: 0.15,
      message: "Creating draft attachment.",
    });
    console.log("1 :::", new Date().toLocaleTimeString());
    attachment = await buildDraftsAttachment();
    console.log("2 :::", new Date().toLocaleTimeString());
    if (!attachment) {
      emitProgress(onProgress, {
        phase: "preparing-payload",
        progress: 0.22,
        message: "No drafts found. Continuing without draft attachment.",
      });
      console.log("[ReportIssue] No drafts available; submitting without draft attachment.");
    }
  }

  emitProgress(onProgress, {
    phase: "preparing-payload",
    progress: PREPARING_DONE_PROGRESS,
    message: "Payload ready.",
  });

  emitProgress(onProgress, {
    phase: "uploading",
    progress: UPLOAD_START_PROGRESS,
    loaded: 0,
    message: "Uploading issue report.",
  });

  if (attachment) {
    console.log("3 :::", new Date().toLocaleTimeString());
    const attachmentType = attachment.type || "application/zip";
    const attachmentName = attachment.name || `issue-report-${Date.now()}.zip`;

    const tusUploadResult = await uploadIssueZipViaTus({
      endpoint: REPORT_ISSUE_TUS_ENDPOINT,
      fileUri: attachment.uri,
      fileName: attachmentName,
      fileType: attachmentType,
      reportId,
      onProgress: ({ bytesUploaded, bytesTotal }) => {
        const uploadProgress =
          typeof bytesTotal === "number" && bytesTotal > 0
            ? bytesUploaded / bytesTotal
            : 0;

        const globalProgress =
          UPLOAD_START_PROGRESS +
          (UPLOAD_DONE_PROGRESS - UPLOAD_START_PROGRESS) *
            clampProgress(uploadProgress);

        emitProgress(onProgress, {
          phase: "uploading",
          progress: globalProgress,
          loaded: bytesUploaded,
          total: bytesTotal,
        });
      },
      onNotice: (message) => {
        emitProgress(onProgress, {
          phase: "uploading",
          progress: UPLOAD_START_PROGRESS,
          message,
        });
      },
    });

    formData.append("zipUploadMode", "tus");
    formData.append("zipFileName", attachmentName);
    formData.append("zipContentType", attachmentType);
    formData.append("zipTusUploadId", tusUploadResult.uploadId);
    formData.append("zipTusUploadUrl", tusUploadResult.uploadUrl);

    emitProgress(onProgress, {
      phase: "uploading",
      progress: UPLOAD_DONE_PROGRESS,
      loaded: 1,
      total: 1,
      message: "Upload complete. Submitting report details.",
    });
    console.log("4 :::", new Date().toLocaleTimeString());
  } else {
    emitProgress(onProgress, {
      phase: "uploading",
      progress: UPLOAD_DONE_PROGRESS,
      loaded: 1,
      total: 1,
      message: "Submitting report details.",
    });
  }

  const { status, responseText } = await postFormData(REPORT_ISSUE_ENDPOINT, formData);

  emitProgress(onProgress, {
    phase: "finalizing",
    progress: FINALIZING_START_PROGRESS,
    message: "Finalizing issue report.",
  });

  if (status < 200 || status >= 300) {
    const errorText = responseText || "";
    const message = errorText
      ? `Failed to report issue (${status}): ${errorText}`
      : `Failed to report issue (${status}).`;
    throw new Error(message);
  }

  let responseJson: ReportIssueApiResponse | null = null;
  if (responseText) {
    try {
      responseJson = JSON.parse(responseText) as ReportIssueApiResponse;
    } catch {
      responseJson = null;
    }
  }

  if (responseJson && responseJson.success === false) {
    throw new Error("Issue report was not accepted by the server.");
  }

  emitProgress(onProgress, {
    phase: "finalizing",
    progress: FINALIZING_DONE_PROGRESS,
    message: "Issue report submitted.",
  });

  await cleanupAttachment(attachment);

  return {
    success: responseJson?.success ?? true,
    attachedFileName: attachment?.name,
    issueNumber: responseJson?.issueNumber,
    issueUrl: responseJson?.issueUrl,
    uploadId: responseJson?.uploadId ?? null,
    downloadUrl: responseJson?.downloadUrl ?? null,
  };
}

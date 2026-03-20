import {
  buildDraftsAttachment,
  ReportIssueAttachment,
} from "@/utils/reportIssueAttachment";

const REPORT_ISSUE_ENDPOINT = "http://localhost:3000/api/report_issue";

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

function appendAttachment(formData: FormData, attachment: ReportIssueAttachment) {
  formData.append("zip", {
    uri: attachment.uri,
    name: attachment.name,
    type: attachment.type,
  } as unknown as Blob);
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

function postFormDataWithProgress(
  url: string,
  formData: FormData,
  onProgress?: (loaded: number, total?: number) => void
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

    xhr.upload.onprogress = (event: ProgressEvent<EventTarget>) => {
      const total = event.lengthComputable ? event.total : undefined;
      onProgress?.(event.loaded, total);
    };

    xhr.send(formData);
  });
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
      throw new Error("Failed to create draft attachment.");
    }
    console.log("3 :::", new Date().toLocaleTimeString());
    appendAttachment(formData, attachment);
    console.log("4 :::", new Date().toLocaleTimeString());
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

  const { status, responseText } = await postFormDataWithProgress(
    REPORT_ISSUE_ENDPOINT,
    formData,
    (loaded, total) => {
      const uploadProgress =
        typeof total === "number" && total > 0 ? loaded / total : 0;
      const globalProgress =
        UPLOAD_START_PROGRESS +
        (UPLOAD_DONE_PROGRESS - UPLOAD_START_PROGRESS) *
          clampProgress(uploadProgress);

      emitProgress(onProgress, {
        phase: "uploading",
        progress: globalProgress,
        loaded,
        total,
      });
    }
  );

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

  return {
    success: responseJson?.success ?? true,
    attachedFileName: attachment?.name,
    issueNumber: responseJson?.issueNumber,
    issueUrl: responseJson?.issueUrl,
    uploadId: responseJson?.uploadId ?? null,
    downloadUrl: responseJson?.downloadUrl ?? null,
  };
}

import {
  buildDraftsAttachment,
  ReportIssueAttachment,
} from "@/utils/reportIssueAttachment";

const REPORT_ISSUE_ENDPOINT = "http://localhost:3000/api/report_issue";

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

interface ReportIssueApiResponse {
  success?: boolean;
  issueNumber?: number;
  issueUrl?: string;
  uploadId?: string | null;
  downloadUrl?: string | null;
}

function appendAttachment(formData: FormData, attachment: ReportIssueAttachment) {
  formData.append("zip", {
    uri: attachment.uri,
    name: attachment.name,
    type: attachment.type,
  } as unknown as Blob);
}

export async function submitIssueReport(
  input: SubmitIssueReportInput
): Promise<SubmitIssueReportResult> {
  const summary = input.summary.trim();
  const description = input.description.trim();

  if (!summary) {
    throw new Error("Summary is required.");
  }

  if (!description) {
    throw new Error("Description is required.");
  }

  const formData = new FormData();
  formData.append("summary", summary);
  formData.append("description", description);

  let attachment: ReportIssueAttachment | null = null;
  if (input.includeDraftFolder) {
    attachment = await buildDraftsAttachment();
    if (!attachment) {
      throw new Error("Failed to create draft attachment.");
    }
    appendAttachment(formData, attachment);
  }

  const response = await fetch(REPORT_ISSUE_ENDPOINT, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const message = errorText
      ? `Failed to report issue (${response.status}): ${errorText}`
      : `Failed to report issue (${response.status}).`;
    throw new Error(message);
  }

  const responseJson = (await response.json().catch(() => null)) as
    | ReportIssueApiResponse
    | null;

  if (responseJson && responseJson.success === false) {
    throw new Error("Issue report was not accepted by the server.");
  }

  return {
    success: responseJson?.success ?? true,
    attachedFileName: attachment?.name,
    issueNumber: responseJson?.issueNumber,
    issueUrl: responseJson?.issueUrl,
    uploadId: responseJson?.uploadId ?? null,
    downloadUrl: responseJson?.downloadUrl ?? null,
  };
}

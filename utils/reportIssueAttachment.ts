import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import * as FileSystem from "expo-file-system";
import JSZip from "jszip";

export interface ReportIssueAttachment {
  uri: string;
  name: string;
  type: string;
}

export async function buildDraftsAttachment(): Promise<ReportIssueAttachment | null> {
  const drafts = await DraftStorage.getAllDrafts();
  if (drafts.length === 0) {
    return null;
  }

  const zip = new JSZip();
  const metadata = drafts
    .slice()
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
    .map((draft) => ({
      id: draft.id,
      mode: draft.mode,
      name: draft.name ?? null,
      createdAt: draft.createdAt.toISOString(),
      lastModified: draft.lastModified.toISOString(),
      maxDurationLimitSeconds: draft.maxDurationLimitSeconds,
      segmentCount: draft.segments.length,
    }));

  zip.file("metadata.json", JSON.stringify({ drafts: metadata }, null, 2));

  for (const draft of drafts) {
    const absoluteFiles = await fileStore.getDraftFiles(draft.id);
    for (const absolutePath of absoluteFiles) {
      const info = await FileSystem.getInfoAsync(absolutePath);
      if (!info.exists) {
        continue;
      }

      const base64Content = await FileSystem.readAsStringAsync(absolutePath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const relativePath = fileStore.toRelativePath(absolutePath);
      zip.file(relativePath, base64Content, { base64: true });
    }
  }

  const zipBase64 = await zip.generateAsync({
    type: "base64",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const reportsDir = `${FileSystem.cacheDirectory}reports/`;
  const reportsDirInfo = await FileSystem.getInfoAsync(reportsDir);
  if (!reportsDirInfo.exists) {
    await FileSystem.makeDirectoryAsync(reportsDir, { intermediates: true });
  }

  const zipFileName = `pulse-report-drafts-${Date.now()}.zip`;
  const attachmentUri = `${reportsDir}${zipFileName}`;
  await FileSystem.writeAsStringAsync(attachmentUri, zipBase64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return {
    uri: attachmentUri,
    name: zipFileName,
    type: "application/zip",
  };
}

import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import * as FileSystem from "expo-file-system";
import JSZip = require("jszip");

export interface ReportIssueAttachment {
  uri: string;
  name: string;
  type: string;
}

const DRAFTS_DIR_RELATIVE = "pulse/drafts/";

function hasZipMagic(base64: string): boolean {
  return base64.startsWith("UEsDB") || base64.startsWith("UEsFB") || base64.startsWith("UEsBA");
}

async function validateZipBase64(zipBase64: string): Promise<void> {
  if (!hasZipMagic(zipBase64)) {
    throw new Error("Generated draft archive is not a valid ZIP (invalid file signature).");
  }

  await JSZip.loadAsync(zipBase64, { base64: true });
}

async function getDraftIdsFromFileSystem(): Promise<string[]> {
  const draftsRoot = `${FileSystem.documentDirectory}${DRAFTS_DIR_RELATIVE}`;
  const draftsRootInfo = await FileSystem.getInfoAsync(draftsRoot);
  if (!draftsRootInfo.exists) {
    return [];
  }

  const entries = await FileSystem.readDirectoryAsync(draftsRoot);
  const ids = entries
    .map((entry) => entry.replace(/\/$/, ""))
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(ids));
}

export async function buildDraftsAttachment(): Promise<ReportIssueAttachment | null> {
  const drafts = await DraftStorage.getAllDrafts();
  const fileSystemDraftIds = await getDraftIdsFromFileSystem();
  const draftIds = Array.from(
    new Set([...drafts.map((draft) => draft.id), ...fileSystemDraftIds])
  );

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

  zip.file(
    "metadata.json",
    JSON.stringify(
      {
        drafts: metadata,
        discoveredDraftFolderIds: draftIds,
      },
      null,
      2
    )
  );

  for (const draftId of draftIds) {
    const absoluteFiles = await fileStore.getDraftFiles(draftId);
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

  await validateZipBase64(zipBase64);

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

  const persistedZipBase64 = await FileSystem.readAsStringAsync(attachmentUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  await validateZipBase64(persistedZipBase64);

  return {
    uri: attachmentUri,
    name: zipFileName,
    type: "application/zip",
  };
}

import { DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import * as FileSystem from "expo-file-system";
import { zip } from "react-native-zip-archive";

export interface ReportIssueAttachment {
  uri: string;
  name: string;
  type: string;
}

const DRAFTS_DIR_RELATIVE = "pulse/drafts/";

function normalizeToFileUri(path: string): string {
  if (!path) return path;
  if (path.startsWith("file://")) return path;
  if (path.startsWith("/")) return `file://${path}`;
  return path;
}

async function ensureDir(path: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

function randomSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
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
  const startTs = Date.now();
  console.log("[ReportIssueAttachment] Building draft zip attachment...");

  const drafts = await DraftStorage.getAllDrafts();
  const fileSystemDraftIds = await getDraftIdsFromFileSystem();
  const draftIds = Array.from(
    new Set([...drafts.map((draft) => draft.id), ...fileSystemDraftIds])
  );

  console.log(
    `[ReportIssueAttachment] Drafts from metadata=${drafts.length}, filesystem=${fileSystemDraftIds.length}, merged=${draftIds.length}`
  );

  if (draftIds.length === 0) {
    console.log("[ReportIssueAttachment] No drafts found. Skipping attachment.");
    return null;
  }

  const reportsDir = `${FileSystem.cacheDirectory}reports/`;
  await ensureDir(reportsDir);

  const buildId = randomSuffix();
  const stagingDir = `${reportsDir}report-build-${buildId}/`;
  await ensureDir(stagingDir);

  const cleanupPaths = [stagingDir];

  const zipFileName = `pulse-report-drafts-${Date.now()}.zip`;
  const zipOutputPath = `${reportsDir}${zipFileName}`;
  const normalizedZipOutputPath = normalizeToFileUri(zipOutputPath);

  const outputInfo = await FileSystem.getInfoAsync(zipOutputPath);
  if (outputInfo.exists) {
    await FileSystem.deleteAsync(zipOutputPath, { idempotent: true });
  }

  try {
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

    const metadataPath = `${stagingDir}metadata.json`;
    await FileSystem.writeAsStringAsync(
      metadataPath,
      JSON.stringify(
        {
          drafts: metadata,
          discoveredDraftFolderIds: draftIds,
        },
        null,
        2
      ),
      { encoding: FileSystem.EncodingType.UTF8 }
    );

    let copiedFileCount = 0;

  for (const draftId of draftIds) {
    const absoluteFiles = await fileStore.getDraftFiles(draftId);
    console.log(
      `[ReportIssueAttachment] Draft ${draftId}: found ${absoluteFiles.length} file(s) to include`
    );

    for (const absolutePath of absoluteFiles) {
      const info = await FileSystem.getInfoAsync(absolutePath);
      if (!info.exists) {
        console.warn(`[ReportIssueAttachment] Missing source file, skipping: ${absolutePath}`);
        continue;
      }

      const relativePath = fileStore.toRelativePath(absolutePath);
        const targetPath = `${stagingDir}${relativePath}`;
        const targetDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
        await ensureDir(targetDir);
        await FileSystem.copyAsync({ from: absolutePath, to: targetPath });
        copiedFileCount += 1;
    }
  }

    console.log(
      `[ReportIssueAttachment] Copied ${copiedFileCount} file(s) into staging: ${stagingDir}`
    );

    console.log(
      `[ReportIssueAttachment] Zipping staging directory -> ${normalizedZipOutputPath}`
    );

    let zipUri: string;
    try {
      zipUri = await zip(stagingDir, normalizedZipOutputPath);
    } catch (error) {
      console.error("[ReportIssueAttachment] Native zip operation failed", {
        stagingDir,
        normalizedZipOutputPath,
        error,
      });
      throw new Error("Failed to create draft zip attachment (native zip failed).");
    }

    const finalUriCandidates = Array.from(
      new Set([
        zipUri,
        normalizeToFileUri(zipUri),
        zipOutputPath,
        normalizedZipOutputPath,
      ])
    ).filter((candidate) => !!candidate);

    let finalUri: string | null = null;
    for (const candidate of finalUriCandidates) {
      const info = await FileSystem.getInfoAsync(candidate);
      console.log(
        `[ReportIssueAttachment] Zip candidate check exists=${info.exists} path=${candidate}`
      );
      if (info.exists) {
        finalUri = candidate;
        break;
      }
    }

    if (!finalUri) {
      throw new Error(
        `Failed to create draft zip attachment. zip() returned: ${zipUri}`
      );
    }

    const zipInfo = await FileSystem.getInfoAsync(finalUri);
    const zipSize = "size" in zipInfo && typeof zipInfo.size === "number" ? zipInfo.size : 0;
    console.log(
      `[ReportIssueAttachment] Zip ready (${zipSize} bytes) at ${finalUri} in ${Date.now() - startTs}ms`
    );

  return {
      uri: finalUri,
      name: zipFileName,
      type: "application/zip",
    };
  } finally {
    await Promise.all(
      cleanupPaths.map((path) =>
        FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined)
      )
    );
  }
}

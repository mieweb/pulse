import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Draft, DraftStorage } from './draftStorage';
import { fileStore } from './fileStore';
import * as Crypto from 'expo-crypto';

interface DraftPackage {
  version: string;
  draft: Draft;
  files: {
    [key: string]: string; // relativePath -> base64 encoded content
  };
}

const DRAFT_PACKAGE_VERSION = '1.0';
const EXPORT_DIR = `${FileSystem.cacheDirectory}exports/`;

/**
 * Utility for exporting and importing drafts between devices.
 * 
 * Supports:
 * - Exporting drafts as self-contained packages
 * - Importing drafts from packages
 * - Sharing via AirDrop, Files app, etc.
 */
export class DraftTransfer {
  /**
   * Export a draft to a shareable package file.
   * Creates a JSON file containing draft metadata and all associated video files.
   * 
   * @param draftId - The ID of the draft to export
   * @returns The URI of the exported package file
   */
  static async exportDraft(draftId: string): Promise<string> {
    try {
      console.log(`[DraftTransfer] Starting export for draft: ${draftId}`);
      
      // Get draft metadata
      const draft = await DraftStorage.getDraftById(draftId);
      if (!draft) {
        throw new Error(`Draft ${draftId} not found`);
      }

      // Ensure export directory exists
      const exportDirInfo = await FileSystem.getInfoAsync(EXPORT_DIR);
      if (!exportDirInfo.exists) {
        await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
      }

      // Collect all files associated with this draft
      const files: { [key: string]: string } = {};
      
      // Export segment files
      for (const segment of draft.segments) {
        const absolutePath = fileStore.toAbsolutePath(segment.uri);
        const fileInfo = await FileSystem.getInfoAsync(absolutePath);
        if (fileInfo.exists) {
          // Read file as base64
          const base64Content = await FileSystem.readAsStringAsync(absolutePath, {
            encoding: FileSystem.EncodingType.Base64,
          });
          files[segment.uri] = base64Content;
          console.log(`[DraftTransfer] Exported segment: ${segment.uri}`);
        } else {
          console.warn(`[DraftTransfer] Segment file not found: ${absolutePath}`);
        }
      }

      // Export thumbnail if present
      if (draft.thumbnail) {
        const absolutePath = fileStore.toAbsolutePath(draft.thumbnail);
        const fileInfo = await FileSystem.getInfoAsync(absolutePath);
        if (fileInfo.exists) {
          const base64Content = await FileSystem.readAsStringAsync(absolutePath, {
            encoding: FileSystem.EncodingType.Base64,
          });
          files[draft.thumbnail] = base64Content;
          console.log(`[DraftTransfer] Exported thumbnail: ${draft.thumbnail}`);
        }
      }

      // Create package
      const draftPackage: DraftPackage = {
        version: DRAFT_PACKAGE_VERSION,
        draft: {
          ...draft,
          // Store dates as ISO strings for JSON compatibility
          createdAt: draft.createdAt,
          lastModified: draft.lastModified,
        },
        files,
      };

      // Write package to file
      const exportFileName = `pulse-draft-${draft.name || draftId}-${Date.now()}.pulse`;
      const exportPath = `${EXPORT_DIR}${exportFileName}`;
      await FileSystem.writeAsStringAsync(
        exportPath,
        JSON.stringify(draftPackage),
        { encoding: FileSystem.EncodingType.UTF8 }
      );

      console.log(`[DraftTransfer] Export complete: ${exportPath}`);
      console.log(`[DraftTransfer] Package size: ${Object.keys(files).length} files`);
      
      return exportPath;
    } catch (error) {
      console.error('[DraftTransfer] Export failed:', error);
      throw error;
    }
  }

  /**
   * Import a draft from a package file.
   * Extracts metadata and files, creates a new draft.
   * 
   * @param packageUri - The URI of the package file to import
   * @returns The ID of the imported draft
   */
  static async importDraft(packageUri: string): Promise<string> {
    try {
      console.log(`[DraftTransfer] Starting import from: ${packageUri}`);

      // Read package file
      const packageContent = await FileSystem.readAsStringAsync(packageUri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const draftPackage: DraftPackage = JSON.parse(packageContent);

      // Verify package version
      if (draftPackage.version !== DRAFT_PACKAGE_VERSION) {
        console.warn(
          `[DraftTransfer] Package version mismatch: ${draftPackage.version} (expected ${DRAFT_PACKAGE_VERSION})`
        );
      }

      const { draft, files } = draftPackage;
      const newDraftId = draft.id;
      console.log(`[DraftTransfer] Importing draft: ${newDraftId}`);

      // Ensure draft directories exist
      await fileStore.ensureDraftDirs(newDraftId);
      const importedSegments = [];

      for (const segment of draft.segments) {
        const base64Content = files[segment.uri];
        if (!base64Content) {
          console.warn(`[DraftTransfer] Segment file missing in package: ${segment.uri}`);
          continue;
        }

        // Recreate the file path structure for the new draft ID
        const relativePath = segment.uri.replace(
          /drafts\/[^/]+\//,
          `drafts/${newDraftId}/`
        );
        const absolutePath = fileStore.toAbsolutePath(relativePath);

        // Ensure directory exists
        const dirPath = absolutePath.substring(0, absolutePath.lastIndexOf('/'));
        const dirInfo = await FileSystem.getInfoAsync(dirPath);
        if (!dirInfo.exists) {
          await FileSystem.makeDirectoryAsync(dirPath, { intermediates: true });
        }

        // Write file
        await FileSystem.writeAsStringAsync(absolutePath, base64Content, {
          encoding: FileSystem.EncodingType.Base64,
        });

        importedSegments.push({
          ...segment,
          uri: relativePath,
        });

        console.log(`[DraftTransfer] Imported segment: ${relativePath}`);
      }

      // Import thumbnail if present
      let importedThumbnail: string | undefined;
      if (draft.thumbnail && files[draft.thumbnail]) {
        const relativePath = draft.thumbnail.replace(
          /drafts\/[^/]+\//,
          `drafts/${newDraftId}/`
        );
        const absolutePath = fileStore.toAbsolutePath(relativePath);

        // Ensure directory exists
        const dirPath = absolutePath.substring(0, absolutePath.lastIndexOf('/'));
        const dirInfo = await FileSystem.getInfoAsync(dirPath);
        if (!dirInfo.exists) {
          await FileSystem.makeDirectoryAsync(dirPath, { intermediates: true });
        }

        await FileSystem.writeAsStringAsync(absolutePath, files[draft.thumbnail], {
          encoding: FileSystem.EncodingType.Base64,
        });

        importedThumbnail = relativePath;
        console.log(`[DraftTransfer] Imported thumbnail: ${relativePath}`);
      }

      const originalCreatedAt = draft.createdAt ? new Date(draft.createdAt) : undefined;
      const originalLastModified = draft.lastModified ? new Date(draft.lastModified) : undefined;
      await DraftStorage.saveDraft(
        importedSegments,
        draft.totalDuration,
        draft.mode,
        newDraftId,
        {
          createdAt: originalCreatedAt,
          lastModified: originalLastModified,
        }
      );

      // Update draft name if present
      if (draft.name) {
        await DraftStorage.updateDraftName(newDraftId, draft.name);
      }

      console.log(`[DraftTransfer] Import complete: ${newDraftId}`);
      console.log(`[DraftTransfer] Imported ${importedSegments.length} segments`);

      return newDraftId;
    } catch (error) {
      console.error('[DraftTransfer] Import failed:', error);
      throw error;
    }
  }

  /**
   * Export and share a draft via AirDrop, Files app, or other sharing options.
   * 
   * @param draftId - The ID of the draft to share
   */
  static async shareDraft(draftId: string): Promise<void> {
    try {
      // Check if sharing is available
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        throw new Error('Sharing is not available on this device');
      }

      // Export draft to package file
      const packageUri = await this.exportDraft(draftId);

      // Share the package
      await Sharing.shareAsync(packageUri, {
        mimeType: 'application/json',
        dialogTitle: 'Share Pulse Draft',
        UTI: 'public.json', // iOS Universal Type Identifier
      });

      console.log(`[DraftTransfer] Draft shared successfully: ${draftId}`);
    } catch (error) {
      console.error('[DraftTransfer] Share failed:', error);
      throw error;
    }
  }

  /**
   * Clean up exported package files to free up storage.
   */
  static async cleanupExports(): Promise<void> {
    try {
      const exportDirInfo = await FileSystem.getInfoAsync(EXPORT_DIR);
      if (exportDirInfo.exists) {
        await FileSystem.deleteAsync(EXPORT_DIR, { idempotent: true });
        console.log('[DraftTransfer] Export directory cleaned up');
      }
    } catch (error) {
      console.error('[DraftTransfer] Cleanup failed:', error);
    }
  }

  /**
   * Export all drafts to a single package file for backup purposes.
   * 
   * @returns The URI of the exported backup file
   */
  static async exportAllDrafts(): Promise<string> {
    try {
      console.log('[DraftTransfer] Starting full backup export');
      
      const allDrafts = await DraftStorage.getAllDrafts();
      if (allDrafts.length === 0) {
        throw new Error('No drafts to export');
      }

      // Ensure export directory exists
      const exportDirInfo = await FileSystem.getInfoAsync(EXPORT_DIR);
      if (!exportDirInfo.exists) {
        await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
      }

      const allPackages: { [draftId: string]: DraftPackage } = {};

      for (const draft of allDrafts) {
        // Collect files for this draft
        const files: { [key: string]: string } = {};
        
        for (const segment of draft.segments) {
          const absolutePath = fileStore.toAbsolutePath(segment.uri);
          const fileInfo = await FileSystem.getInfoAsync(absolutePath);
          if (fileInfo.exists) {
            const base64Content = await FileSystem.readAsStringAsync(absolutePath, {
              encoding: FileSystem.EncodingType.Base64,
            });
            files[segment.uri] = base64Content;
          }
        }

        if (draft.thumbnail) {
          const absolutePath = fileStore.toAbsolutePath(draft.thumbnail);
          const fileInfo = await FileSystem.getInfoAsync(absolutePath);
          if (fileInfo.exists) {
            const base64Content = await FileSystem.readAsStringAsync(absolutePath, {
              encoding: FileSystem.EncodingType.Base64,
            });
            files[draft.thumbnail] = base64Content;
          }
        }

        allPackages[draft.id] = {
          version: DRAFT_PACKAGE_VERSION,
          draft: {
            ...draft,
            createdAt: draft.createdAt,
            lastModified: draft.lastModified,
          },
          files,
        };
      }

      // Write backup file
      const backupFileName = `pulse-backup-${Date.now()}.pulse`;
      const backupPath = `${EXPORT_DIR}${backupFileName}`;
      await FileSystem.writeAsStringAsync(
        backupPath,
        JSON.stringify(allPackages),
        { encoding: FileSystem.EncodingType.UTF8 }
      );

      console.log(`[DraftTransfer] Backup complete: ${backupPath}`);
      console.log(`[DraftTransfer] Backed up ${allDrafts.length} drafts`);

      return backupPath;
    } catch (error) {
      console.error('[DraftTransfer] Backup export failed:', error);
      throw error;
    }
  }

  /**
   * Import all drafts from a backup file.
   * 
   * @param backupUri - The URI of the backup file to import
   * @returns Array of imported draft IDs
   */
  static async importAllDrafts(backupUri: string): Promise<string[]> {
    try {
      console.log(`[DraftTransfer] Starting backup import from: ${backupUri}`);

      const backupContent = await FileSystem.readAsStringAsync(backupUri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const allPackages: { [draftId: string]: DraftPackage } = JSON.parse(backupContent);

      const importedDraftIds: string[] = [];

      for (const [originalDraftId, draftPackage] of Object.entries(allPackages)) {
        try {
          const { draft, files } = draftPackage;
          const newDraftId = draft.id;
          
          // Ensure draft directories exist
          await fileStore.ensureDraftDirs(newDraftId);
          const importedSegments = [];

          for (const segment of draft.segments) {
            const base64Content = files[segment.uri];
            if (!base64Content) continue;

            const relativePath = segment.uri.replace(
              /drafts\/[^/]+\//,
              `drafts/${newDraftId}/`
            );
            const absolutePath = fileStore.toAbsolutePath(relativePath);

            const dirPath = absolutePath.substring(0, absolutePath.lastIndexOf('/'));
            const dirInfo = await FileSystem.getInfoAsync(dirPath);
            if (!dirInfo.exists) {
              await FileSystem.makeDirectoryAsync(dirPath, { intermediates: true });
            }

            await FileSystem.writeAsStringAsync(absolutePath, base64Content, {
              encoding: FileSystem.EncodingType.Base64,
            });

            importedSegments.push({
              ...segment,
              uri: relativePath,
            });
          }

          // Import thumbnail
          if (draft.thumbnail && files[draft.thumbnail]) {
            const relativePath = draft.thumbnail.replace(
              /drafts\/[^/]+\//,
              `drafts/${newDraftId}/`
            );
            const absolutePath = fileStore.toAbsolutePath(relativePath);

            const dirPath = absolutePath.substring(0, absolutePath.lastIndexOf('/'));
            const dirInfo = await FileSystem.getInfoAsync(dirPath);
            if (!dirInfo.exists) {
              await FileSystem.makeDirectoryAsync(dirPath, { intermediates: true });
            }

            await FileSystem.writeAsStringAsync(absolutePath, files[draft.thumbnail], {
              encoding: FileSystem.EncodingType.Base64,
            });
          }

          const originalCreatedAt = draft.createdAt ? new Date(draft.createdAt) : undefined;
          const originalLastModified = draft.lastModified ? new Date(draft.lastModified) : undefined;
          await DraftStorage.saveDraft(
            importedSegments,
            draft.totalDuration,
            draft.mode,
            newDraftId,
            {
              createdAt: originalCreatedAt,
              lastModified: originalLastModified,
            }
          );

          if (draft.name) {
            await DraftStorage.updateDraftName(newDraftId, draft.name);
          }

          importedDraftIds.push(newDraftId);
          console.log(`[DraftTransfer] Imported draft: ${originalDraftId} -> ${newDraftId}`);
        } catch (error) {
          console.error(`[DraftTransfer] Failed to import draft ${originalDraftId}:`, error);
        }
      }

      console.log(`[DraftTransfer] Backup import complete: ${importedDraftIds.length} drafts`);
      return importedDraftIds;
    } catch (error) {
      console.error('[DraftTransfer] Backup import failed:', error);
      throw error;
    }
  }
}

export default DraftTransfer;

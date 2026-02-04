import { RecordingSegment } from "@/components/RecordingProgressBar";
import { DraftMode, DraftStorage } from "@/utils/draftStorage";
import { fileStore } from "@/utils/fileStore";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Crypto from "expo-crypto";

const REDO_STACK_KEY = "redo_stack";

async function getDraftNameFromRedoStack(): Promise<string | undefined> {
  try {
    const savedRedoData = await AsyncStorage.getItem(REDO_STACK_KEY);
    if (savedRedoData) {
      const parsed = JSON.parse(savedRedoData);
      if (!Array.isArray(parsed) && parsed?.draftName) {
        return parsed.draftName;
      }
    }
  } catch (error) {
    console.warn("Failed to read draft name from redo stack:", error);
  }
  return undefined;
}

interface DraftManagerState {
  recordingSegments: RecordingSegment[];
  redoStack: RecordingSegment[];
  currentDraftId: string | null;
  originalDraftId: string | null;
  hasStartedOver: boolean;
  isContinuingLastDraft: boolean;
  showContinuingIndicator: boolean;
  savedDurationLimitSeconds: number | null;
  currentDraftName: string | undefined;
}

interface DraftManagerActions {
  setRecordingSegments: (segments: RecordingSegment[]) => void;
  setRedoStack: (stack: RecordingSegment[]) => void;
  handleStartOver: () => void;
  handleStartNew: () => void;
  handleSaveAsDraft: (
    segments: RecordingSegment[],
    maxDurationLimitSeconds: number,
    options?: { forceNew?: boolean }
  ) => Promise<void>;
  handleClose: () => Promise<void>;
  handleUndoSegment: (maxDurationLimitSeconds: number) => Promise<void>;
  handleRedoSegment: (maxDurationLimitSeconds: number) => Promise<void>;
  updateSegmentsAfterRecording: (
    newSegment: RecordingSegment,
    maxDurationLimitSeconds: number
  ) => Promise<void>;
  updateDraftDuration: (newDurationLimitSeconds: number) => Promise<void>;
}

/**
 * Custom hook for managing draft recording state and operations.
 *
 * Handles:
 * - Auto-loading last modified draft on mount
 * - Auto-saving segments as they're recorded
 * - Undo/redo stack with persistence
 * - Draft lifecycle (save, delete, start over)
 *
 * @param draftId - Optional specific draft to load
 * @param maxDurationLimitSeconds - Maximum recording duration limit in seconds
 */
export function useDraftManager(
  draftId?: string,
  maxDurationLimitSeconds: number = 60,
  mode: DraftMode = "camera"
): DraftManagerState & DraftManagerActions {
  const [recordingSegments, setRecordingSegments] = useState<
    RecordingSegment[]
  >([]);
  const [redoStack, setRedoStack] = useState<RecordingSegment[]>([]);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [originalDraftId, setOriginalDraftId] = useState<string | null>(null);
  const [hasStartedOver, setHasStartedOver] = useState(false);
  const [isContinuingLastDraft, setIsContinuingLastDraft] = useState(false);
  const [showContinuingIndicator, setShowContinuingIndicator] = useState(false);
  const [forceNewNext, setForceNewNext] = useState(false);
  const [savedDurationLimitSeconds, setSavedDurationLimitSeconds] = useState<number | null>(null);
  const [currentDraftName, setCurrentDraftName] = useState<string | undefined>(
    undefined
  );

  const isLoadingDraft = useRef(false);
  const lastSegmentCount = useRef(0);

  useEffect(() => {
    const loadDraft = async () => {
      isLoadingDraft.current = true;
      try {
        let draftToLoad = null;
        const savedRedoData = await AsyncStorage.getItem(REDO_STACK_KEY);
        let redoData = null;

        if (savedRedoData) {
          try {
            redoData = JSON.parse(savedRedoData);
            if (Array.isArray(redoData)) {
              redoData = { draftId: null, segments: redoData };
            }
          } catch {
            redoData = null;
          }
        }

        if (draftId) {
          draftToLoad = await DraftStorage.getDraftById(draftId, mode);
          setIsContinuingLastDraft(false);
        } else {
          // No draftId: always start with a fresh draft (no auto-loading last draft)
          draftToLoad = null;
          setIsContinuingLastDraft(false);
        }

        if (draftToLoad) {
          console.log(
            `[DraftManager] Loaded draft: ${draftToLoad.id} (${draftToLoad.segments.length} segments, ${draftToLoad.maxDurationLimitSeconds}s)`
          );
          const segmentsWithAbsolutePaths = fileStore.convertSegmentsToAbsolute(
            draftToLoad.segments
          );
          setRecordingSegments(segmentsWithAbsolutePaths);
          setCurrentDraftId(draftToLoad.id);
          setOriginalDraftId(draftToLoad.id);
          setSavedDurationLimitSeconds(draftToLoad.maxDurationLimitSeconds);
          setCurrentDraftName(draftToLoad.name);
          lastSegmentCount.current = draftToLoad.segments.length;
        } else {
          if (draftId) {
            if (redoData && redoData.segments && redoData.segments.length > 0) {
              if (redoData.draftId) {
                setOriginalDraftId(redoData.draftId);
              } else {
                setOriginalDraftId(null);
              }
            } else {
              setOriginalDraftId(null);
            }
          } else {
            setOriginalDraftId(null);
          }
        }

        if (!draftId) {
          // Fresh draft: don't restore redo stack from previous session
          setRedoStack([]);
        } else if (redoData && redoData.segments) {
          if (draftToLoad) {
            const shouldLoadRedoStack =
              redoData.draftId === draftToLoad.id || !redoData.draftId;
            const redoSegments = shouldLoadRedoStack ? redoData.segments : [];
            setRedoStack(fileStore.convertSegmentsToAbsolute(redoSegments));
          } else {
            setRedoStack(
              fileStore.convertSegmentsToAbsolute(redoData.segments)
            );
          }
        } else {
          setRedoStack([]);
        }
      } catch (error) {
        console.error("Error loading draft:", error);
      } finally {
        isLoadingDraft.current = false;
      }
    };

    loadDraft();
  }, [draftId, mode]);

  useEffect(() => {
    if (isContinuingLastDraft && recordingSegments.length > 0) {
      setShowContinuingIndicator(true);
      const hideTimer = setTimeout(() => {
        setShowContinuingIndicator(false);
        setIsContinuingLastDraft(false);
      }, 1000);

      return () => clearTimeout(hideTimer);
    }
  }, [isContinuingLastDraft]);

  useEffect(() => {
    const autoSave = async () => {
      if (recordingSegments.length === 0 || isLoadingDraft.current) {
        return;
      }

      if (recordingSegments.length <= lastSegmentCount.current) {
        return;
      }

      try {
        if (currentDraftId) {
          // Convert absolute paths back to relative paths for storage
          const segmentsForStorage = recordingSegments.map((segment) => ({
            ...segment,
            uri: fileStore.toRelativePath(segment.uri),
          }));
          await DraftStorage.updateDraft(
            currentDraftId,
            segmentsForStorage,
            maxDurationLimitSeconds
          );
          console.log(`[DraftManager] Auto-saved: ${currentDraftId}`);
        } else {
          // Convert absolute paths back to relative paths for storage
          const segmentsForStorage = recordingSegments.map((segment) => ({
            ...segment,
            uri: fileStore.toRelativePath(segment.uri),
          }));
          const newDraftId = await DraftStorage.saveDraft(
            segmentsForStorage,
            maxDurationLimitSeconds,
            mode,
            draftId
          );
          setCurrentDraftId(newDraftId);
          setCurrentDraftName(undefined);
          setHasStartedOver(false);
          console.log(`[DraftManager] Created new draft: ${newDraftId}`);
        }

        lastSegmentCount.current = recordingSegments.length;
      } catch (error) {
        console.error("Auto-save failed:", error);
      }
    };

    const timeoutId = setTimeout(autoSave, 1000);
    return () => clearTimeout(timeoutId);
  }, [recordingSegments, maxDurationLimitSeconds, currentDraftId]);

  useEffect(() => {
    const loadDraftName = async () => {
      if (currentDraftId) {
        try {
          const draft = await DraftStorage.getDraftById(currentDraftId);
          setCurrentDraftName(draft?.name);
        } catch (error) {
          console.warn("Failed to load draft name:", error);
          setCurrentDraftName(undefined);
        }
      } else {
        setCurrentDraftName(undefined);
      }
    };
    loadDraftName();
  }, [currentDraftId]);

  const effectiveDraftIdForRedo = useMemo(
    () => currentDraftId ?? originalDraftId,
    [currentDraftId, originalDraftId]
  );

  useEffect(() => {
    const saveRedoStack = async () => {
      try {
        // Convert absolute paths back to relative paths for storage
        const segmentsForStorage = redoStack.map((segment) => ({
          ...segment,
          uri: fileStore.toRelativePath(segment.uri),
        }));

        let draftName: string | undefined = currentDraftName;
        if (!draftName) {
          draftName = await getDraftNameFromRedoStack();
        }

        const effectiveDraftId = effectiveDraftIdForRedo ?? null;

        const redoData = {
          draftId: effectiveDraftId,
          segments: segmentsForStorage,
          ...(draftName && { draftName }),
        };
        await AsyncStorage.setItem(REDO_STACK_KEY, JSON.stringify(redoData));
      } catch (error) {
        console.error("Error saving redo stack:", error);
      }
    };

    saveRedoStack();
  }, [redoStack, currentDraftId, currentDraftName, effectiveDraftIdForRedo]);

  const handleStartOver = () => {
    console.log("[DraftManager] Starting over - clearing all segments");
    setRecordingSegments([]);
    setRedoStack([]);
    setCurrentDraftId(null);
    setCurrentDraftName(undefined);
    setHasStartedOver(true);
    lastSegmentCount.current = 0;
  };

  // Start New: clear local state, arm new-id-on-next-recording, do NOT mark hasStartedOver
  const handleStartNew = () => {
    setRecordingSegments([]);
    setRedoStack([]);
    setCurrentDraftId(null);
    setCurrentDraftName(undefined);
    setHasStartedOver(false);
    setForceNewNext(true);
    lastSegmentCount.current = 0;
  };

  const handleSaveAsDraft = async (
    segments: RecordingSegment[],
    maxDurationLimitSeconds: number,
    options?: { forceNew?: boolean }
  ) => {
    try {
      // Convert segments to relative paths for storage
      const segmentsForStorage = segments.map((segment) => ({
        ...segment,
        uri: fileStore.toRelativePath(segment.uri),
      }));

      if (currentDraftId && !hasStartedOver && !options?.forceNew) {
        await DraftStorage.updateDraft(
          currentDraftId,
          segmentsForStorage,
          maxDurationLimitSeconds
        );
        console.log(`[DraftManager] Saved & reset: ${currentDraftId}`);
      } else {
        const preferredId = options?.forceNew
          ? undefined
          : originalDraftId || draftId || undefined;
        const newId = await DraftStorage.saveDraft(
          segmentsForStorage,
          maxDurationLimitSeconds,
          mode,
          preferredId
        );
        setCurrentDraftId(newId);
        setCurrentDraftName(undefined);
        if (options?.forceNew) {
          // Ensure the next recording starts a new id by clearing original
          setOriginalDraftId(null);
          setForceNewNext(true);
        }
        console.log(`[DraftManager] New draft & reset: ${newId}`);
      }

      handleStartOver();
      setIsContinuingLastDraft(false);
    } catch (error) {
      console.error("Save failed:", error);
    }
  };

  const handleClose = async () => {
    if (hasStartedOver && originalDraftId && recordingSegments.length === 0) {
      try {
        await DraftStorage.deleteDraft(originalDraftId);
        console.log(
          `[DraftManager] WHOLE DRAFT DELETED - Original: ${originalDraftId}`
        );
      } catch (error) {
        console.error("Delete failed:", error);
      }
    }

    if (recordingSegments.length === 0) {
      try {
        // If there are redo segments persisted for this draft, delete their files too
        const savedRedoData = await AsyncStorage.getItem(REDO_STACK_KEY);
        if (savedRedoData) {
          try {
            const parsed = JSON.parse(savedRedoData);
            const segmentsToDelete = Array.isArray(parsed)
              ? parsed
              : parsed?.segments || [];
            if (segmentsToDelete.length > 0) {
              console.log(
                `[DraftManager] Closing - Deleting ${segmentsToDelete.length} redo files`
              );
              // Convert relative paths to absolute paths for deletion
              const absoluteUris = segmentsToDelete.map((s: any) =>
                fileStore.toAbsolutePath(s.uri)
              );
              try {
                await fileStore.deleteUris(absoluteUris);
              } catch (error) {
                console.warn(
                  "Failed to delete some redo files. URIs attempted:",
                  segmentsToDelete.map((s: any) => s.uri),
                  "Error:",
                  error
                );
              }
            }
          } catch (error) {
            console.warn(
              "Failed to parse redo stack data during cleanup:",
              error
            );
          }
        }

        await AsyncStorage.removeItem(REDO_STACK_KEY);
        setRedoStack([]);
      } catch (error) {
        console.error("Failed to clear redo stack:", error);
      }
    }
  };

  const handleUndoSegment = async (maxDurationLimitSeconds: number) => {
    if (recordingSegments.length > 0) {
      const lastSegment = recordingSegments[recordingSegments.length - 1];
      const updatedSegments = recordingSegments.slice(0, -1);

      setRedoStack((prev) => [...prev, lastSegment]);
      setRecordingSegments(updatedSegments);
      lastSegmentCount.current = updatedSegments.length;

      if (currentDraftId) {
        try {
          if (updatedSegments.length === 0) {
            // Get the draft name before deleting so we can restore it on redo
            const draftToDelete = await DraftStorage.getDraftById(
              currentDraftId
            );
            const draftName = draftToDelete?.name;
            const draftIdToStore = currentDraftId; // Save before clearing

            // Metadata-only delete so redo can recreate the draft; keep files on disk
            await DraftStorage.deleteDraft(currentDraftId, { keepFiles: true });
            setCurrentDraftId(null);
            setCurrentDraftName(undefined);
            setHasStartedOver(false);

            // Store the draft name in the redo stack data
            const savedRedoData = await AsyncStorage.getItem(REDO_STACK_KEY);
            if (savedRedoData) {
              try {
                const parsed = JSON.parse(savedRedoData);
                const redoData = Array.isArray(parsed)
                  ? {
                      draftId: draftIdToStore,
                      segments: parsed,
                      ...(draftName && { draftName }),
                    }
                  : {
                      ...parsed,
                      draftId: draftIdToStore,
                      ...(draftName && { draftName }),
                    };
                await AsyncStorage.setItem(
                  REDO_STACK_KEY,
                  JSON.stringify(redoData)
                );
              } catch (error) {
                console.warn(
                  "Failed to update redo stack with draft name:",
                  error
                );
              }
            } else {
              // Create new redo data with the draft name
              const redoData = {
                draftId: draftIdToStore,
                segments: redoStack.map((s) => ({
                  ...s,
                  uri: fileStore.toRelativePath(s.uri),
                })),
                ...(draftName && { draftName }),
              };
              await AsyncStorage.setItem(
                REDO_STACK_KEY,
                JSON.stringify(redoData)
              );
            }

            console.log(
              `[DraftManager] WHOLE DRAFT DELETED - Undo (metadata only): ${draftIdToStore}`
            );
          } else {
            // Convert segments to relative paths for storage
            const segmentsForStorage = updatedSegments.map((segment) => ({
              ...segment,
              uri: fileStore.toRelativePath(segment.uri),
            }));
            await DraftStorage.updateDraft(
              currentDraftId,
              segmentsForStorage,
              maxDurationLimitSeconds
            );
            console.log(
              `[DraftManager] Undo - Updated draft: ${currentDraftId}`
            );
          }
        } catch (error) {
          console.error("Undo failed:", error);
          // Revert on error
          setRecordingSegments(recordingSegments);
          setRedoStack(redoStack);
          lastSegmentCount.current = recordingSegments.length;
        }
      }
    }
  };

  const handleRedoSegment = async (maxDurationLimitSeconds: number) => {
    if (redoStack.length > 0) {
      const segmentToRestore = redoStack[redoStack.length - 1];
      const updatedRedoStack = redoStack.slice(0, -1);

      setRedoStack(updatedRedoStack);

      const updatedSegments = [...recordingSegments, segmentToRestore];
      setRecordingSegments(updatedSegments);
      lastSegmentCount.current = updatedSegments.length;

      try {
        if (!currentDraftId) {
          // Re-create using the original draft id if available so existing files (segments/thumb) are reused
          const preferredId = originalDraftId || draftId;

          // Get the draft name from redo stack data if available
          const savedDraftName = await getDraftNameFromRedoStack();

          // Convert segments to relative paths for storage
          const segmentsForStorage = updatedSegments.map((segment) => ({
            ...segment,
            uri: fileStore.toRelativePath(segment.uri),
          }));
          const newDraftId = await DraftStorage.saveDraft(
            segmentsForStorage,
            maxDurationLimitSeconds,
            mode,
            preferredId || undefined
          );

          // Restore the draft name if it was saved
          if (savedDraftName) {
            await DraftStorage.updateDraftName(newDraftId, savedDraftName);
            setCurrentDraftName(savedDraftName);
          } else {
            setCurrentDraftName(undefined);
          }

          setCurrentDraftId(newDraftId);
          setHasStartedOver(false);
          console.log(`[DraftManager] Redo - Created new draft: ${newDraftId}`);
        } else {
          // Convert segments to relative paths for storage
          const segmentsForStorage = updatedSegments.map((segment) => ({
            ...segment,
            uri: fileStore.toRelativePath(segment.uri),
          }));
          await DraftStorage.updateDraft(
            currentDraftId,
            segmentsForStorage,
            maxDurationLimitSeconds
          );
          console.log(`[DraftManager] Redo - Updated draft: ${currentDraftId}`);
        }
      } catch (error) {
        console.error("Redo failed:", error);
        // Revert on error
        setRecordingSegments(recordingSegments);
        setRedoStack(redoStack);
        lastSegmentCount.current = recordingSegments.length;
      }
    }
  };

  const updateSegmentsAfterRecording = async (
    newSegment: RecordingSegment,
    maxDurationLimitSeconds: number
  ) => {
    const prevRedo = redoStack;

    try {
      // Determine target draft id for file import and metadata save
      const targetDraftId = forceNewNext
        ? Crypto.randomUUID()
        : currentDraftId ?? draftId ?? Crypto.randomUUID();

      console.log(
        `[DraftManager] Recording segment - Target draft ID: ${targetDraftId}`
      );

      // Ensure directories exist and import the recorded file into managed storage
      await fileStore.ensureDraftDirs(targetDraftId);
      const managedUri = await fileStore.importSegment({
        draftId: targetDraftId,
        srcUri: newSegment.uri,
        segmentId: newSegment.id,
      });

      // Clear redo stack in state (new recording invalidates redo)
      setRedoStack([]);

      // Append the imported segment with managed URI
      const importedSegment: RecordingSegment = {
        ...newSegment,
        uri: managedUri,
      };
      const updatedSegments = [...recordingSegments, importedSegment];
      setRecordingSegments(updatedSegments);

      // Persist draft metadata
      if (currentDraftId && !forceNewNext) {
        // Convert segments to relative paths for storage
        const segmentsForStorage = updatedSegments.map((segment) => ({
          ...segment,
          uri: fileStore.toRelativePath(segment.uri),
        }));
        await DraftStorage.updateDraft(
          currentDraftId,
          segmentsForStorage,
          maxDurationLimitSeconds
        );
        console.log(
          `[DraftManager] Recording segment - Updated existing draft: ${currentDraftId}`
        );
      } else {
        const preferredId = forceNewNext
          ? targetDraftId
          : originalDraftId || draftId || targetDraftId;
        // Convert segments to relative paths for storage
        const segmentsForStorage = updatedSegments.map((segment) => ({
          ...segment,
          uri: fileStore.toRelativePath(segment.uri),
        }));
        const newDraftId = await DraftStorage.saveDraft(
          segmentsForStorage,
          maxDurationLimitSeconds,
          mode,
          preferredId
        );
        setCurrentDraftId(newDraftId);
        setOriginalDraftId(preferredId);
        setCurrentDraftName(undefined);
        setHasStartedOver(false);
        console.log(
          `[DraftManager] Recording segment - Created new draft: ${newDraftId}`
        );
        if (forceNewNext) setForceNewNext(false);
      }

      // Delete redo files now that redo stack is cleared and not referenced
      if (prevRedo.length > 0) {
        console.log(`[DraftManager] Deleting ${prevRedo.length} redo files`);
        // Convert relative paths to absolute paths for deletion
        const absoluteUris = prevRedo.map((s) =>
          fileStore.toAbsolutePath(s.uri)
        );
        await fileStore.deleteUris(absoluteUris);
      }

      lastSegmentCount.current = updatedSegments.length;
    } catch (error) {
      console.error("Save failed:", error);
    }
  };

  const updateDraftDuration = async (newDurationLimitSeconds: number) => {
    try {
      if (currentDraftId) {
        // Convert segments to relative paths for storage
        const segmentsForStorage = recordingSegments.map((segment) => ({
          ...segment,
          uri: fileStore.toRelativePath(segment.uri),
        }));
        await DraftStorage.updateDraft(
          currentDraftId,
          segmentsForStorage,
          newDurationLimitSeconds
        );
        setSavedDurationLimitSeconds(newDurationLimitSeconds);
        console.log(
          `[DraftManager] Updated draft duration: ${currentDraftId} -> ${newDurationLimitSeconds}s`
        );
      } else if (recordingSegments.length > 0) {
        // Create a new draft with the selected duration if we have segments but no draft
        const segmentsForStorage = recordingSegments.map((segment) => ({
          ...segment,
          uri: fileStore.toRelativePath(segment.uri),
        }));
        const newDraftId = await DraftStorage.saveDraft(
          segmentsForStorage,
          newDurationLimitSeconds,
          mode,
          draftId
        );
        setCurrentDraftId(newDraftId);
        setSavedDurationLimitSeconds(newDurationLimitSeconds);
        console.log(
          `[DraftManager] Created draft with duration: ${newDraftId} -> ${newDurationLimitSeconds}s`
        );
      }
    } catch (error) {
      console.error("Failed to update draft duration:", error);
    }
  };

  return {
    // State
    recordingSegments,
    redoStack,
    currentDraftId,
    originalDraftId,
    hasStartedOver,
    isContinuingLastDraft,
    showContinuingIndicator,
    savedDurationLimitSeconds,
    currentDraftName,
    // Actions
    setRecordingSegments,
    setRedoStack,
    handleStartOver,
    handleStartNew,
    handleSaveAsDraft,
    handleClose,
    handleUndoSegment,
    handleRedoSegment,
    updateSegmentsAfterRecording,
    updateDraftDuration,
  };
}

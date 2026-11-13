import { useSyncExternalStore } from 'react';

/**
 * Coarse transcription status, shown in the On-device AI sheet and the editor's captions. Written
 * by the clip queue (`transcribing` while a clip is being transcribed), `downloadModel` (a model
 * download) and model selection (`model-manager`), into this tiny module-level store.
 */
export type TranscriptionStatus =
  | { kind: 'idle' }
  | { kind: 'deleting' }
  | { kind: 'downloading'; bytesWritten: number; totalBytes: number }
  | { kind: 'transcribing' };

let current: TranscriptionStatus = { kind: 'idle' };
const listeners = new Set<() => void>();

/** Publish a new status; notifies every mounted `useTranscriptionStatus` consumer. */
export function setTranscriptionStatus(next: TranscriptionStatus): void {
  current = next;
  for (const listener of listeners) listener();
}

/** Back to idle, if the status is still `kind` (a writer finishing doesn't clear another's). */
export function clearTranscriptionStatus(kind: TranscriptionStatus['kind']): void {
  if (current.kind === kind) setTranscriptionStatus({ kind: 'idle' });
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/** Current transcription status (idle / deleting / downloading / transcribing). */
export function useTranscriptionStatus(): TranscriptionStatus {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

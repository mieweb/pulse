import type { DraftContext } from '@/db/drafts';
import { createPresence } from '@/utils/presence';

/** What a mounted recorder screen says of itself, read when asked (never cached). */
export type MountedRecorder = {
  /** Stop and save the take in progress, as the recorder's Close does. */
  finalize(): Promise<void>;
  /** The place a link opened it for, if one did. */
  place(): DraftContext | null;
  /** The draft it is on; `null` while it hasn't made one yet. */
  draftId(): string | null;
  /** Whether it is the screen on top, with nothing presented over it. */
  focused(): boolean;
};

/**
 * The recorder screens mounted right now — for navigation that replaces the recorder from outside
 * it (a link opening its place's recorder, see `open-recorder.ts`): to save its in-flight take
 * first, the way the recorder's close button does, to wait for its camera to be released, and to
 * tell when the recorder a link asks for is the one already on screen.
 */
const presence = createPresence();
const recorders = new Set<MountedRecorder>();

/** Called by a mounted recorder; the returned function unregisters it on unmount. */
export function registerRecorder(recorder: MountedRecorder): () => void {
  recorders.add(recorder);
  const leave = presence.enter();
  return () => {
    recorders.delete(recorder);
    leave();
  };
}

/** Stop and save any take in progress, in every mounted recorder. */
export async function finalizeRecorders(): Promise<void> {
  await Promise.all([...recorders].map((recorder) => recorder.finalize().catch(() => {})));
}

/** Resolves once no recorder is mounted (its camera released), or after `timeoutMs`. */
export function recordersGone(timeoutMs: number): Promise<void> {
  return presence.whenGone(timeoutMs);
}

/** The recorder on top of the stack, if one is: its place and the draft it is on. */
export function recorderOnScreen(): { place: DraftContext | null; draftId: string | null } | null {
  for (const recorder of recorders) {
    if (recorder.focused()) return { place: recorder.place(), draftId: recorder.draftId() };
  }
  return null;
}

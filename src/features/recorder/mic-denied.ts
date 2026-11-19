/**
 * What the recorder offers when it can use the camera but not the microphone (PLAN-final §5.3):
 * instead of the blocking "Camera access needed" screen, it records video only.
 *
 * - Microphone denied: "Record without sound?", with a link to Settings, where it can be turned
 *   back on.
 * - Microphone restricted (Screen Time, a device policy): the person can't allow it, so there's
 *   no question to ask; the recorder records without sound and offers the Settings link only.
 * - Microphone allowed, or not asked yet (the recorder's first-open request is still going):
 *   nothing.
 * - Camera not allowed: nothing here either; the blocking camera screen stays as it is.
 *
 * The host shows its own in-context explanation before the first request (PR3-W4). Pure: the
 * statuses are VisionCamera's (`useCameraPermission().status` and the microphone's).
 */

/** VisionCamera's `PermissionStatus`. */
export type PermissionStatus = 'not-determined' | 'authorized' | 'denied' | 'restricted';

export type MicOffer =
  /** Ask "Record without sound?", with Settings as the other way. */
  | { kind: 'without-sound'; settings: true }
  /** No question (it can't be allowed here): record without sound, with the Settings link. */
  | { kind: 'settings-only'; settings: true }
  | null;

export function micOffer(camera: PermissionStatus, mic: PermissionStatus): MicOffer {
  if (camera !== 'authorized') return null;
  if (mic === 'denied') return { kind: 'without-sound', settings: true };
  if (mic === 'restricted') return { kind: 'settings-only', settings: true };
  return null;
}

/**
 * Whether the recorder can run (the camera screen gives way to it). Without `micOptional` (the
 * Pulse app), both permissions are needed, as before. With it (embedded), the camera is enough
 * once the microphone has been asked: a denied or restricted microphone records without sound.
 */
export function recorderAllowed(
  camera: PermissionStatus,
  mic: PermissionStatus,
  micOptional: boolean,
): boolean {
  if (camera !== 'authorized') return false;
  if (mic === 'authorized') return true;
  return micOptional && (mic === 'denied' || mic === 'restricted');
}

export const MIC_COPY = {
  title: 'Record without sound?',
  body: 'Pulse can’t use the microphone. Allow it in Settings, or record video only.',
  withoutSound: 'Record without sound',
  settings: 'Open Settings',
  restricted: 'The microphone is turned off on this phone. Videos record without sound.',
  noSound: 'Recording without sound',
} as const;

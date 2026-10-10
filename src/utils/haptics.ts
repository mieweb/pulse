import * as Haptics from 'expo-haptics';

let muted = false;

/**
 * Silences every haptic until called with `false` (the recorder does this while a clip records,
 * where the camera lets haptics through and the microphone would pick them up).
 */
export function muteHaptics(on: boolean) {
  muted = on;
}

/** Runs `fire` unless muted; a rejected call (no Taptic Engine) never throws into UI code. */
function play(fire: () => Promise<void>) {
  if (!muted) void fire().catch(() => {});
}

/**
 * One haptic per committed action, fired with the visual change it confirms. Wrapped so a
 * device without a Taptic Engine (or a rejected call) never throws into UI code.
 *
 * - `tap`: a control changed state (record start/stop, a lens, a selection).
 * - `pickUp` / `drop`: a drag began, or something was dropped onto a target (a clip on the trash).
 * - `success` / `warning` / `error`: an outcome the person was waiting for.
 *
 * The record-start haptic fires before capture begins: once a clip records, haptics are muted.
 */
export const haptics = {
  tap: () => play(() => Haptics.selectionAsync()),
  pickUp: () => play(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  drop: () => play(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  success: () => play(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => play(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => play(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};

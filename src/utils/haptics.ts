import * as Haptics from 'expo-haptics';

/**
 * One haptic per committed action, fired with the visual change it confirms. Wrapped so a
 * device without a Taptic Engine (or a rejected call) never throws into UI code.
 *
 * - `tap`: a control changed state (record start/stop, a lens, a selection).
 * - `pickUp` / `drop`: a drag began, or something was dropped onto a target (a clip on the trash).
 * - `success` / `warning` / `error`: an outcome the person was waiting for.
 *
 * iOS suppresses haptics while the microphone is recording, so the record-start haptic must fire
 * before capture begins.
 */
export const haptics = {
  tap: () => void Haptics.selectionAsync().catch(() => {}),
  pickUp: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}),
  drop: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}),
  success: () =>
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
  warning: () =>
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}),
  error: () =>
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}),
};

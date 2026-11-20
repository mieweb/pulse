/**
 * The recorder's low-disk preflight (C5): a take that runs the phone out of space fails partway,
 * and the library can't save it either. So before a take starts, the recorder checks the free
 * space and, under the threshold, shows "Not enough space" instead of starting. Pure: the free
 * space comes from an injected function (the recorder passes `Paths.availableDiskSpace`).
 */

/**
 * Below this much free space a take doesn't start: about five minutes of the recorder's 1080p
 * H.264 at the ~8 Mbps clips have measured at, with room left for the library's own writes.
 */
export const LOW_DISK_BYTES = 300 * 1024 * 1024;

/** How much space is free, in bytes; null (or anything not a number ≥ 0) when it can't tell. */
export type FreeSpace = () => number | null;

let thresholdOverride: number | null = null;

/**
 * Use `bytes` as the threshold instead of `LOW_DISK_BYTES` (null: back to it). For device checks:
 * a threshold above the phone's free space takes the low-disk path without filling the disk.
 */
export function setLowDiskThreshold(bytes: number | null): void {
  thresholdOverride = bytes != null && Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

/** The global debug builds set, for the owner's device check. */
export const LOW_DISK_DEBUG_HOOK = '__pulseSetLowDiskThreshold';

/**
 * Debug builds only: put `setLowDiskThreshold` on the JS runtime's global, so the device check
 * reaches it without a code change. In React Native DevTools' console on the embedded runtime
 * (or a Hermes CDP evaluate), `__pulseSetLowDiskThreshold(1e15)` takes the low-disk path on the
 * next take, and `__pulseSetLowDiskThreshold(null)` puts the threshold back. Release builds
 * never set it.
 */
export function installLowDiskDebugHook(
  target: object = globalThis,
  dev: boolean = typeof __DEV__ !== 'undefined' && __DEV__,
): void {
  if (dev) (target as Record<string, unknown>)[LOW_DISK_DEBUG_HOOK] = setLowDiskThreshold;
}
installLowDiskDebugHook();

/** The threshold in force. */
export function lowDiskThreshold(): number {
  return thresholdOverride ?? LOW_DISK_BYTES;
}

export type DiskCheck = { ok: true } | { ok: false; freeBytes: number; neededBytes: number };

/**
 * Whether a take may start. When the free space can't be read (the function throws, or gives
 * something that isn't a number ≥ 0) the take starts: a check that can't tell never blocks.
 */
export function checkDiskForRecording(
  freeSpace: FreeSpace,
  threshold: number = lowDiskThreshold(),
): DiskCheck {
  let free: number | null;
  try {
    free = freeSpace();
  } catch {
    return { ok: true };
  }
  if (free == null || !Number.isFinite(free) || free < 0) return { ok: true };
  return free < threshold ? { ok: false, freeBytes: free, neededBytes: threshold } : { ok: true };
}

/** What the recorder says instead of starting. */
export const NOT_ENOUGH_SPACE = {
  title: 'Not enough space',
  message: 'Free up some space on this phone, then record.',
} as const;

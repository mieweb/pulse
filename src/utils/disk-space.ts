import { Paths, type File } from 'expo-file-system';

// Checks that run in native code, so a multi-GB library never streams through JavaScript just to
// be hashed: expo-file-system hashes a file natively (CryptoKit on iOS, MessageDigest on Android)
// and reports the free space on the device.

/** Room left free beyond what an operation writes, so the phone isn't left at zero. */
const MARGIN = 200 * 1024 * 1024;

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

/** Refuse, before writing anything, an operation that would write `bytes` the phone hasn't room for. */
export function ensureFreeSpace(bytes: number): void {
  const free = Paths.availableDiskSpace;
  if (Number.isFinite(free) && free < bytes + MARGIN) {
    throw new Error(
      `This needs about ${gb(bytes + MARGIN)} GB free, and the phone has ${gb(free)} GB. Free up space, then try again.`,
    );
  }
}

/** The file's MD5, hashed natively. */
export function nativeMd5(file: File): string {
  const md5 = file.info({ md5: true }).md5;
  if (!md5) throw new Error(`Couldn’t check ${file.name}.`);
  return md5;
}

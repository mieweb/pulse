import { requireOptionalNativeModule } from 'expo';
import { Directory, File, FileMode, Paths, UploadType } from 'expo-file-system';
import { Platform } from 'react-native';

import type { UploadChunk } from './tus-client';
import {
  describeError,
  describeTransport,
  formatBytes,
  formatRate,
  formatSeconds,
  uploadLog,
  type UploadMetrics,
} from './upload-log';

/** The upload task's `metrics` event — added by our expo-file-system patch, so not in its types. */
type MetricsEvents = {
  addListener(event: 'metrics', listener: (metrics: UploadMetrics) => void): { remove(): void };
};

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const CHUNK_DIR_NAME = 'tus-chunks';
/** The same scratch space's name from when uploads resumed across launches. */
const LEGACY_CHUNK_DIR_NAME = 'tus-resume';

/**
 * Deletes any leftover files under the cache dir's `tus-chunks/` scratch
 * space. `prepareChunkSource`'s temp copy is only cleaned up in a `finally`
 * block, which never runs if the app process is killed outright mid-upload —
 * leaving a duplicate, unencrypted copy of potentially sensitive video content
 * sitting in app cache indefinitely. Call once at app startup, before anything
 * uploads: a kill ends its upload, so nothing here is ever needed after the
 * process that wrote it is gone.
 */
export function cleanupStaleUploadTempFiles(): void {
  for (const name of [CHUNK_DIR_NAME, LEGACY_CHUNK_DIR_NAME]) {
    const dir = new Directory(Paths.cache, name);
    if (!dir.exists) continue;
    try {
      dir.delete();
    } catch {
      // Best-effort — a locked/missing file here just means it'll be retried
      // next launch, not a reason to fail app startup.
    }
  }
}

/** The method this app adds to expo-file-system's native module (see `patches/`). */
type FileSystemNativeModule = { cancelBackgroundUploadTasks?: () => Promise<number> };

/**
 * iOS only: cancels every upload task left in expo-file-system's background
 * `URLSession` by an earlier process. Every PATCH runs in that one session,
 * owned by `nsurlsessiond`, so a crash or iOS memory kill mid-upload leaves a
 * transfer that keeps sending — and a new upload to the same host queues behind
 * it at 0%. A kill ends its upload, so nothing left there is worth keeping.
 * Call once at launch, before anything uploads. Download tasks share the session
 * and are left alone. Resolves how many it cancelled; best-effort (0 when the
 * native method isn't in the build).
 */
export async function cancelOrphanedUploadTasks(): Promise<number> {
  if (Platform.OS !== 'ios') return 0;
  const native = requireOptionalNativeModule<FileSystemNativeModule>('FileSystem');
  try {
    return (await native?.cancelBackgroundUploadTasks?.()) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Bound on each `FileHandle.readBytes` while staging a resume/chunk temp copy.
 * Staging streams the range through this much memory at a time instead of
 * materializing the whole remainder as one buffer — the pre-existing behavior
 * this replaces read `totalBytes - offset` in ONE call, an allocation bounded
 * only by file size (the OOM half of #92).
 */
const STAGING_READ_BYTES = 8 * 1024 * 1024;

/**
 * Stages the bytes for one PATCH — `[offset, offset + chunkBytes)` — as a
 * file the native upload task can point at. The common case (a fresh upload,
 * offset 0, whole file in one PATCH) uploads `source` directly with no copy
 * at all. A retry that resumes mid-file (offset > 0) or an explicitly bounded
 * chunk gets a temp copy, streamed via `FileHandle` in `STAGING_READ_BYTES` reads so memory
 * stays bounded no matter how large the staged range is.
 */
function prepareChunkSource(
  source: File,
  offset: number,
  chunkBytes: number,
  totalBytes: number,
): { file: File; cleanup: () => void } {
  if (offset <= 0 && chunkBytes >= totalBytes) return { file: source, cleanup: () => {} };

  const dir = new Directory(Paths.cache, CHUNK_DIR_NAME);
  dir.create({ intermediates: true, idempotent: true });
  const temp = new File(dir, `${randomId()}.bin`);
  if (temp.exists) temp.delete();
  // FileHandle open-for-writing requires an existing file on iOS
  // (FileHandle(forWritingTo:) does not create) — create it empty first.
  temp.create();

  const reader = source.open(FileMode.ReadOnly);
  const writer = temp.open(FileMode.WriteOnly);
  try {
    reader.offset = offset;
    let remaining = chunkBytes;
    while (remaining > 0) {
      const bytes = reader.readBytes(Math.min(STAGING_READ_BYTES, remaining));
      if (bytes.length === 0) break;
      writer.writeBytes(bytes);
      remaining -= bytes.length;
    }
  } finally {
    writer.close();
    reader.close();
  }
  return {
    file: temp,
    cleanup: () => {
      if (temp.exists) temp.delete();
    },
  };
}

/**
 * Real `UploadChunk` implementation for `tus-client.ts`: PATCHes one bounded
 * chunk. Uses `expo-file-system`'s native upload task (`File.createUploadTask`,
 * `httpMethod: "PATCH"`, `uploadType: BINARY_CONTENT`), which streams bytes
 * through the platform's own URLSession (iOS) / OkHttp (Android) upload
 * APIs — entirely bypassing React Native's `fetch`/`Blob` bridge, which
 * cannot carry a raw byte body here (confirmed: RN's `Blob` constructor
 * explicitly throws on `ArrayBuffer`/`TypedArray` parts, and
 * `expo-file-system`'s own `File.slice()` happens to construct exactly that
 * internally, so even the "use a Blob from slice()" approach doesn't avoid
 * this on React Native).
 *
 * KNOWN LIMITATION: unlike the `fetch`-based POST/HEAD/DELETE in
 * `tus-client.ts`, this PATCH has no `redirect: 'manual'` equivalent —
 * `expo-file-system`'s `UploadOptions` doesn't expose one, and neither
 * `FileSystemUploadTask.swift` nor its Android counterpart intercepts
 * redirects, so a 3xx here falls through to the platform default
 * (`URLSession`/`OkHttp` both follow automatically; Android's OkHttp also
 * resends `Authorization` unchanged to the redirect target). Closing this
 * would require patching `expo-file-system`'s native upload task, not just
 * this module. Accepted as a residual risk: it requires a compromised or
 * MITM'd paired server to trigger, matching the fetch layer before this fix.
 *
 * Logs one line per PATCH: its range, result, speed and, on iOS, which HTTP version carried it
 * (the patched task's `metrics` event) — HTTP/3 behaves very differently from HTTP/2 on some
 * servers (mieweb/opensource-server#480).
 */
export const uploadChunkNative: UploadChunk = async ({
  resourceUrl,
  kind,
  offset,
  chunkBytes,
  totalBytes,
  file,
  headers,
  signal,
  onProgress,
}) => {
  const { file: source, cleanup } = prepareChunkSource(file, offset, chunkBytes, totalBytes);
  let sent = 0;
  const task = source.createUploadTask(resourceUrl, {
    httpMethod: 'PATCH',
    uploadType: UploadType.BINARY_CONTENT,
    sessionType: 'background', //explicit
    headers,
    signal,
    // Native task ticks (URLSession/OkHttp didSendBodyData) — relative to
    // this PATCH's body, which is exactly the contract of the callback.
    onProgress: ({ bytesSent }) => {
      sent = bytesSent;
      onProgress?.(bytesSent);
    },
  });
  let metrics: UploadMetrics | null = null;
  const subscription = (task as unknown as MetricsEvents).addListener('metrics', (m) => {
    metrics = m;
  });
  const range = `${kind} PATCH ${formatBytes(offset)} → ${formatBytes(offset + chunkBytes)}`;
  const started = Date.now();
  // iOS sends the metrics just before the result; give a late event one turn to land.
  const transport = async () => {
    if (!metrics && Platform.OS === 'ios') await new Promise((resolve) => setTimeout(resolve, 0));
    return describeTransport(Platform.OS, metrics);
  };
  try {
    const result = await task.uploadAsync();
    const ms = Date.now() - started;
    uploadLog.info(
      `${range}: HTTP ${result.status} in ${formatSeconds(ms)}, ${formatRate(chunkBytes, ms)}, ` +
        (await transport()),
    );
    return { status: result.status, headers: result.headers };
  } catch (err) {
    const ms = Date.now() - started;
    if (signal?.aborted) {
      // Cancelling a stuck upload is often how one ends, so this line names the protocol too.
      uploadLog.info(
        `${range}: cancelled after ${formatSeconds(ms)} with ${formatBytes(sent)} sent, ` +
          (await transport()),
      );
    } else {
      uploadLog.warn(
        `${range}: failed after ${formatSeconds(ms)} with ${formatBytes(sent)} sent, ` +
          `${await transport()}: ${describeError(err)}`,
      );
    }
    throw err;
  } finally {
    subscription.remove();
    cleanup();
  }
};

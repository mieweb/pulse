import { requireOptionalNativeModule } from 'expo';
import { Directory, File, FileMode, UploadType } from 'expo-file-system';
import { Platform } from 'react-native';

import type { UploadChunk } from './tus-client';
import { describeError, formatBytes, formatRate, formatSeconds, uploadLog } from './upload-log';
import { cacheDir, customDocumentsPath } from '@/utils/storage-root';

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
    const dir = new Directory(cacheDir(), name);
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
 * Cancels the upload tasks an earlier process left behind. Call once at launch, before anything
 * uploads. Best-effort; resolves how many it cancelled.
 *
 * - expo-file-system's background `URLSession` (iOS only; every PATCH of the Pulse app's uploads):
 *   all of its upload tasks go. That session is owned by `nsurlsessiond`, so a crash or iOS memory kill
 *   mid-upload leaves a transfer that keeps sending, and a new upload to the same host queues
 *   behind it at 0%. Nothing can attach to such a task again, so nothing there is worth keeping:
 *   the Pulse app's kill ends its upload, and an embedded job resumes from the server's offset.
 *   Download tasks share the session and are left alone. 0 when the native method isn't in the
 *   build.
 * - PulseKit's own uploads (the embed, with `setBackgroundUploads`; iOS and Android): in this
 *   runtime's namespace only, the tasks of uploads not in `live` go. A task of a live job carries
 *   on, and the job waits for it (`attachRunningUpload`) before HEADing the upload (PLAN §6.3
 *   step 1: reattach, don't cancel). On Android these are the PATCHes PulseKit runs in its upload
 *   service (PulseKitUploads.kt), which a Pulse runtime closing doesn't stop.
 */
export async function cancelOrphanedUploadTasks(live?: readonly string[]): Promise<number> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return 0;
  let cancelled = 0;
  if (Platform.OS === 'ios') {
    const native = requireOptionalNativeModule<FileSystemNativeModule>('FileSystem');
    try {
      cancelled += (await native?.cancelBackgroundUploadTasks?.()) ?? 0;
    } catch {
      // Best effort.
    }
  }
  // Only this runtime's namespace: another account's jobs aren't in `live`.
  const root = customDocumentsPath();
  if (live && root && background && (await background.available())) {
    cancelled += await background.sweep(root, live).catch(() => 0);
  }
  return cancelled;
}

/**
 * Wait for the PulseKit task still running for `url` (one iOS kept going while Pulse wasn't), if
 * there is one: resolves its answer once it ends, or null at once when there is none (or no
 * PulseKit). Call it before HEADing the upload: PulseVault's HEAD takes the upload's lock, which
 * cuts the PATCH that task is sending. `onProgress` gets the upload's offset as it moves.
 */
export async function attachRunningUpload(
  url: string,
  file: File,
  opts: { signal?: AbortSignal; onProgress?: (offset: number) => void } = {},
): Promise<{ status: number; headers: Record<string, string> } | null> {
  if (!background || !(await background.available())) return null;
  return background.attach({ url, path: plainPath(file.uri), ...opts });
}

// PulseKit's background uploader (embed) ---------------------------------------------------------

/** How Pulse JS reaches PulseKit (the embed's BrownfieldMessaging), or a fake in tests. */
export type BackgroundTransport = {
  send(message: Record<string, unknown>): void;
  /** Starts listening; returns the function that stops. */
  listen(onMessage: (message: Record<string, unknown>) => void): () => void;
};

/** How long PulseKit has to answer the first message before uploads fall back to expo's task. */
export const BACKGROUND_HELLO_TIMEOUT_MS = 5_000;

type Waiter = {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  onProgress?: (sent: number) => void;
};

/**
 * The embed's PATCHes run in PulseKit, one PATCH of all the bytes left (O16). On iOS that is its
 * own background `URLSession` (`com.mieweb.pulsekit.upload.<namespace>`, PulseKitBackground.swift):
 * iOS finishes it with no JS running, after Pulse closes, while the host is suspended, killed by
 * the system, or the phone is locked. The session is recreated at the next launch, so a task iOS
 * kept running is reattached rather than duplicated: a PATCH for an upload that already has a
 * running task attaches to it. On Android it is an OkHttp PATCH in PulseKit's dataSync foreground
 * service (PulseKitUploads.kt): it survives Pulse closing and the task being swiped away, but not a
 * killed process, after which `attach` finds nothing and the job resumes from the server's offset.
 * Messages (all over the transport):
 *
 *   JS → PulseKit  {type:'pulse.upload', op:'hello'|'patch'|'attach'|'cancel'|'sweep', id, ...}
 *   PulseKit → JS  {type:'pulse.upload.progress', id, sent}
 *                  {type:'pulse.upload.end', id, ok, status?, headers?, cancelled?, error?}
 */
class BackgroundUploads {
  private readonly waiting = new Map<string, Waiter>();
  private readonly stopListening: () => void;
  private hello: Promise<boolean> | null = null;
  private n = 0;

  constructor(private readonly transport: BackgroundTransport) {
    this.stopListening = transport.listen((message) => this.onMessage(message));
  }

  close(): void {
    this.stopListening();
    for (const waiter of this.waiting.values()) {
      waiter.reject(new Error('PulseKit’s uploader went away.'));
    }
    this.waiting.clear();
  }

  private onMessage(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== 'string') return;
    const waiter = this.waiting.get(id);
    if (!waiter) return;
    if (message.type === 'pulse.upload.progress') {
      if (typeof message.sent === 'number') waiter.onProgress?.(message.sent);
    } else if (message.type === 'pulse.upload.end') {
      this.waiting.delete(id);
      if (message.ok === true) {
        waiter.resolve(message);
        return;
      }
      const error = (message.error ?? {}) as { message?: unknown; canceled?: unknown };
      const failure = new Error(
        typeof error.message === 'string' ? error.message : 'The upload task failed.',
      );
      if (error.canceled === true) failure.name = 'AbortError';
      waiter.reject(failure);
    }
  }

  private request(
    op: string,
    args: Record<string, unknown>,
    onProgress?: (sent: number) => void,
  ): { id: string; done: Promise<Record<string, unknown>> } {
    const id = `bg-${Date.now().toString(36)}-${++this.n}`;
    const done = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, onProgress });
    });
    this.transport.send({ type: 'pulse.upload', op, id, ...args });
    return { id, done };
  }

  /** Whether PulseKit answers (once per runtime): without it, PATCHes use expo's task. */
  available(): Promise<boolean> {
    this.hello ??= new Promise<boolean>((resolve) => {
      const { id, done } = this.request('hello', {});
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        uploadLog.warn('PulseKit’s background uploader didn’t answer; using expo’s upload task');
        resolve(false);
      }, BACKGROUND_HELLO_TIMEOUT_MS);
      done.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
    return this.hello;
  }

  /**
   * Cancel PulseKit's tasks, in the namespace whose documents folder is `root`, of uploads not in
   * `live`; resolves how many went.
   */
  async sweep(root: string, live: readonly string[]): Promise<number> {
    const reply = await this.request('sweep', { root, live: [...live] }).done;
    return typeof reply.cancelled === 'number' ? reply.cancelled : 0;
  }

  /** One PATCH in PulseKit's session (or attached to the one already running for `url`). */
  async patch(params: {
    url: string;
    offset: number;
    length: number;
    path: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
    onProgress?: (sent: number) => void;
  }): Promise<{ status: number; headers: Record<string, string> }> {
    const reply = await this.cancellable('patch', params);
    return answerOf(reply);
  }

  /** Wait for the task running for `url`; null when none runs. */
  async attach(params: {
    url: string;
    path: string;
    signal?: AbortSignal;
    onProgress?: (offset: number) => void;
  }): Promise<{ status: number; headers: Record<string, string> } | null> {
    const reply = await this.cancellable('attach', params);
    return reply.attached === false ? null : answerOf(reply);
  }

  /** A request that `signal` cancels (PulseKit cancels the task when nobody else waits for it). */
  private async cancellable(
    op: string,
    params: { signal?: AbortSignal; onProgress?: (sent: number) => void } & Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { signal, onProgress, ...args } = params;
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const { id, done } = this.request(op, args, onProgress);
    const onAbort = () => this.transport.send({ type: 'pulse.upload', op: 'cancel', id });
    signal?.addEventListener('abort', onAbort);
    try {
      return await done;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function answerOf(reply: Record<string, unknown>): {
  status: number;
  headers: Record<string, string>;
} {
  const headers =
    typeof reply.headers === 'object' && reply.headers !== null
      ? (reply.headers as Record<string, string>)
      : {};
  return { status: typeof reply.status === 'number' ? reply.status : 0, headers };
}

let background: BackgroundUploads | null = null;

/**
 * Run PATCHes in PulseKit's background session from now on (the embed shell passes its
 * BrownfieldMessaging transport), or null for expo-file-system's task again (the Pulse app's
 * default). Waiting PATCHes of a replaced transport fail and are resumed from the server's offset.
 */
export function setBackgroundUploads(transport: BackgroundTransport | null): void {
  background?.close();
  background = transport ? new BackgroundUploads(transport) : null;
}

/** A `file://` URI as the plain path PulseKit opens. */
function plainPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
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

  const dir = new Directory(cacheDir(), CHUNK_DIR_NAME);
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
 * chunk. Uses `expo-file-system`'s native upload task (`File.upload`,
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
 * In the embed, once `setBackgroundUploads` is wired and PulseKit answers, the PATCH runs in
 * PulseKit instead (on iOS its background session, which stages a resumed slice itself; on Android
 * its upload service, which streams the slice from the file), so it finishes with no JS running.
 * The redirect limitation above applies on iOS too; Android's PulseKit PATCH doesn't follow
 * redirects (a 3xx comes back as the PATCH's status).
 *
 * Logs one line per PATCH: its range, result, time and speed.
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
  const range = `${kind} PATCH ${formatBytes(offset)} → ${formatBytes(offset + chunkBytes)}`;
  const started = Date.now();
  let sent = 0;
  const track = (bytesSent: number) => {
    sent = bytesSent;
    onProgress?.(bytesSent);
  };
  const failed = (err: unknown) => {
    const where = `after ${formatSeconds(Date.now() - started)} with ${formatBytes(sent)} sent`;
    if (signal?.aborted) uploadLog.info(`${range}: cancelled ${where}`);
    else uploadLog.warn(`${range}: failed ${where}: ${describeError(err)}`);
    return err;
  };
  const done = (status: number) => {
    const ms = Date.now() - started;
    uploadLog.info(
      `${range}: HTTP ${status} in ${formatSeconds(ms)}, ${formatRate(chunkBytes, ms)}`,
    );
  };

  // The embed: PulseKit's own background session, which needs no JS to finish (O16).
  if (background && (await background.available())) {
    try {
      const result = await background.patch({
        url: resourceUrl,
        offset,
        length: chunkBytes,
        path: plainPath(file.uri),
        headers,
        signal,
        onProgress: track,
      });
      done(result.status);
      return result;
    } catch (err) {
      throw failed(err);
    }
  }

  const { file: source, cleanup } = prepareChunkSource(file, offset, chunkBytes, totalBytes);
  try {
    const result = await source.upload(resourceUrl, {
      httpMethod: 'PATCH',
      uploadType: UploadType.BINARY_CONTENT,
      sessionType: 'background', //explicit
      headers,
      signal,
      // Native task ticks (URLSession/OkHttp didSendBodyData) — relative to
      // this PATCH's body, which is exactly the contract of the callback.
      onProgress: ({ bytesSent }) => track(bytesSent),
    });
    done(result.status);
    return { status: result.status, headers: result.headers };
  } catch (err) {
    throw failed(err);
  } finally {
    cleanup();
  }
};

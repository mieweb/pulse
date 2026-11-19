import { selectAdapter } from './adapters/select';
import { CONTRACT, newCallId, newRequestId, parseReply } from './envelope';
import { errorFromReply, pulseError, toErrorInfo } from './errors';
import { createEmitter } from './events';
import { createHostRequestRouter } from './host-requests';
import type {
  AccountState,
  BridgeEvent,
  CreateClientOptions,
  DraftSummary,
  FileRef,
  FlowResult,
  Json,
  MethodName,
  NamespaceInfo,
  OpenRequest,
  PulseAdapter,
  PulseClient,
  PulseInfo,
  Usage,
} from './types';
import { checkArgs } from './validate';

/** A forwarded call's default deadline, a cold boot of Pulse's runtime included (§3). */
export const DEFAULT_TIMEOUT_MS = 30_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * FileRef.webUrl is '' on the wire (the facade can't know the WebView's scheme); the adapter makes
 * it loadable, with `?v=` from the nearest DraftSummary's `updatedAt` (or the FlowResult's
 * `endedAt`) so a re-exported file at the same path isn't served from the WebView's cache. Copies
 * as it goes: an adapter's own objects (the fake's) are never changed. A `context` is left as is.
 */
function fillWebUrls(value: unknown, toWebUrl: (path: string) => string, stamp?: number): unknown {
  if (Array.isArray(value)) return value.map((v) => fillWebUrls(v, toWebUrl, stamp));
  if (!isObject(value)) return value;
  const own =
    typeof value.updatedAt === 'number'
      ? value.updatedAt
      : typeof value.endedAt === 'number'
        ? value.endedAt
        : stamp;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // A PulseContext is the host's own, returned verbatim (its `data` may hold anything); a copy,
    // as JSON, so the adapter's object still isn't shared.
    out[k] =
      k === 'context' && isObject(v)
        ? (JSON.parse(JSON.stringify(v)) as unknown)
        : fillWebUrls(v, toWebUrl, own);
  }
  const ref = value as Partial<FileRef>;
  if (
    typeof ref.rel === 'string' &&
    typeof ref.path === 'string' &&
    (ref.webUrl === undefined || ref.webUrl === '')
  ) {
    let url = '';
    try {
      url = toWebUrl(ref.path);
    } catch {
      // Leave it empty: a FileRef without a URL beats a failed call.
    }
    if (url) {
      const v = own ?? (typeof ref.bytes === 'number' ? ref.bytes : 0);
      out.webUrl = `${url}${url.includes('?') ? '&' : '?'}v=${v}`;
    }
  }
  return out;
}

/** Freezes a parsed reply all the way down (it's a copy fillWebUrls made, never an adapter's own). */
function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

function asJson(v: unknown): Json {
  return (v ?? {}) as Json;
}

/**
 * A Pulse client over one adapter (native-bridge.md). Every call: args checked (invalid_options),
 * then the facade's `info()` (cached) gates it: no plugin → unavailable, another contract major →
 * contract.unsupported, `supported: false` → unsupported, a method the facade doesn't list →
 * method.unsupported, all without calling native. A transport failure is `unavailable`; a call
 * other than `open` that gets no reply within `timeoutMs` (30 s) is `timeout`.
 */
export function createPulseClient(o: CreateClientOptions = {}): PulseClient {
  const adapter: PulseAdapter = o.adapter ?? selectAdapter();
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const emitter = createEmitter();
  const opens = new Map<string, Promise<FlowResult>>();
  let info: Promise<PulseInfo> | null = null;

  const toWebUrl = (path: string) => adapter.toWebUrl(path);

  async function transport(
    method: string,
    args: Json,
    callId: string,
    timeout: number | null,
  ): Promise<unknown> {
    const sent = Promise.resolve()
      .then(() => adapter.call(method, args, callId))
      .catch((e: unknown) => {
        throw pulseError(
          'unavailable',
          `The Pulse plugin couldn't be reached: ${messageOf(e)}`,
          callId,
        );
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raw =
      timeout === null
        ? await sent
        : await Promise.race([
            sent,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    pulseError(
                      'timeout',
                      `Pulse didn't answer ${method} in ${timeout} ms.`,
                      callId,
                    ),
                  ),
                timeout,
              );
            }),
          ]).finally(() => clearTimeout(timer));
    const reply = parseReply(raw, callId);
    if (!reply) {
      throw pulseError(
        'unavailable',
        `The Pulse plugin answered ${method} with no envelope.`,
        callId,
      );
    }
    if (!reply.ok) throw errorFromReply(reply.error, callId);
    return fillWebUrls(reply.result, toWebUrl);
  }

  async function loadInfo(): Promise<PulseInfo> {
    const callId = newCallId();
    let present = false;
    try {
      present = (await adapter.present()) === true;
    } catch {
      present = false;
    }
    if (!present) throw pulseError('unavailable', 'No Pulse plugin on this page.', callId);
    const raw = await transport('info', {}, callId, timeoutMs);
    const contract = isObject(raw) ? raw.contract : undefined;
    const major = isObject(contract) ? contract.major : undefined;
    if (major !== CONTRACT.major || !isObject(raw) || !Array.isArray(raw.methods)) {
      throw pulseError(
        'contract.unsupported',
        `The Pulse plugin speaks contract major ${String(major)}; this client speaks ${CONTRACT.major}.`,
        callId,
      );
    }
    // Frozen: one cached object goes to every caller, so none of them can change it for the rest.
    return deepFreeze(raw) as unknown as PulseInfo;
  }

  function getInfo(): Promise<PulseInfo> {
    if (!info) {
      const p = loadInfo();
      info = p;
      // A failure isn't cached: the plugin may appear later (deviceready), or a timeout may pass.
      p.catch(() => {
        if (info === p) info = null;
      });
    }
    return info;
  }

  /**
   * After the account changes (setAccount, purge) the facade's `namespace` may have too, so the next
   * getInfo() asks again. A gating read in flight keeps the old answer; its method list can't change.
   */
  function afterAccountChange<T>(p: Promise<T>): Promise<T> {
    return p.then((v) => {
      info = null;
      return v;
    });
  }

  async function call<T>(method: MethodName, args: Json, noTimeout = false): Promise<T> {
    const callId = newCallId();
    const problem = checkArgs(method, args);
    if (problem) throw pulseError('invalid_options', `${method}: ${problem}`, callId);
    let i: PulseInfo;
    try {
      i = await getInfo();
    } catch (e) {
      const { code, message, recoverable } = toErrorInfo(e, callId);
      throw pulseError(code, message, callId, { recoverable });
    }
    if (i.supported !== true) {
      throw pulseError('unsupported', `Pulse doesn't run on this device (${method}).`, callId);
    }
    if (!i.methods.includes(method)) {
      throw pulseError('method.unsupported', `This PulseKit doesn't answer ${method}.`, callId);
    }
    return (await transport(method, args, callId, noTimeout ? null : timeoutMs)) as T;
  }

  const voidCall = (method: MethodName, args: Json): Promise<void> =>
    call(method, args).then(() => undefined);

  const hostRequests = createHostRequestRouter({
    respond: (r) => call('respondHostRequest', asJson(r)),
  });

  function onEvent(e: BridgeEvent): void {
    if (!isObject(e)) return;
    if (e.name === 'hostRequest') {
      hostRequests.handle(e.payload);
    } else if (e.name === 'flowResult') {
      emitter.emit(e.name, fillWebUrls(e.payload, toWebUrl));
    } else {
      emitter.emit(e.name, e.payload);
    }
  }

  try {
    adapter.subscribe(onEvent);
  } catch (e) {
    console.error('[pulse-embed] subscribing to the Pulse plugin failed', e);
  }

  function open(r: OpenRequest): Promise<FlowResult> {
    // The client names the request when the host didn't, so the result, the inbox file and the
    // flowResult event can be matched to this call.
    const given = isObject(r) ? r.requestId : undefined;
    const requestId = typeof given === 'string' ? given : newRequestId();
    const pending = opens.get(requestId);
    if (pending) return pending;
    const p = call<FlowResult>('open', asJson({ ...r, requestId }), true).finally(() => {
      opens.delete(requestId);
    });
    opens.set(requestId, p);
    return p;
  }

  return {
    isAvailable: () =>
      getInfo().then(
        (i) => i.supported === true,
        () => false,
      ),
    getInfo,
    configure: (c) => voidCall('configure', asJson(c)),
    setAccount: (a) => afterAccountChange(call<AccountState>('setAccount', asJson(a))),
    prewarm: () => voidCall('prewarm', {}),

    open,
    record: (context, opts) => open({ ...opts, entry: 'record', context }),
    edit: (draftId, opts) => open({ ...opts, entry: 'edit', draftId }),
    exportDraft: (draftId, opts) => open({ ...opts, entry: 'export', draftId }),
    close: (c) => voidCall('close', asJson(c)),
    isOpen: () => call<boolean>('isOpen', {}),
    pendingResults: () => call<FlowResult[]>('pendingResults', {}),
    acknowledge: (requestId) => voidCall('acknowledge', { requestId }),

    listDrafts: (f) => call<DraftSummary[]>('listDrafts', asJson(f)),
    getDraft: (id) => call<DraftSummary | null>('getDraft', { id }),
    countDrafts: (c) => call<Record<string, number>>('countDrafts', asJson(c)),
    renameDraft: (id, name) => voidCall('renameDraft', { id, name }),
    setDraftContext: (id, context) => voidCall('setDraftContext', asJson({ id, context })),
    deleteDraft: (id) => voidCall('deleteDraft', { id }),
    upload: (id) => call<{ clientKey: string; draftKey: string; sentAt: number }>('upload', { id }),
    cancelUpload: (id) => voidCall('cancelUpload', { id }),
    retireDraft: (id) => voidCall('retireDraft', { id }),
    dismissReceipt: (id) => voidCall('dismissReceipt', { id }),
    resumeOutbox: () => voidCall('resumeOutbox', {}),
    usage: () => call<Usage>('usage', {}),
    listNamespaces: () => call<NamespaceInfo[]>('listNamespaces', {}),
    purge: (p) => afterAccountChange(voidCall('purge', asJson(p))),
    logFile: () => call<FileRef>('logFile', {}),

    setHostServices: (s) => hostRequests.setServices(s),
    on: (event, cb) => emitter.on(event, cb),
  };
}

let page: PulseClient | null = null;

/** The page-wide client, created on first use with the default adapter selection. */
export function getPulse(): PulseClient {
  page ??= createPulseClient();
  return page;
}

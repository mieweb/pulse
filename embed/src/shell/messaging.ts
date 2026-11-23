import type { Json, PulseErrorInfo } from '@mieweb/pulse-embed';

import type { NetworkSource } from '@/core/network';

/**
 * Pulse JS's side of the PulseKit messages (native-bridge.md §8.1), over expo-brownfield's
 * BrownfieldMessaging. Native sends `pulse.cmd {callId, method, args}` and gets one
 * `pulse.reply {callId, ok, result | error}` back; Pulse JS sends `pulse.event {name, payload}`,
 * `pulse.result {requestId}` once a result file is written, `pulse.error {requestId, message}`
 * when the embed root can't start, `pulse.ui` for the container view controller (status bar,
 * whether a take exists), and `pulse.ready {namespace}` once the runtime's command handlers are up
 * (PulseKit holds forwarded calls until then), and `pulse.released {namespace}` once the runtime let
 * go of its library for good (PulseKit sends it nothing more). Native also sends `pulse.respond {hostCallId,
 * result | error}`: the host's answer to a `hostRequest` event (§5).
 *
 * The runtime outlives each presentation, so the channel is made once and listens for the
 * runtime's lifetime; each flow registers the commands it answers while it is mounted.
 */
export type Message = Record<string, unknown>;

/** How messages reach native and come back (expo-brownfield in the app, a fake in tests). */
export interface Transport {
  send(message: Message): void;
  /** Starts listening; returns the function that stops. */
  listen(onMessage: (message: Message) => void): () => void;
}

export type CommandArgs = { readonly [key: string]: Json | undefined };
/** Answers one `pulse.cmd`: its return value is the reply's `result` (null when undefined). */
export type CommandHandler = (args: CommandArgs, callId: string) => unknown;

/** The `pulse.ui` fields (PulseKitPresenter.swift `apply(ui:)`); each sticks until set again. */
export type UiFields = {
  statusBar?: 'light' | 'dark' | 'auto';
  statusBarHidden?: boolean;
  hasTake?: boolean;
  /**
   * A Send is running (Export's merge and the host's confirm): the facade's watchdog for the
   * host's `close` waits for it (PulseKit.swift `armForceClose`).
   */
  sending?: boolean;
};

export interface Channel {
  /** Answer `method` with `handler` until the returned function runs. */
  handle(method: string, handler: CommandHandler): () => void;
  /** Hand every `pulse.respond` to `onRespond` until the returned function runs. */
  onRespond(onRespond: (message: Message) => void): () => void;
  /** The runtime's command handlers are up, for the library of `namespace`. */
  ready(namespace: string): void;
  /** The runtime let go of `namespace`'s library for good: PulseKit starts a fresh one next. */
  released(namespace: string): void;
  event(name: string, payload: Json): void;
  /** The result file for `requestId` is written: native reads it and ends the flow. */
  result(requestId: string): void;
  /** The embed root couldn't start: native ends the flow `failed{runtime.error}`. */
  error(requestId: string, message: string): void;
  ui(fields: UiFields): void;
}

export function createChannel(transport: Transport): Channel {
  const handlers = new Map<string, CommandHandler>();
  const responders = new Set<(message: Message) => void>();
  let listening = false;

  const reply = (callId: string, body: { result: unknown } | { error: PulseErrorInfo }) =>
    transport.send(
      'error' in body
        ? { type: 'pulse.reply', callId, ok: false, error: body.error }
        : { type: 'pulse.reply', callId, ok: true, result: body.result ?? null },
    );

  const fail = (callId: string, code: PulseErrorInfo['code'], message: string) =>
    reply(callId, { error: { code, message, recoverable: false, callId } });

  async function onMessage(message: Message): Promise<void> {
    if (message.type === 'pulse.respond') {
      for (const respond of [...responders]) respond(message);
      return;
    }
    if (message.type !== 'pulse.cmd') return;
    const { callId, method } = message;
    if (typeof callId !== 'string' || callId.length === 0) return; // nothing to reply to
    if (typeof method !== 'string')
      return fail(callId, 'invalid_options', 'pulse.cmd needs a method.');
    const handler = handlers.get(method);
    if (!handler) {
      return fail(callId, 'method.unsupported', `Pulse doesn’t answer “${method}” here.`);
    }
    const args = isObject(message.args) ? (message.args as CommandArgs) : {};
    try {
      reply(callId, { result: await handler(args, callId) });
    } catch (e) {
      const error = errorInfo(e, callId);
      if (error.code === 'unknown') console.warn(`[embed] pulse.cmd ${method} ${callId} failed`, e);
      else console.log(`[embed] pulse.cmd ${method} ${callId}: ${error.code} ${error.message}`);
      reply(callId, { error });
    }
  }

  const listen = () => {
    if (listening) return;
    listening = true;
    transport.listen((message) => void onMessage(message));
  };

  return {
    handle(method, handler) {
      listen();
      handlers.set(method, handler);
      return () => {
        if (handlers.get(method) === handler) handlers.delete(method);
      };
    },
    onRespond(onRespond) {
      listen();
      responders.add(onRespond);
      return () => {
        responders.delete(onRespond);
      };
    },
    ready: (namespace) => transport.send({ type: 'pulse.ready', namespace }),
    released: (namespace) => transport.send({ type: 'pulse.released', namespace }),
    event: (name, payload) => transport.send({ type: 'pulse.event', name, payload }),
    result: (requestId) => transport.send({ type: 'pulse.result', requestId }),
    error: (requestId, message) => transport.send({ type: 'pulse.error', requestId, message }),
    ui: (fields) => transport.send({ type: 'pulse.ui', ...fields }),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The codes Pulse JS's own errors carry that a reply passes on (the library's LibraryError, the
 * host requests' HostRequestError, the commands' CommandError). Anything else, a native module's
 * `ERR_…` say, is `unknown`: its message goes to the log, and the host keys its copy by code.
 */
const REPLY_CODES = new Set<string>([
  'invalid_options',
  'not_found',
  'draft.locked',
  'busy',
  'storage.newer_schema',
  'storage.damaged',
  'storage.full',
  'host_misconfigured',
  'host.unavailable',
  'no_account',
  'destination.gone',
  'upload.refused',
  'upload.too_large',
  'upload.failed',
  'export.failed',
  'credentials.expired',
  'runtime.error',
]);

/** The same codes as PulseKitEnvelope.swift's `isRecoverable` and the client's errors.ts. */
const RECOVERABLE = new Set<string>([
  'busy',
  'timeout',
  'host.unavailable',
  'runtime.error',
  'upload.failed',
]);

/**
 * What a reply says about `e`: its code when it is one of Pulse's (with its `reason` and `draftId`,
 * e.g. `draft.locked` with reason `clock_bound`), else `unknown` with the message.
 */
export function errorInfo(e: unknown, callId: string): PulseErrorInfo {
  const fields = isObject(e) ? e : {};
  const code =
    typeof fields.code === 'string' && REPLY_CODES.has(fields.code) ? fields.code : 'unknown';
  const message = e instanceof Error ? e.message : String(e);
  const info: PulseErrorInfo = {
    code: code as PulseErrorInfo['code'],
    message,
    recoverable: RECOVERABLE.has(code),
    callId,
  };
  if (code !== 'unknown') {
    if (typeof fields.reason === 'string') info.reason = fields.reason;
    if (typeof fields.draftId === 'string') info.draftId = fields.draftId;
  }
  return info;
}

/** The network as PulseKit's NWPathMonitor reports it (initial props `network`, `pulse.cmd network`). */
export type NetworkState = { online: boolean; wifi: boolean; expensive: boolean };

/** `value` as a NetworkState, or null when it isn't one (the facade always sends all three). */
export function parseNetwork(value: unknown): NetworkState | null {
  if (!isObject(value)) return null;
  const { online, wifi, expensive } = value;
  if (typeof online !== 'boolean' || typeof wifi !== 'boolean') return null;
  return { online, wifi, expensive: expensive === true };
}

/**
 * The embed's network source (src/core/network.ts), fed by PulseKit: `initial` is the initial
 * props' `network`, and each `pulse.cmd network` goes to `update`. Until the first value, the
 * source says what the default does (online, Wi-Fi unknown), so nothing is held back on a guess.
 * Subscribers hear only real changes.
 */
export function createNetworkFeed(initial: unknown): {
  source: NetworkSource;
  update(value: unknown): void;
} {
  let state = parseNetwork(initial);
  const listeners = new Set<() => void>();
  return {
    source: {
      isOnline: () => state?.online ?? true,
      isWifi: () => (state ? state.wifi : null),
      subscribe(onChange) {
        listeners.add(onChange);
        return () => {
          listeners.delete(onChange);
        };
      },
    },
    update(value) {
      const next = parseNetwork(value);
      if (!next) return;
      const changed =
        !state ||
        state.online !== next.online ||
        state.wifi !== next.wifi ||
        state.expensive !== next.expensive;
      state = next;
      if (changed) for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * `pulse.ui` that sends each field only when it changes. Make one per presentation: a new
 * container view controller starts from its own defaults, so nothing is assumed about it.
 */
export function createUiSender(send: (fields: UiFields) => void) {
  const last: UiFields = {};
  return (fields: UiFields): void => {
    const changed: UiFields = {};
    let any = false;
    for (const key of Object.keys(fields) as (keyof UiFields)[]) {
      if (fields[key] === undefined || fields[key] === last[key]) continue;
      Object.assign(changed, { [key]: fields[key] });
      Object.assign(last, { [key]: fields[key] });
      any = true;
    }
    if (any) send(changed);
  };
}

export type UiSender = ReturnType<typeof createUiSender>;

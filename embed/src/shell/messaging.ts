import type { Json, PulseErrorInfo } from '@mieweb/pulse-embed';

/**
 * Pulse JS's side of the PulseKit messages (native-bridge.md §8.1), over expo-brownfield's
 * BrownfieldMessaging. Native sends `pulse.cmd {callId, method, args}` and gets one
 * `pulse.reply {callId, ok, result | error}` back; Pulse JS sends `pulse.event {name, payload}`,
 * `pulse.result {requestId}` once a result file is written, `pulse.error {requestId, message}`
 * when the embed root can't start, and `pulse.ui` for the container view controller (status bar,
 * whether a take exists).
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
};

export interface Channel {
  /** Answer `method` with `handler` until the returned function runs. */
  handle(method: string, handler: CommandHandler): () => void;
  event(name: string, payload: Json): void;
  /** The result file for `requestId` is written: native reads it and ends the flow. */
  result(requestId: string): void;
  /** The embed root couldn't start: native ends the flow `failed{runtime.error}`. */
  error(requestId: string, message: string): void;
  ui(fields: UiFields): void;
}

export function createChannel(transport: Transport): Channel {
  const handlers = new Map<string, CommandHandler>();
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
      console.warn(`[embed] pulse.cmd ${method} ${callId} failed`, e);
      fail(callId, 'unknown', e instanceof Error ? e.message : String(e));
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

import { buildRequest, parseEvent, parseReply } from '../envelope';
import type { BridgeReply, PulseAdapter } from '../types';
import { createFanout } from './fanout';
import { fileUrl, invoke, pageGlobals, read, type PageGlobals } from './globals';

/**
 * The Cordova adapter (native-bridge.md §7.2): `cordova.exec` against the `Pulse` service, after
 * `deviceready`. Cordova makes deviceready sticky (a listener added after it fired still runs), so
 * waiting for it is safe at any time.
 */

const SERVICE = 'Pulse';

export interface CordovaAdapterOptions {
  /** How long `present()` waits for deviceready before it answers false. Default 10 s. */
  readyTimeoutMs?: number;
}

type Exec = (
  ok: (v: unknown) => void,
  fail: (e: unknown) => void,
  service: string,
  action: string,
  args: unknown[],
) => void;

/** The adapter, or null when this page isn't a Cordova app. */
export function createCordovaAdapter(
  g: PageGlobals = pageGlobals(),
  o: CordovaAdapterOptions = {},
): PulseAdapter | null {
  const cordova = read(g, 'cordova');
  if ((typeof cordova !== 'object' && typeof cordova !== 'function') || cordova === null) {
    return null;
  }
  const readyTimeoutMs = o.readyTimeoutMs ?? 10_000;
  let deviceReady: Promise<void> | null = null;

  function whenDeviceReady(): Promise<void> {
    deviceReady ??= new Promise<void>((resolve) => {
      invoke(read(g, 'document'), 'addEventListener', ['deviceready', () => resolve(), false], 0);
    });
    return deviceReady;
  }

  function exec(): Exec | null {
    const fn = read(cordova, 'exec');
    return typeof fn === 'function' ? (fn as Exec) : null;
  }

  // The js-module clobbers `PulseKit`; `cordova.plugins.Pulse` covers a plugin that registers there.
  function pluginPresent(): boolean {
    return exec() !== null && (!!read(g, 'PulseKit') || !!read(read(cordova, 'plugins'), 'Pulse'));
  }

  async function ready(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), readyTimeoutMs);
    });
    const fired = await Promise.race([whenDeviceReady().then(() => true as const), timedOut]);
    clearTimeout(timer);
    return fired && pluginPresent();
  }

  const subscribe = createFanout({
    // One keepCallback subscription for the page's life; Cordova has no unsubscribe, so the
    // fan-out keeps flowResult and hostRequest for the next subscriber instead.
    retain: true,
    start(emit) {
      void whenDeviceReady().then(() => {
        const run = exec();
        if (!run || !pluginPresent()) return;
        run(
          (data) => {
            const e = parseEvent(data);
            if (e) emit(e);
          },
          (err) => console.error('[pulse-embed] the Pulse subscription failed', err),
          SERVICE,
          'subscribe',
          [],
        );
      });
    },
  });

  return {
    kind: 'cordova',
    present: ready,
    async call(method, args, callId, options): Promise<BridgeReply> {
      await whenDeviceReady();
      const run = exec();
      if (!run || !pluginPresent()) throw new Error('No Pulse plugin in this Cordova app.');
      const json = JSON.stringify(buildRequest(method, args, callId, options?.timeoutMs));
      const out = await new Promise<unknown>((resolve, reject) => {
        run(resolve, reject, SERVICE, 'call', [json]);
      });
      const reply = parseReply(out, callId);
      if (!reply) throw new Error("The Pulse plugin's answer isn't a reply envelope.");
      return reply;
    },
    subscribe,
    toWebUrl(path) {
      // Meteor's local server first (it serves the WebView), then cordova-ios ≥ 6's scheme handler.
      const meteor = invoke(
        read(g, 'WebAppLocalServer'),
        'localFileSystemUrl',
        [fileUrl(path)],
        null,
      );
      if (typeof meteor === 'string' && meteor !== '') return meteor;
      const wk = invoke(read(g, 'WkWebView'), 'convertFilePath', [path], null);
      if (typeof wk === 'string' && wk !== '') return wk;
      return fileUrl(path);
    },
  };
}

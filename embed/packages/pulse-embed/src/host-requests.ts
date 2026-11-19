import { toHostServiceError } from './errors';
import type { HostRequestMethod, HostResponse, HostServices, Json } from './types';

/**
 * Host requests (native-bridge.md §5): Pulse asks the host for upload targets, tokens and the
 * confirm step over the `hostRequest` event, and the host answers with `respondHostRequest`. This
 * routes each request to the HostServices handler, holds requests that arrive before
 * `setHostServices`, and turns every handler outcome into exactly one response.
 */

interface PendingRequest {
  hostCallId: string;
  method: string;
  args: unknown;
  deadline: number | null;
}

const METHODS: Record<HostRequestMethod, true> = {
  getUploadTarget: true,
  refreshUploadToken: true,
  releaseUploadTarget: true,
  confirmSend: true,
};

// Requests held for a host that hasn't called setHostServices yet. The facade drops a request at
// its deadline (20 s), so a long backlog only happens on a page that never registers services.
const QUEUE_MAX = 64;

export interface HostRequestRouter {
  /** One `hostRequest` event's payload. */
  handle(payload: unknown): void;
  /** Registers (or replaces) the handlers and answers everything queued so far. */
  setServices(s: HostServices): void;
}

export interface HostRequestRouterOptions {
  /** Sends `respondHostRequest`. Failures are reported, not thrown (the facade times out). */
  respond(r: HostResponse): Promise<unknown>;
  now?: () => number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createHostRequestRouter(o: HostRequestRouterOptions): HostRequestRouter {
  const now = o.now ?? Date.now;
  let services: HostServices | null = null;
  const queue: PendingRequest[] = [];

  function send(r: HostResponse): void {
    o.respond(r).catch((e: unknown) => {
      console.error('[pulse-embed] respondHostRequest failed', e);
    });
  }

  async function run(req: PendingRequest, s: HostServices): Promise<void> {
    const { hostCallId, method } = req;
    if (!Object.prototype.hasOwnProperty.call(METHODS, method)) {
      send({ hostCallId, error: { code: 'host.unavailable', message: `Unknown ${method}.` } });
      return;
    }
    const handler = (s as unknown as Record<string, unknown>)[method];
    if (typeof handler !== 'function') {
      if (method === 'releaseUploadTarget') {
        // Optional: the server's sweep covers a host without it (HostServices).
        send({ hostCallId, result: null });
      } else {
        send({
          hostCallId,
          error: { code: 'host.unavailable', message: `The host has no ${method} handler.` },
        });
      }
      return;
    }
    try {
      const result: unknown = await (handler as (a: unknown) => unknown).call(s, req.args);
      send({ hostCallId, result: (result ?? null) as Json });
    } catch (e) {
      send({ hostCallId, error: toHostServiceError(e) });
    }
  }

  function dispatch(req: PendingRequest, s: HostServices): void {
    // Past its deadline the facade has given up on it; asking the host now would only make a
    // server reservation nobody uses.
    if (req.deadline !== null && req.deadline < now()) return;
    void run(req, s);
  }

  return {
    handle(payload) {
      if (!isObject(payload) || typeof payload.hostCallId !== 'string' || !payload.hostCallId) {
        return; // Nothing to answer to.
      }
      const req: PendingRequest = {
        hostCallId: payload.hostCallId,
        method: typeof payload.method === 'string' ? payload.method : '',
        args: payload.args ?? {},
        deadline: typeof payload.deadline === 'number' ? payload.deadline : null,
      };
      if (services) {
        dispatch(req, services);
        return;
      }
      queue.push(req);
      if (queue.length > QUEUE_MAX) queue.shift();
    },
    setServices(s) {
      services = s;
      for (const req of queue.splice(0)) dispatch(req, s);
    },
  };
}

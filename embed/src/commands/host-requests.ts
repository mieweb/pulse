import type { Json } from '@mieweb/pulse-embed';

import type { HostRequestPayload } from '@/features/upload/core/host-services';

import type { Channel, Message } from '../shell/messaging';

/** host-services.ts's three ends of the host-request channel (fakes in tests). */
export type HostRequestPort = {
  setHostRequestSink(sink: ((payload: HostRequestPayload) => void) | null): void;
  respondToHostRequest(message: { hostCallId?: unknown; result?: unknown; error?: unknown }): void;
  hostRequestTimedOut(hostCallId: string): void;
};

/**
 * Pulse's host requests over PulseKit (native-bridge.md §5, E2): each request leaves as a
 * `hostRequest` event, which PulseKit keeps for the host (retained while no subscriber is
 * attached) until its 20 s deadline; the host's `respondHostRequest` comes back as `pulse.respond`;
 * and a request PulseKit dropped at its deadline comes back as `pulse.cmd hostTimeout`. Returns the
 * disconnect, which fails whatever is still waiting (unanswered).
 */
export function connectHostRequests(
  channel: Pick<Channel, 'event' | 'onRespond' | 'handle'>,
  port: HostRequestPort,
): () => void {
  port.setHostRequestSink((payload) => channel.event('hostRequest', payload as unknown as Json));
  const stopResponding = channel.onRespond((message: Message) =>
    port.respondToHostRequest(message),
  );
  const stopTimeouts = channel.handle('hostTimeout', (args) => {
    if (typeof args.hostCallId === 'string') port.hostRequestTimedOut(args.hostCallId);
    return null;
  });
  return () => {
    stopResponding();
    stopTimeouts();
    port.setHostRequestSink(null);
  };
}

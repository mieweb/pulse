import * as Brownfield from 'expo-brownfield';

import { createChannel, type Channel } from './messaging';

let channel: Channel | null = null;

/** The runtime's channel to PulseKit, made on first use. */
export function embedChannel(): Channel {
  if (channel) return channel;
  channel = createChannel({
    send: (message) => Brownfield.sendMessage(message),
    listen: (onMessage) => {
      const subscription = Brownfield.addMessageListener(onMessage);
      return () => subscription.remove();
    },
  });
  return channel;
}

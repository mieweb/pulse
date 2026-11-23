import type { BackgroundTransport } from '@/features/upload/core/native-chunk-upload';

/** The part of expo-brownfield's messaging the transport uses (a fake in tests). */
export type Messaging = {
  sendMessage(message: Record<string, unknown>): void;
  addMessageListener(listener: (message: Record<string, unknown>) => void): { remove(): void };
};

/** The messages PulseKit's uploader answers with (PulseKitBackground.swift). */
const UPLOAD_REPLIES = new Set(['pulse.upload.progress', 'pulse.upload.end']);

/**
 * The transport `setBackgroundUploads` takes in the embed (O16): Pulse JS's `pulse.upload` ops
 * (hello, patch, attach, cancel, sweep) go to PulseKit over BrownfieldMessaging, and only its
 * `pulse.upload.progress` / `pulse.upload.end` answers come back. With it, each PATCH runs in
 * PulseKit's background session `com.mieweb.pulsekit.upload.<namespace>` and finishes with no
 * JavaScript running; without it, uploads fall back to expo-file-system's task.
 */
export function brownfieldUploadTransport(messaging: Messaging): BackgroundTransport {
  return {
    send: (message) => messaging.sendMessage(message),
    listen(onMessage) {
      const subscription = messaging.addMessageListener((message) => {
        if (UPLOAD_REPLIES.has(message.type as string)) onMessage(message);
      });
      return () => subscription.remove();
    },
  };
}

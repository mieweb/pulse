import { router } from 'expo-router';

import { OnDeviceAiSheet } from '@/features/transcription/on-device-ai-sheet';

const dismiss = () => router.back();

/** The on-device AI sheet: pick or remove the captions model. */
export default function OnDeviceAiRoute() {
  return <OnDeviceAiSheet onDismiss={dismiss} />;
}

import { useEffect, useRef } from 'react';
import { Linking } from 'react-native';
import { useCameraPermission, useMicrophonePermission } from 'react-native-vision-camera';

import { micOffer, recorderAllowed } from './mic-denied';

/**
 * Camera and microphone access for the recorder. `micOptional` (embedded, PLAN-final §5.3): a
 * refused microphone doesn't block the recorder; it records without sound and `micOffer` says
 * what to offer instead. Without it (the Pulse app), both are needed, as before.
 */
export function useRecorderPermissions({ micOptional = false }: { micOptional?: boolean } = {}) {
  const cam = useCameraPermission();
  const mic = useMicrophonePermission();
  const askedOnce = useRef(false);

  // VisionCamera reads permission status synchronously, so the gate is always "ready".
  const ready = true;
  const granted = recorderAllowed(cam.status, mic.status, micOptional);
  const bothGranted = cam.hasPermission && mic.hasPermission;
  // Blocked = previously denied (or restricted) and can no longer be asked in-app — the user
  // must grant it from system Settings. `canRequestPermission` is true only while undetermined.
  // An optional microphone never blocks: the recorder runs without it.
  const blocked =
    (!cam.hasPermission && !cam.canRequestPermission) ||
    (!micOptional && !mic.hasPermission && !mic.canRequestPermission);

  // Ask for camera + mic the moment the recorder opens, once.
  useEffect(() => {
    if (askedOnce.current || bothGranted) return;
    askedOnce.current = true;
    void (async () => {
      if (cam.canRequestPermission) await cam.requestPermission();
      if (mic.canRequestPermission) await mic.requestPermission();
    })();
  }, [cam, mic, bothGranted]);

  function request() {
    if (blocked) {
      void Linking.openSettings();
    } else {
      void cam.requestPermission();
      void mic.requestPermission();
    }
  }

  return {
    ready,
    granted,
    blocked,
    request,
    /** What to offer for a refused microphone (only when it's optional). */
    micOffer: micOptional ? micOffer(cam.status, mic.status) : null,
    /** The microphone is allowed. */
    micGranted: mic.hasPermission,
    openSettings: () => void Linking.openSettings(),
  };
}

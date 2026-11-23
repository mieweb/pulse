import { useSyncExternalStore } from 'react';

import type { ScreenCaptureState, ScreenCapturePort } from './contract';

const IDLE: ScreenCaptureState = {
  phase: 'idle',
  began: null,
  draftId: null,
  importing: false,
  progress: null,
  starting: false,
};
const idle = () => IDLE;
const never = () => () => {};

/** The screen take's live state, or always idle without screen recording (the embed). */
export function useScreenTake(port: ScreenCapturePort | undefined): ScreenCaptureState {
  return useSyncExternalStore(port?.subscribe ?? never, port?.getState ?? idle);
}

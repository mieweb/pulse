import { useRef } from 'react';

import { PrimaryButton } from '@/components/primary-button';
import { StateMessage } from '@/components/state-message';

import { RecoveryScreen } from './screen';
import type { FatalStorage, LibraryProblem } from './types';

const COPY: Record<
  LibraryProblem,
  { code: FatalStorage['code']; message: string; screen: string; reset: boolean }
> = {
  damaged: {
    code: 'storage.damaged',
    message: 'Pulse’s library on this phone couldn’t be opened.',
    screen:
      'Pulse’s data on this phone is damaged. If the phone is nearly full, free up some space and open Pulse again first. Resetting deletes the videos Pulse keeps on this phone for this account.',
    reset: true,
  },
  full: {
    code: 'storage.full',
    message: 'This phone is out of space.',
    screen:
      'This phone is out of space. Free up some space, then open Pulse again. Your videos are still on this phone.',
    reset: false,
  },
  migration: {
    code: 'storage.damaged',
    message: 'Pulse couldn’t update its library on this phone.',
    screen:
      'Pulse couldn’t update its data on this phone. Close it and open Pulse again. Your videos are still on this phone.',
    reset: false,
  },
};

/**
 * The embed's screen for a library Pulse can't show (B6). Nothing here reloads: a reload would
 * restart the host app's runtime. Every action ends the flow `failed` through `onFatalStorage`
 * (`storage.full` when freeing space fixes it, else `storage.damaged`). Only a damaged library
 * offers "Reset", which also asks the shell to reset this account's Pulse data on this phone once
 * the runtime has let go of the library: a full disk or a failed migration never deletes videos.
 * It is reported once: a second tap while the shell is closing does nothing.
 */
export function EmbeddedRecovery({
  problem,
  onFatalStorage,
}: {
  problem: LibraryProblem;
  onFatalStorage: (fatal: FatalStorage) => void;
}) {
  const reported = useRef(false);
  const copy = COPY[problem];
  const report = (reset: boolean) => {
    if (reported.current) return;
    reported.current = true;
    onFatalStorage({ code: copy.code, message: copy.message, reset });
  };

  return (
    <RecoveryScreen>
      <StateMessage
        icon="exclamationmark.triangle.fill"
        tone="accent"
        title="Couldn’t open Pulse"
        message={copy.screen}>
        {copy.reset ? (
          <PrimaryButton label="Reset Pulse data for this account" onPress={() => report(true)} />
        ) : null}
        <PrimaryButton
          label="Close"
          variant={copy.reset ? 'card' : 'filled'}
          onPress={() => report(false)}
        />
      </StateMessage>
    </RecoveryScreen>
  );
}

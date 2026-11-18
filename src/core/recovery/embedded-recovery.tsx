import { useRef } from 'react';

import { PrimaryButton } from '@/components/primary-button';
import { StateMessage } from '@/components/state-message';

import { RecoveryScreen } from './screen';
import type { FatalStorage } from './types';

const MESSAGE = 'Pulse’s library on this phone couldn’t be opened.';

/**
 * The embed's screen for a library that failed its check and couldn't be recovered (B6). Nothing
 * here reloads: a reload would restart the host app's runtime. Either action ends the flow
 * `failed{storage.damaged}` through `onFatalStorage`; "Reset" also asks the shell to reset this
 * account's Pulse data on this phone once the runtime has let go of the library. It is reported
 * once: a second tap while the shell is closing does nothing.
 */
export function EmbeddedRecovery({
  onFatalStorage,
}: {
  onFatalStorage: (fatal: FatalStorage) => void;
}) {
  const reported = useRef(false);
  const report = (reset: boolean) => {
    if (reported.current) return;
    reported.current = true;
    onFatalStorage({ code: 'storage.damaged', message: MESSAGE, reset });
  };

  return (
    <RecoveryScreen>
      <StateMessage
        icon="exclamationmark.triangle.fill"
        tone="accent"
        title="Couldn’t open Pulse"
        message="Pulse’s data on this phone is damaged. Resetting it deletes the videos Pulse keeps on this phone for this account.">
        <PrimaryButton label="Reset Pulse data for this account" onPress={() => report(true)} />
        <PrimaryButton label="Close" variant="card" onPress={() => report(false)} />
      </StateMessage>
    </RecoveryScreen>
  );
}

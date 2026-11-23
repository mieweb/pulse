import { useRef } from 'react';

import { PrimaryButton } from '@/components/primary-button';
import { StateMessage } from '@/components/state-message';

import { embeddedRecoveryCopy } from './embedded-copy';
import { RecoveryScreen } from './screen';
import type { FatalStorage, LibraryProblem } from './types';

/**
 * The embed's screen for a library Pulse can't show (B6). Nothing here reloads: a reload would
 * restart the host app's runtime. Its one action, Close, ends the flow `failed` through
 * `onFatalStorage` (`storage.full` when freeing space fixes it, else `storage.damaged`). It offers
 * no reset: nothing can reset the library safely yet, so none is promised. It is reported once: a
 * second tap while the shell is closing does nothing.
 */
export function EmbeddedRecovery({
  problem,
  onFatalStorage,
}: {
  problem: LibraryProblem;
  onFatalStorage: (fatal: FatalStorage) => void;
}) {
  const reported = useRef(false);
  const copy = embeddedRecoveryCopy(problem);
  const report = () => {
    if (reported.current) return;
    reported.current = true;
    onFatalStorage({ code: copy.code, message: copy.message });
  };

  return (
    <RecoveryScreen>
      <StateMessage
        icon="exclamationmark.triangle.fill"
        tone="accent"
        title="Couldn’t open Pulse"
        message={copy.screen}>
        <PrimaryButton label="Close" onPress={report} />
      </StateMessage>
    </RecoveryScreen>
  );
}

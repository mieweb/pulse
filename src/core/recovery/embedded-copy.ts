import type { FatalStorage, LibraryProblem } from './types';

/** What the embed's recovery screen says for a problem, and the error the flow ends with. */
export type EmbeddedRecoveryCopy = {
  code: FatalStorage['code'];
  /** For the host's log (`error.message`). */
  message: string;
  /** For the person, on the screen. */
  screen: string;
};

// No reset here: nothing can delete a damaged library safely yet (the runtime still holds it), so
// the screen neither offers one nor says what one would delete.
const COPY: Record<LibraryProblem, EmbeddedRecoveryCopy> = {
  damaged: {
    code: 'storage.damaged',
    message: 'Pulse’s library on this phone couldn’t be opened.',
    screen:
      'Pulse’s data on this phone is damaged. If the phone is nearly full, free up some space, then open Pulse again.',
  },
  full: {
    code: 'storage.full',
    message: 'This phone is out of space.',
    screen:
      'This phone is out of space. Free up some space, then open Pulse again. Your videos are still on this phone.',
  },
  migration: {
    code: 'storage.damaged',
    message: 'Pulse couldn’t update its library on this phone.',
    screen:
      'Pulse couldn’t update its data on this phone. Close it and open Pulse again. Your videos are still on this phone.',
  },
};

/** The embed's recovery copy for `problem` (B6). */
export function embeddedRecoveryCopy(problem: LibraryProblem): EmbeddedRecoveryCopy {
  return COPY[problem];
}

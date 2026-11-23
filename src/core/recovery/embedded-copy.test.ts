import { describe, expect, it } from '@jest/globals';

import { embeddedRecoveryCopy } from './embedded-copy';
import type { LibraryProblem } from './types';

const PROBLEMS: LibraryProblem[] = ['damaged', 'full', 'migration'];

describe('embeddedRecoveryCopy', () => {
  it('ends a full disk with storage.full and anything else with storage.damaged', () => {
    expect(PROBLEMS.map((p) => embeddedRecoveryCopy(p).code)).toEqual([
      'storage.damaged',
      'storage.full',
      'storage.damaged',
    ]);
  });

  // Nothing resets the library yet: the screen offers no reset and says nothing about one.
  it.each(PROBLEMS)('offers no reset for a %s library', (problem) => {
    const copy = embeddedRecoveryCopy(problem);
    expect(Object.keys(copy).sort()).toEqual(['code', 'message', 'screen']);
    expect(`${copy.screen} ${copy.message}`).not.toMatch(/reset|delet/i);
  });

  it('a damaged library still says what the person can try', () => {
    expect(embeddedRecoveryCopy('damaged').screen).toMatch(/free up some space/);
  });
});

import { describe, expect, it } from '@jest/globals';

import { libraryProblem } from './problem';

describe('libraryProblem', () => {
  it('a library that failed its check is damaged, whatever the migration said', () => {
    expect(libraryProblem(true, null)).toBe('damaged');
    expect(libraryProblem(true, new Error('database or disk is full'))).toBe('damaged');
  });

  it('a migration that ran out of space is full', () => {
    expect(libraryProblem(false, new Error('Error code 13: database or disk is full'))).toBe(
      'full',
    );
    expect(libraryProblem(false, new Error('SQLITE_FULL'))).toBe('full');
    expect(libraryProblem(false, { code: 'ENOSPC', message: 'write failed' })).toBe('full');
    expect(libraryProblem(false, { code: 13, message: 'step failed' })).toBe('full');
    expect(libraryProblem(false, 'No space left on device')).toBe('full');
  });

  it('looks through a wrapped cause', () => {
    const wrapped = new Error('migration 0007 failed', {
      cause: new Error('database or disk is full'),
    });
    expect(libraryProblem(false, wrapped)).toBe('full');
  });

  it('any other migration error is a migration problem, not damage', () => {
    expect(libraryProblem(false, new Error('no such column: drafts.place'))).toBe('migration');
    expect(libraryProblem(false, { code: 1 })).toBe('migration');
    expect(libraryProblem(false, undefined)).toBe('migration');
  });
});

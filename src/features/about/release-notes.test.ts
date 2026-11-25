import { expect, it } from '@jest/globals';

import { readReleaseNotes, releaseDateLabel } from './release-notes';

const current = { version: '2.7.0', date: '2026-11-24', notes: ['Split clips at the playhead'] };
const history = [{ version: '2.6.0', date: '2026-11-20', notes: ['Edit captions'] }];

it('reads bundled current and historical notes without Git or a network request', () => {
  expect(
    readReleaseNotes({ version: '2.7.0', extra: { releaseNotes: { current, history } } }),
  ).toEqual({ current, history });
});

it('does not present stale notes as the installed version', () => {
  expect(
    readReleaseNotes({ version: '2.8.0', extra: { releaseNotes: { current, history } } }),
  ).toEqual({ current: null, history });
  expect(readReleaseNotes(null)).toEqual({ current: null, history: [] });
});

it('formats a release calendar date without shifting it to the previous day', () => {
  expect(releaseDateLabel('2026-11-24')).toBe(
    new Date('2026-11-24T00:00:00Z').toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }),
  );
  expect(releaseDateLabel('2026-02-30')).toBeNull();
  expect(releaseDateLabel('bad date')).toBeNull();
  expect(releaseDateLabel(null)).toBeNull();
});

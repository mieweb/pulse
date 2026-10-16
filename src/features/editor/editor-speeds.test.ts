import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/db/settings', () => ({ getSetting: jest.fn(), setSetting: jest.fn() }));

/* eslint-disable import/first -- the mock above must be registered before this loads */
import { EDITOR_SPEEDS, speedMenu } from './editor-speeds';
/* eslint-enable import/first */

describe('speedMenu', () => {
  it('is the standard list when there are no custom speeds', () => {
    expect(speedMenu([])).toEqual([...EDITOR_SPEEDS]);
  });

  it('slots custom speeds into order without duplicating standard ones', () => {
    expect(speedMenu([1.35, 1.25, 3])).toEqual([0.5, 1, 1.1, 1.2, 1.25, 1.3, 1.35, 1.5, 2, 3]);
  });
});

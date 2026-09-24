import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/db/settings', () => ({ getSetting: jest.fn(), setSetting: jest.fn() }));

/* eslint-disable import/first -- the mock above must be registered before this loads */
import { EDITOR_SPEEDS, editStateSpeed, speedMenu, withCustomSpeed } from './editor-speeds';
/* eslint-enable import/first */

describe('speedMenu', () => {
  it('is the standard list when there are no custom speeds', () => {
    expect(speedMenu([])).toEqual([...EDITOR_SPEEDS]);
  });

  it('slots custom speeds into order without duplicating standard ones', () => {
    expect(speedMenu([1.35, 1.25, 3])).toEqual([0.5, 1, 1.1, 1.2, 1.25, 1.3, 1.35, 1.5, 2, 3]);
  });
});

describe('withCustomSpeed', () => {
  it('ignores standard speeds and missing values, keeping the same list', () => {
    const custom = [1.35];
    expect(withCustomSpeed(custom, 1.25)).toBe(custom);
    expect(withCustomSpeed(custom, null)).toBe(custom);
    expect(withCustomSpeed(custom, 1.35)).toBe(custom);
  });

  it('puts the newest custom pick first, without duplicates, capped at three', () => {
    expect(withCustomSpeed([1.35, 1.7, 2.5], 1.7)).toEqual([1.7, 1.35, 2.5]);
    expect(withCustomSpeed([1.35, 1.7, 2.5], 1.15)).toEqual([1.15, 1.35, 1.7]);
  });

  it('rejects speeds the editor cannot export', () => {
    expect(withCustomSpeed([], 5)).toEqual([]);
    expect(withCustomSpeed([], 0.1)).toEqual([]);
  });
});

describe('editStateSpeed', () => {
  it('reads the speed from an editor state', () => {
    expect(editStateSpeed('{"v":1,"speed":1.35}')).toBe(1.35);
  });

  it('is null for no state, malformed JSON or a missing / out-of-range speed', () => {
    expect(editStateSpeed(null)).toBeNull();
    expect(editStateSpeed('not json')).toBeNull();
    expect(editStateSpeed('{"v":1}')).toBeNull();
    expect(editStateSpeed('{"speed":9}')).toBeNull();
  });
});

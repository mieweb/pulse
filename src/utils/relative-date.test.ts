import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getCalendars } from 'expo-localization';

import { formatRelativeDate } from './relative-date';

jest.mock('expo-localization', () => ({ getCalendars: jest.fn() }));

const mockGetCalendars = getCalendars as jest.MockedFunction<typeof getCalendars>;

/** The device zone `getCalendars()` reports (`null` = none, so the runtime's zone is used). */
function deviceZone(timeZone: string | null) {
  mockGetCalendars.mockReturnValue([
    { calendar: null, timeZone, uses24hourClock: false, firstWeekday: null },
  ]);
}

const at = (iso: string) => Date.parse(iso);

// ICU puts a narrow no-break space before AM/PM; compare with plain spaces.
const label = (ms: number, now: number) => formatRelativeDate(ms, now).replace(/\s/g, ' ');

// Noon EDT on Friday 2 Oct 2026.
const NOON_EDT = at('2026-10-02T16:00:00Z');

beforeEach(() => deviceZone('America/New_York'));

describe('formatRelativeDate: never a time that has not happened', () => {
  it('reads "Just now" within the last minute', () => {
    expect(label(NOON_EDT - 30_000, NOON_EDT)).toBe('Just now');
    expect(label(NOON_EDT - 59_999, NOON_EDT)).toBe('Just now');
  });

  it('shows the time from one minute ago', () => {
    expect(label(NOON_EDT - 60_000, NOON_EDT)).toBe('Today, 11:59 AM');
  });

  it('reads "Just now" for a stamp ahead of now, however far', () => {
    expect(label(NOON_EDT + 1_000, NOON_EDT)).toBe('Just now');
    expect(label(NOON_EDT + 4 * 3_600_000, NOON_EDT)).toBe('Just now');
    expect(label(NOON_EDT + 3 * 86_400_000, NOON_EDT)).toBe('Just now');
  });
});

describe('formatRelativeDate: labels by calendar day', () => {
  it('names the day for each age', () => {
    expect(label(at('2026-10-02T13:14:00Z'), NOON_EDT)).toBe('Today, 9:14 AM');
    expect(label(at('2026-10-01T20:14:00Z'), NOON_EDT)).toBe('Yesterday');
    expect(label(at('2026-09-29T16:00:00Z'), NOON_EDT)).toBe('Tuesday');
    expect(label(at('2026-09-26T16:00:00Z'), NOON_EDT)).toBe('Saturday');
    expect(label(at('2026-09-25T16:00:00Z'), NOON_EDT)).toBe('Sep 25');
  });

  it('adds the year only when it is not this year', () => {
    expect(label(at('2026-01-05T16:00:00Z'), NOON_EDT)).toBe('Jan 5');
    expect(label(at('2025-08-28T16:00:00Z'), NOON_EDT)).toBe('Aug 28, 2025');
    // Across New Year: 13 days back is last year.
    const jan2 = at('2027-01-02T17:00:00Z');
    expect(label(at('2026-12-20T17:00:00Z'), jan2)).toBe('Dec 20, 2026');
  });

  it('rolls "Today" over at midnight', () => {
    const edit = at('2026-10-02T20:14:00Z'); // 4:14 PM EDT
    expect(label(edit, at('2026-10-03T03:59:00Z'))).toBe('Today, 4:14 PM'); // 11:59 PM
    expect(label(edit, at('2026-10-03T04:01:00Z'))).toBe('Yesterday'); // 12:01 AM
  });
});

describe('formatRelativeDate: device time zone', () => {
  it('formats in the zone the device reports, not the runtime zone', () => {
    // The same two instants, on a phone in New York and one in Tokyo.
    const edit = at('2026-10-02T13:14:00Z');
    deviceZone('America/New_York');
    expect(label(edit, NOON_EDT)).toBe('Today, 9:14 AM');
    deviceZone('Asia/Tokyo');
    expect(label(edit, NOON_EDT)).toBe('Yesterday'); // 10:14 PM on the 2nd; now 1 AM on the 3rd
    deviceZone('Asia/Kolkata');
    expect(label(edit, NOON_EDT)).toBe('Today, 6:44 PM');
  });

  it('counts a day with no local midnight as one day (Santiago, DST at 00:00)', () => {
    deviceZone('America/Santiago');
    // 6 Sep 2026: clocks jump from 23:59 (UTC−4) to 01:00 (UTC−3).
    const now = at('2026-09-06T04:30:00Z'); // 1:30 AM on the 6th
    expect(label(at('2026-09-06T04:05:00Z'), now)).toBe('Today, 1:05 AM');
    expect(label(at('2026-09-06T03:30:00Z'), now)).toBe('Yesterday'); // 11:30 PM on the 5th
  });

  it('counts a 25-hour day as one day (New York, DST ends)', () => {
    // 1 Nov 2026 has 25 hours; 25 h 20 min back is still yesterday.
    const now = at('2026-11-02T05:30:00Z'); // 12:30 AM EST on the 2nd
    expect(label(at('2026-11-01T04:10:00Z'), now)).toBe('Yesterday'); // 12:10 AM EDT on the 1st
    expect(label(at('2026-11-01T03:50:00Z'), now)).toBe('Saturday'); // 11:50 PM on 31 Oct
  });

  it('falls back to the runtime zone when the zone is rejected or unreadable', () => {
    const edit = at('2026-10-02T13:14:00Z');
    deviceZone(null);
    const runtime = label(edit, NOON_EDT);

    deviceZone('Bogus/Zone');
    expect(label(edit, NOON_EDT)).toBe(runtime);

    mockGetCalendars.mockImplementation(() => {
      throw new Error('native module unavailable');
    });
    expect(label(edit, NOON_EDT)).toBe(runtime);
  });
});

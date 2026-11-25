import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { shiftSummaryDate, summaryDateRange, todayDate } from './summary-dates';

let mockZone = 'America/Indiana/Indianapolis';
jest.mock('expo-localization', () => ({ getCalendars: () => [{ timeZone: mockZone }] }));

beforeEach(() => {
  mockZone = 'America/Indiana/Indianapolis';
});

describe('summary calendar dates', () => {
  it('reads today from the native device zone, even when the runtime has another zone', () => {
    const lateUtc = Date.parse('2026-11-26T02:30:00Z');
    expect(todayDate(lateUtc)).toBe('2026-11-25');
    mockZone = 'Asia/Tokyo';
    expect(todayDate(lateUtc)).toBe('2026-11-26');
  });

  it('includes the entire Through day and uses exclusive next midnight', () => {
    expect(summaryDateRange('2026-11-24', '2026-11-25')).toEqual({
      startAt: Date.parse('2026-11-24T05:00:00Z'),
      endAt: Date.parse('2026-11-26T05:00:00Z'),
    });
  });

  it('has a 23-hour spring-forward day and a 25-hour fall-back day', () => {
    const spring = summaryDateRange('2026-03-08', '2026-03-08')!;
    expect(spring).toEqual({
      startAt: Date.parse('2026-03-08T05:00:00Z'),
      endAt: Date.parse('2026-03-09T04:00:00Z'),
    });
    expect(spring.endAt - spring.startAt).toBe(23 * 3_600_000);
    const fall = summaryDateRange('2026-11-01', '2026-11-01')!;
    expect(fall.endAt - fall.startAt).toBe(25 * 3_600_000);
  });

  it('supports leap days and rolls calendar shortcuts across month and year boundaries', () => {
    expect(summaryDateRange('2024-02-29', '2024-02-29')).not.toBeNull();
    expect(shiftSummaryDate('2024-03-01', -1)).toBe('2024-02-29');
    expect(shiftSummaryDate('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('rejects impossible or reversed dates instead of normalizing them silently', () => {
    for (const [start, end] of [
      ['2026-02-29', '2026-03-01'],
      ['2026-04-31', '2026-05-01'],
      ['2026-11-26', '2026-11-25'],
      ['11/25/2026', '2026-11-25'],
      ['2026-00-25', '2026-11-25'],
      ['0000-01-01', '2026-11-25'],
    ]) {
      expect(summaryDateRange(start, end)).toBeNull();
    }
  });

  it('supports offset zones and midnight DST changes', () => {
    mockZone = 'Asia/Kathmandu';
    expect(summaryDateRange('2026-11-25', '2026-11-25')).toEqual({
      startAt: Date.parse('2026-11-24T18:15:00Z'),
      endAt: Date.parse('2026-11-25T18:15:00Z'),
    });
    mockZone = 'America/Santiago';
    const midnightChange = summaryDateRange('2026-09-06', '2026-09-06')!;
    expect(midnightChange.endAt - midnightChange.startAt).toBe(23 * 3_600_000);
  });

  it('rejects a first day skipped entirely by a time-zone change', () => {
    mockZone = 'Pacific/Apia';
    expect(summaryDateRange('2011-12-30', '2011-12-31')).toBeNull();
  });
});

import { getCalendars } from 'expo-localization';

const DAY_MS = 86_400_000;
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const dayBoundaries = new Map<string, number | null>();

/** Read the native zone rather than Hermes' potentially stale cached local zone. */
function deviceZone(): string | undefined {
  try {
    return getCalendars()[0]?.timeZone ?? undefined;
  } catch {
    return undefined;
  }
}

function dayFormatter(zone: string | undefined): Intl.DateTimeFormat {
  const key = zone ?? '';
  let formatter = dayFormatters.get(key);
  if (!formatter) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
    try {
      formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
        ...options,
        timeZone: zone,
      });
    } catch {
      formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', options);
    }
    dayFormatters.set(key, formatter);
  }
  return formatter;
}

function dateInZone(ms: number, zone: string | undefined): string {
  const parts = dayFormatter(zone).formatToParts(ms);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year').padStart(4, '0')}-${value('month')}-${value('day')}`;
}

/** A calendar date represented in UTC only for calendar arithmetic, never as a local instant. */
function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10) === value ? date : null;
}

/** YYYY-MM-DD in the device's current calendar day, independent of Hermes' cached zone. */
export function todayDate(now: number): string {
  return dateInZone(now, deviceZone());
}

/** Add calendar days, without assuming each local day lasts 24 hours. */
export function shiftSummaryDate(value: string, days: number): string {
  const date = parseDate(value);
  if (!date) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The first instant of a day, including zones whose clock changes at midnight. */
function dayStart(value: string, zone: string | undefined): number | null {
  const key = `${zone ?? ''}|${value}`;
  if (dayBoundaries.has(key)) return dayBoundaries.get(key)!;
  const nominal = parseDate(value)!.getTime();
  let low = nominal - 2 * DAY_MS;
  let high = nominal + 2 * DAY_MS;
  // Local calendar dates increase across a day boundary even when midnight is skipped or
  // repeated. Find that boundary, rather than subtracting an offset or adding 24 hours.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (dateInZone(middle, zone) < value) low = middle;
    else high = middle;
  }
  // A whole calendar date can be skipped by a time-zone change (e.g. Samoa in 2011).
  const result = dateInZone(high, zone) === value ? high : null;
  dayBoundaries.set(key, result);
  return result;
}

/** Inclusive From/Through dates → a half-open instant range, or null for invalid dates. */
export function summaryDateRange(
  startDate: string,
  endDate: string,
): { startAt: number; endAt: number } | null {
  if (!parseDate(startDate) || !parseDate(endDate) || startDate > endDate) return null;
  const nextDate = shiftSummaryDate(endDate, 1);
  if (!parseDate(nextDate)) return null;
  const zone = deviceZone();
  const startAt = dayStart(startDate, zone);
  const endAt = dayStart(nextDate, zone);
  return startAt == null || endAt == null ? null : { startAt, endAt };
}

/** Format a selected Gregorian date in the user's locale without shifting its calendar day. */
export function formatSummaryDate(
  value: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const date = parseDate(value);
  return date
    ? new Intl.DateTimeFormat(undefined, {
        ...options,
        calendar: 'gregory',
        timeZone: 'UTC',
      }).format(date)
    : value;
}

import { getCalendars } from 'expo-localization';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The device's IANA time zone, read natively on every call. Hermes keeps its own cached time zone,
 * which can disagree with the phone: one at noon EDT showed a draft edited minutes earlier as
 * "Today, 4:14 PM", the UTC time. Labels pass this zone explicitly instead of trusting the
 * runtime's local time. `undefined` (the runtime's zone) if the native read fails.
 */
function deviceTimeZone(): string | undefined {
  try {
    return getCalendars()[0]?.timeZone ?? undefined;
  } catch {
    return undefined;
  }
}

// Formatters are costly to build (on Android each one goes through JNI) and the list formats
// every card on each tick, so they're cached per zone + options.
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * An `Intl.DateTimeFormat` in `timeZone`, or in the runtime's zone if Hermes rejects the name (it
 * does for some valid zones on iOS) or none was read.
 */
function formatter(
  options: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
  locale?: string,
): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${timeZone ?? ''}|${JSON.stringify(options)}`;
  let format = formatters.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } catch {
      format = new Intl.DateTimeFormat(locale, options);
    }
    formatters.set(key, format);
  }
  return format;
}

/**
 * `date`'s calendar day in `timeZone` as a day count since the epoch, plus its year. Read in
 * en-US (Gregorian, Latin digits) whatever the device locale, so subtracting two days is
 * plain arithmetic.
 */
function calendarDay(date: Date, timeZone: string | undefined): { day: number; year: number } {
  const parts = formatter({ year: 'numeric', month: 'numeric', day: 'numeric' }, timeZone, 'en-US')
    .formatToParts(date)
    .reduce<Record<string, number>>(
      (acc, part) => ({ ...acc, [part.type]: Number(part.value) }),
      {},
    );
  return { day: Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS, year: parts.year };
}

/**
 * Epoch ms → "Just now" / "Today, 2:30 PM" / "Yesterday" / "Monday" / "Mar 4" / "Mar 4, 2025",
 * in the device's time zone, relative to `now` (pass `useNow`'s value so labels refresh).
 *
 * Never names a time that hasn't happened: anything within the last minute, or ahead of `now`
 * (a changed clock, a `.pulse` from a phone whose clock ran ahead, or `now` lagging a tick
 * behind a fresh edit), reads "Just now".
 */
export function formatRelativeDate(ms: number, now: number): string {
  if (ms > now - MINUTE_MS) return 'Just now';

  const timeZone = deviceTimeZone();
  const date = new Date(ms);
  const then = calendarDay(date, timeZone);
  const today = calendarDay(new Date(now), timeZone);
  const dayDiff = today.day - then.day;

  if (dayDiff === 0) {
    return `Today, ${formatter({ hour: 'numeric', minute: '2-digit' }, timeZone).format(date)}`;
  }
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return formatter({ weekday: 'long' }, timeZone).format(date);
  return formatter(
    then.year === today.year
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
    timeZone,
  ).format(date);
}

/**
 * Epoch ms → a full date and time ("Oct 9, 2026, 7:25 PM") in the device's time zone, for labels
 * that name an exact moment (About's build time). Same time-zone handling as above.
 */
export function formatDateTime(ms: number): string {
  return formatter({ dateStyle: 'medium', timeStyle: 'short' }, deviceTimeZone()).format(
    new Date(ms),
  );
}

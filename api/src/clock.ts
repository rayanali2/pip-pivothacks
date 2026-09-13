import type { IsoDate, IsoDateTime, TimeOfDay } from './types';

// All helpers work in the server's local time zone (PIP_TIMEZONE, when set, becomes process TZ).

export interface Clock {
  /** scenario clock used for plan math (may be frozen) */
  now(): Date;
  /** real wall clock, used for record timestamps (created_at) */
  realNow(): Date;
  /** true when now() is frozen */
  readonly pinned: boolean;
  /** 'HH:MM' the clock is frozen at, or null */
  readonly pinnedTime: TimeOfDay | null;
}

export interface ClockOptions {
  /** 'HH:MM', 'real' or null (unset) */
  demoNow: string | null;
  mode: 'mock' | 'live';
}

export const DEFAULT_MOCK_TIME = '13:13';

/** CONTRACT section 2. */
export function createClock(opts: ClockOptions): Clock {
  let pinnedTime: string | null = null;
  if (opts.demoNow !== null && opts.demoNow !== 'real') pinnedTime = opts.demoNow;
  else if (opts.demoNow === null && opts.mode === 'mock') pinnedTime = DEFAULT_MOCK_TIME;

  if (pinnedTime === null) {
    return { now: () => new Date(), realNow: () => new Date(), pinned: false, pinnedTime: null };
  }
  const time = pinnedTime;
  return {
    now: () => atTime(new Date(), time),
    realNow: () => new Date(),
    pinned: true,
    pinnedTime: time,
  };
}

/** Clock frozen at an exact instant (tests, fixtures). */
export function fixedClock(at: Date, realNow?: () => Date): Clock {
  const t = at.getTime();
  return {
    now: () => new Date(t),
    realNow: realNow ?? (() => new Date()),
    pinned: true,
    pinnedTime: hhmm(at),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DDTHH:MM:SS+-HH:MM' in local time. */
export function toIsoLocal(date: Date): IsoDateTime {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** Parses an IsoDateTime (with offset) or a local 'YYYY-MM-DDTHH:MM(:SS)' string. Returns null when invalid. */
export function tryParseIsoLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!m) return null;
  if (m[7] === undefined) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? '0'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value.trim().replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseIsoLocal(value: string): Date {
  const d = tryParseIsoLocal(value);
  if (!d) throw new Error(`invalid datetime: ${value}`);
  return d;
}

/** Snowflake TIMESTAMP_NTZ string 'YYYY-MM-DDTHH:MM:SS' (local wall time) -> IsoDateTime with the local offset. */
export function ntzToIsoLocal(ntz: string): IsoDateTime {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(ntz.trim());
  if (!m) throw new Error(`invalid NTZ timestamp: ${ntz}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? '0'));
  return toIsoLocal(d);
}

/** IsoDateTime/Date -> 'YYYY-MM-DDTHH:MM:SS' local wall time (for Snowflake NTZ binds). */
export function toNtzLocal(date: Date): string {
  return toIsoLocal(date).slice(0, 19);
}

/** '2:00 PM' */
export function formatTime(date: Date): string {
  const h = date.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(date.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

/** '2:00' (no AM/PM) */
export function formatTimeShort(date: Date): string {
  const h = date.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(date.getMinutes())}`;
}

/** 'HH:MM' 24h */
export function hhmm(date: Date): TimeOfDay {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function parseTimeOfDay(value: string): { h: number; m: number } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

/** Same local date as `date`, at 'HH:MM' (seconds 0). */
export function atTime(date: Date, time: TimeOfDay): Date {
  const t = parseTimeOfDay(time);
  if (!t) throw new Error(`invalid time of day: ${time}`);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), t.h, t.m, 0, 0);
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** Calendar-day arithmetic in local time (DST safe). */
export function addDays(date: Date, days: number): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

/** Minutes from a to b (may be fractional / negative). */
export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 3_600_000;
}

/** Whole calendar days from a's date to b's date. */
export function calendarDaysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);
}

/** ISO day of week: 1 = Monday … 7 = Sunday */
export function isoDow(date: Date): number {
  const d = date.getDay();
  return d === 0 ? 7 : d;
}

/** Local midnight of the next Friday strictly after `date`. */
export function nextFridayAfter(date: Date): Date {
  const diff = (5 - date.getDay() + 7) % 7 || 7;
  return startOfDay(addDays(date, diff));
}

/** Local midnight of the next given ISO weekday strictly after `date`. */
export function nextIsoDowAfter(date: Date, dow: number): Date {
  const diff = (dow - isoDow(date) + 7) % 7 || 7;
  return startOfDay(addDays(date, diff));
}

/** 'YYYY-MM-DD' (local) */
export function dateOnly(date: Date): IsoDate {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 'YYYY-MM-DD' -> local midnight, or null */
export function parseDateOnly(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function weekdayName(date: Date): string {
  return WEEKDAY_NAMES[date.getDay()] ?? '';
}

/** "5:00 PM" (today), "tomorrow at 11:59 PM", "Friday at 5:00 PM" (within 6 days), "next Friday at 5:00 PM" (7 days), "Sep 25 at 5:00 PM" */
export function formatWhen(due: Date, now: Date): string {
  const days = calendarDaysBetween(now, due);
  const time = formatTime(due);
  if (days === 0) return time;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  if (days > 1 && days < 7) return `${weekdayName(due)} at ${time}`;
  if (days === 7) return `next ${weekdayName(due)} at ${time}`;
  return `${MONTHS[due.getMonth()] ?? ''} ${due.getDate()} at ${time}`;
}

/** "at 5:00 PM" (today) or formatWhen otherwise ("tomorrow at 11:59 PM", "Friday at 5:00 PM"). Reads after "due", "lost", "gone". */
export function formatDue(due: Date, now: Date): string {
  return calendarDaysBetween(now, due) === 0 ? `at ${formatTime(due)}` : formatWhen(due, now);
}

/** "Friday" (within 6 days), "tomorrow", "today", "next Friday" (7 days), "Sep 25" */
export function formatDay(day: Date, now: Date): string {
  const days = calendarDaysBetween(now, day);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days < 7) return weekdayName(day);
  if (days === 7) return `next ${weekdayName(day)}`;
  return `${MONTHS[day.getMonth()] ?? ''} ${day.getDate()}`;
}

/** "47 min", "3 h 47 min", "5 h", "4 days" */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes));
  if (total < 60) return `${total} min`;
  if (total < 48 * 60) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  }
  const days = Math.floor(total / (24 * 60));
  return `${days} days`;
}

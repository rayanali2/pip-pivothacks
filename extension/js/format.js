// Ports of ios/Pip/Pip/Support/DateFormatting.swift and PlanDisplay.swift.
// Wall-clock values are shown in the offset they carry, so times match the API and the iPhone app.

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Date instant for an IsoDateTime (with or without an offset), or null. */
export function parse(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** { y, m, d, hour, minute } read straight from the string, never shifted by the browser's zone. */
function wall(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
  if (!match) return null;
  return { y: +match[1], m: +match[2], d: +match[3], hour: +match[4], minute: +match[5] };
}

const two = (n) => (n < 10 ? `0${n}` : `${n}`);
const twelve = (h) => (h % 12 === 0 ? 12 : h % 12);

/** "2:00 PM" */
export function time(iso) {
  const w = wall(iso);
  if (!w) return null;
  return `${twelve(w.hour)}:${two(w.minute)} ${w.hour < 12 ? 'AM' : 'PM'}`;
}

/** ISO weekday of the wall date: 1 = Monday … 7 = Sunday */
function isoWeekday(w) {
  const day = new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** "Tue 5:00 PM" */
export function dayTime(iso) {
  const w = wall(iso);
  if (!w) return null;
  return `${SHORT_WEEKDAYS[isoWeekday(w) - 1]} ${time(iso)}`;
}

/** "5:00 PM" on the same day as `reference`, else "Tue 5:00 PM". */
export function smartTime(iso, reference) {
  const w = wall(iso);
  if (!w) return null;
  const ref = reference ? String(reference).slice(0, 10) : localIsoDate(new Date());
  return String(iso).slice(0, 10) === ref ? time(iso) : dayTime(iso);
}

/** "14:00" -> "2:00 PM" */
export function timeOfDay(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  return `${twelve(h)}:${two(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "14:00","17:00" -> "2:00–5:00 PM"; "11:30","12:20" -> "11:30 AM–12:20 PM" */
export function timeRange(start, end) {
  const [sh, sm] = String(start).split(':').map(Number);
  const [eh, em] = String(end).split(':').map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return `${start}–${end}`;
  const ss = sh < 12 ? 'AM' : 'PM';
  const es = eh < 12 ? 'AM' : 'PM';
  const endText = `${twelve(eh)}:${two(em)} ${es}`;
  return ss === es ? `${twelve(sh)}:${two(sm)}–${endText}` : `${twelve(sh)}:${two(sm)} ${ss}–${endText}`;
}

export const weekdayName = (dow) => WEEKDAYS[dow - 1] || `Day ${dow}`;
export const shortWeekdayName = (dow) => SHORT_WEEKDAYS[dow - 1] || `D${dow}`;

export function todayIsoDayOfWeek() {
  const day = new Date().getDay();
  return day === 0 ? 7 : day;
}

export function localIsoDate(date) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

export function hhmm(date) {
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 79 -> "$79", 21.5 -> "$21.50" */
export function dollars(amount) {
  return Math.round(amount) === amount ? `$${amount}` : `$${Number(amount).toFixed(2)}`;
}

/** 135 -> "2 h 15 min" */
export function durationText(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h} h ${m} min`;
  if (h > 0) return `${h} h`;
  return `${minutes} min`;
}

export const counted = (n, noun) => `${n} ${n === 1 ? noun : `${noun}s`}`;

export const CATEGORY_LABELS = {
  class: 'Class', assignment: 'Assignment', errand: 'Errand', meal: 'Meal', money: 'Money',
  work: 'Work', club: 'Club', social: 'Social', rest: 'Rest',
};
export const categoryLabel = (c) => CATEGORY_LABELS[c] || 'Other';

export const CHRONOTYPE_LABELS = { early_bird: 'Early bird', neutral: 'Neutral', night_owl: 'Night owl' };

export const FLAG_LABELS = { at_risk: 'At risk', balance_guard: 'Basic need' };

export const CURVE_LABELS = {
  cliff: 'Cliff', linear: 'Linear', daily_reset: 'Daily reset', rising_floor: 'Rising floor', defer_multiplier: 'Defer multiplier',
};

export const ACTION_PAST = { start_now: 'Started', done: 'Done', defer: 'Deferred', drop: 'Dropped' };

export const sourceLabel = (source) => (source === 'snowflake' ? 'Snowflake' : 'Local fallback');

// MARK: Plan display (PlanDisplay.swift)

/** "25 of 47 min free until CHEM 110 Lab, 2:00 PM" when fewer minutes were given, else the window's label. */
export function freeWindowText(plan) {
  const window = plan?.reasoning?.free_window;
  if (!window) return null;
  const available = plan.reasoning.context?.available_minutes;
  if (available != null && available < window.minutes) {
    const at = time(window.next_block_starts_at);
    if (window.next_block_title && at) return `${available} of ${window.minutes} min free until ${window.next_block_title}, ${at}`;
    return `${available} of ${window.minutes} min free`;
  }
  return window.label;
}

export const opensDetail = (item) => item.kind !== 'fixed_block' && item.task_id != null;

/** Start time if scheduled, else "Due …", else null. */
export function timeLabel(item, now) {
  const start = smartTime(item.starts_at, now);
  if (start) return start;
  const due = smartTime(item.due_at, now);
  return due ? `Due ${due}` : null;
}

/** Minutes of the item's planned slot. */
export function windowMinutes(item) {
  const start = parse(item.starts_at);
  const end = parse(item.ends_at);
  if (start && end && end > start) return Math.round((end - start) / 60000);
  return null;
}

export function allItems(plan) {
  if (!plan) return [];
  return [plan.do_now, plan.next, ...(plan.today || []), ...(plan.can_wait || [])].filter(Boolean);
}

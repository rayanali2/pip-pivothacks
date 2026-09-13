import type { FreeWindow, JsonValue, TimeOfDay, TimetableBlock } from '../types';
import { addMinutes, atTime, formatTime, hhmm, isoDow, minutesBetween, parseTimeOfDay, toIsoLocal } from '../clock';

export type BlockLike = Pick<TimetableBlock, 'title' | 'starts_at' | 'ends_at' | 'location'> & { day_of_week?: number };

/** A timetable block placed on a concrete date. */
export interface ResolvedBlock {
  title: string;
  location: string | null;
  day_of_week: number;
  starts_at: TimeOfDay;
  ends_at: TimeOfDay;
  start: Date;
  end: Date;
}

/** Length assumed for a spoken fixed block with no end time ("I have a 2 PM lab"). */
export const DEFAULT_BLOCK_MINUTES = 60;

export function resolveBlock(block: BlockLike, day: Date): ResolvedBlock | null {
  if (!parseTimeOfDay(block.starts_at) || !parseTimeOfDay(block.ends_at)) return null;
  const start = atTime(day, block.starts_at);
  let end = atTime(day, block.ends_at);
  if (end.getTime() <= start.getTime()) end = atTime(day, '23:59');
  return {
    title: block.title,
    location: block.location,
    day_of_week: block.day_of_week ?? isoDow(day),
    starts_at: block.starts_at,
    ends_at: hhmm(end),
    start,
    end,
  };
}

export function sortBlocks(blocks: ResolvedBlock[]): ResolvedBlock[] {
  return [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
}

export interface FixedBlockValue {
  title: string;
  starts_at: TimeOfDay;
  ends_at: TimeOfDay | null;
  location: string | null;
}

/** Narrows a fixed_block constraint value. */
export function readFixedBlockValue(value: JsonValue): FixedBlockValue | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = value.title;
  const startsAt = value.starts_at;
  const endsAt = value.ends_at;
  const location = value.location;
  if (typeof startsAt !== 'string' || !parseTimeOfDay(startsAt)) return null;
  return {
    title: typeof title === 'string' && title.trim() !== '' ? title : 'Class',
    starts_at: startsAt.padStart(5, '0'),
    ends_at: typeof endsAt === 'string' && parseTimeOfDay(endsAt) ? endsAt.padStart(5, '0') : null,
    location: typeof location === 'string' ? location : null,
  };
}

/**
 * Today's blocks: the timetable rows for today's ISO weekday plus spoken fixed_block constraints,
 * deduplicated by start time (the timetable row wins because it carries the full title and end time).
 */
export function todayBlocks(timetable: readonly TimetableBlock[], fixed: readonly FixedBlockValue[], now: Date): ResolvedBlock[] {
  const dow = isoDow(now);
  const out: ResolvedBlock[] = [];
  const seen = new Set<string>();
  for (const b of timetable) {
    if (b.day_of_week !== dow) continue;
    const r = resolveBlock(b, now);
    if (!r || seen.has(r.starts_at)) continue;
    seen.add(r.starts_at);
    out.push(r);
  }
  for (const f of fixed) {
    if (seen.has(f.starts_at)) continue;
    const start = atTime(now, f.starts_at);
    const endsAt = f.ends_at ?? hhmm(addMinutes(start, DEFAULT_BLOCK_MINUTES));
    const r = resolveBlock({ title: f.title, starts_at: f.starts_at, ends_at: endsAt, location: f.location, day_of_week: dow }, now);
    if (!r) continue;
    seen.add(r.starts_at);
    out.push(r);
  }
  return sortBlocks(out);
}

function label(minutes: number, next: ResolvedBlock | null): string {
  if (next) return `${minutes} min free until ${next.title}, ${formatTime(next.start)}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min free today` : `${m} min free today`;
}

function makeWindow(start: Date, end: Date, next: ResolvedBlock | null): FreeWindow {
  const minutes = Math.max(0, Math.floor(minutesBetween(start, end)));
  return {
    starts_at: toIsoLocal(start),
    ends_at: toIsoLocal(end),
    minutes,
    next_block_title: next ? next.title : null,
    next_block_starts_at: next ? toIsoLocal(next.start) : null,
    label: label(minutes, next),
  };
}

function toResolved(blocks: readonly (BlockLike | ResolvedBlock)[], now: Date): ResolvedBlock[] {
  const out: ResolvedBlock[] = [];
  for (const b of blocks) {
    if ('start' in b && b.start instanceof Date) out.push(b);
    else {
      const r = resolveBlock(b, now);
      if (r) out.push(r);
    }
  }
  return sortBlocks(out);
}

export interface WindowWithBlock {
  window: FreeWindow;
  next: ResolvedBlock | null;
}

/** Free windows from now until 23:59, each with the block that ends it. */
export function computeFreeWindowsDetailed(blocks: readonly (BlockLike | ResolvedBlock)[], now: Date): WindowWithBlock[] {
  const sorted = toResolved(blocks, now);
  const endOfDay = atTime(now, '23:59');
  const out: WindowWithBlock[] = [];
  let cursor = new Date(now.getTime());
  for (const b of sorted) {
    if (b.end.getTime() <= cursor.getTime()) continue;
    if (b.start.getTime() <= cursor.getTime()) {
      // now (or the previous block) runs into this block: the window starts when it ends
      cursor = new Date(b.end.getTime());
      continue;
    }
    const w = makeWindow(cursor, b.start, b);
    if (w.minutes > 0) out.push({ window: w, next: b });
    cursor = new Date(b.end.getTime());
  }
  if (cursor.getTime() < endOfDay.getTime()) {
    const w = makeWindow(cursor, endOfDay, null);
    if (w.minutes > 0) out.push({ window: w, next: null });
  }
  return out;
}

/** CONTRACT section 4, free window. Accepts TimetableBlock-like rows (placed on now's date) or resolved blocks. */
export function computeFreeWindows(blocks: readonly (BlockLike | ResolvedBlock)[], now: Date): FreeWindow[] {
  return computeFreeWindowsDetailed(blocks, now).map((w) => w.window);
}

export function nextFreeWindow(blocks: readonly (BlockLike | ResolvedBlock)[], now: Date): FreeWindow | null {
  return computeFreeWindows(blocks, now)[0] ?? null;
}

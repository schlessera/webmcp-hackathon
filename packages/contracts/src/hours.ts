import type { DossierHours } from "./dossier.ts";

/**
 * Pure weekly-hours predicates. Every civil-time decision comes from Intl in
 * the area's IANA timezone; the machine timezone and the timestamp's written
 * offset never decide which weekday schedule applies.
 */

export interface TimeWindow {
  start: string;
  end: string;
}

export type WindowCoverage = "covered" | "uncovered" | "unknown";

const DAY_ORDER = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_INDEX = new Map(DAY_ORDER.map((day, index) => [day, index]));

interface LocalInstant {
  day: string;
  weekday: string;
  year: number;
  month: number;
  date: number;
  minute: number;
}

function formatter(timezone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
}

function localInstant(at: Date, format: Intl.DateTimeFormat): LocalInstant | null {
  if (!Number.isFinite(at.getTime())) return null;
  const parts = Object.fromEntries(
    format.formatToParts(at).map((part) => [part.type, part.value]),
  );
  const weekday = parts.weekday;
  const day = weekday?.toLowerCase().slice(0, 3);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const date = Number(parts.day);
  if (!day || !DAY_INDEX.has(day as (typeof DAY_ORDER)[number])) return null;
  if (![hour, minute, year, month, date].every(Number.isFinite)) return null;
  return { day, weekday, year, month, date, minute: hour * 60 + minute };
}

function minuteOf(value: string, close = false): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 24) return null;
  if (hour === 24 && minute !== 0) return null;
  // The existing wire representation uses 23:59 for 24:00/open-ended rules.
  if (close && hour === 23 && minute === 59) return 24 * 60;
  return hour * 60 + minute;
}

type Week = Map<string, Array<{ start: number; end: number }>>;

function schedule(hours: DossierHours[]): Week | null {
  if (hours.length === 0) return null;
  const week: Week = new Map();
  let valid = 0;
  for (const row of hours) {
    const day = row.day.toLowerCase().slice(0, 3);
    if (!DAY_INDEX.has(day as (typeof DAY_ORDER)[number])) continue;
    const start = minuteOf(row.open);
    const end = minuteOf(row.close, true);
    if (start === null || end === null || end <= start) continue;
    const ranges = week.get(day) ?? [];
    ranges.push({ start, end });
    week.set(day, ranges);
    valid += 1;
  }
  if (valid === 0) return null;
  for (const ranges of week.values()) ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return week;
}

function openAt(local: LocalInstant, week: Week): boolean {
  return (week.get(local.day) ?? []).some(
    (range) => local.minute >= range.start && local.minute < range.end,
  );
}

/**
 * The civil-time cells an absolute window touches, as merged per-day ranges.
 *
 * This depends only on the window and the area's timezone, never on a place,
 * so it is computed once and reused across every candidate. Doing the Intl
 * work per place instead costs ~1 s per 1,400 places per need, which a room
 * pays again for every counterfactual pass the brief rows need.
 */
export interface CivilRange {
  day: string;
  /** Local minutes since midnight, end exclusive. */
  start: number;
  end: number;
}

const segmentCache = new Map<string, CivilRange[] | null>();
const SEGMENT_CACHE_MAX = 256;

function computeSegments(window: TimeWindow, timezone: string): CivilRange[] | null {
  const format = formatter(timezone);
  const start = new Date(window.start);
  const end = new Date(window.end);
  if (!format || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  if (end.getTime() <= start.getTime()) return null;

  // Hours have minute precision. Sampling the start, every following minute,
  // and the last millisecond covers every schedule cell the window touches,
  // including skipped/repeated DST wall times and midnight transitions.
  const probes = new Set<number>([start.getTime(), end.getTime() - 1]);
  for (let at = start.getTime() + 60_000; at < end.getTime(); at += 60_000) {
    probes.add(at);
    // A time need longer than eight days necessarily visits every weekly
    // civil-time cell. Stop an adversarial multi-year payload after one full
    // schedule cycle; any missing cell makes the window uncovered.
    if (probes.size > 8 * 24 * 60 + 2) break;
  }
  const cells = new Map<string, Set<number>>();
  for (const at of probes) {
    const local = localInstant(new Date(at), format);
    if (!local) return null;
    const minutes = cells.get(local.day) ?? new Set<number>();
    minutes.add(local.minute);
    cells.set(local.day, minutes);
  }
  if (end.getTime() - start.getTime() > 8 * 24 * 60 * 60_000) {
    // Longer than a full cycle: the place must be open every cell of the week.
    for (const day of DAY_ORDER) {
      const minutes = cells.get(day) ?? new Set<number>();
      for (let minute = 0; minute < 24 * 60; minute += 1) minutes.add(minute);
      cells.set(day, minutes);
    }
  }

  const ranges: CivilRange[] = [];
  for (const [day, minutes] of cells) {
    const sorted = [...minutes].sort((a, b) => a - b);
    let from = sorted[0];
    let previous = sorted[0];
    for (const minute of sorted.slice(1)) {
      if (minute === previous + 1) {
        previous = minute;
        continue;
      }
      ranges.push({ day, start: from, end: previous + 1 });
      from = minute;
      previous = minute;
    }
    ranges.push({ day, start: from, end: previous + 1 });
  }
  return ranges;
}

/** Memoized: a room asks the same window of every place in its pool. */
export function windowSegments(window: TimeWindow, timezone: string): CivilRange[] | null {
  const key = `${window.start}\u0000${window.end}\u0000${timezone}`;
  const hit = segmentCache.get(key);
  if (hit !== undefined) return hit;
  const computed = computeSegments(window, timezone);
  if (segmentCache.size >= SEGMENT_CACHE_MAX) segmentCache.clear();
  segmentCache.set(key, computed);
  return computed;
}

/** Is every minute of [from, to) inside the union of sorted open ranges? */
function coversRange(
  ranges: Array<{ start: number; end: number }>,
  from: number,
  to: number,
): boolean {
  let at = from;
  for (const range of ranges) {
    if (range.start > at) return false;
    if (range.end > at) at = range.end;
    if (at >= to) return true;
  }
  return at >= to;
}

/** Is the weekly schedule open for every instant in the absolute window? */
export function coversWindow(
  hours: DossierHours[],
  window: TimeWindow,
  timezone: string,
): WindowCoverage {
  const week = schedule(hours);
  const segments = windowSegments(window, timezone);
  if (!week || !segments) return "unknown";
  for (const segment of segments) {
    if (!coversRange(week.get(segment.day) ?? [], segment.start, segment.end)) return "uncovered";
  }
  return "covered";
}

function timeText(local: LocalInstant): string {
  const hour = Math.floor(local.minute / 60);
  const minute = local.minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function endpoints(window: TimeWindow, timezone: string):
  | { start: LocalInstant; end: LocalInstant }
  | null {
  const format = formatter(timezone);
  if (!format) return null;
  const start = localInstant(new Date(window.start), format);
  const end = localInstant(new Date(window.end), format);
  return start && end ? { start, end } : null;
}

const WEEKDAY_TEXT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * The window as its own written offset states it: wall clock and weekday read
 * straight off the ISO strings, no timezone lookup. This is the fallback for
 * every reader-facing label, so an ISO timestamp never reaches the page
 * (CLAUDE.md 6: nothing protocol-shaped in the main UI).
 */
export function windowSpanText(window: TimeWindow): string {
  const read = (value: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    if (!m) return null;
    const [, year, month, date, hour, minute] = m;
    const at = Date.UTC(Number(year), Number(month) - 1, Number(date));
    if (!Number.isFinite(at)) return null;
    return { weekday: WEEKDAY_TEXT[new Date(at).getUTCDay()], time: `${hour}:${minute}` };
  };
  const from = read(window.start);
  const to = read(window.end);
  if (!from || !to) return "the requested time";
  return from.weekday === to.weekday
    ? `${from.weekday} ${from.time}\u2013${to.time}`
    : `${from.weekday} ${from.time}\u2013${to.weekday} ${to.time}`;
}

/** Absolute weekday/time span used in evidence and questions. */
export function windowSpan(window: TimeWindow, timezone: string): string {
  const local = endpoints(window, timezone);
  if (!local) return windowSpanText(window);
  const days = local.start.weekday === local.end.weekday
    ? local.start.weekday
    : `${local.start.weekday}–${local.end.weekday}`;
  return `${days} ${timeText(local.start)}–${timeText(local.end)}`;
}

function civilOrdinal(local: LocalInstant): number {
  return Math.floor(Date.UTC(local.year, local.month - 1, local.date) / 86_400_000);
}

/** Relative reader label for a need/facet, with the area's civil day. */
export function windowLabel(window: TimeWindow, timezone: string, now: Date): string {
  const local = endpoints(window, timezone);
  const format = formatter(timezone);
  const current = format ? localInstant(now, format) : null;
  if (!local || !current) return `open ${windowSpanText(window)}`;
  const difference = civilOrdinal(local.start) - civilOrdinal(current);
  const weekday = local.start.weekday === local.end.weekday
    ? local.start.weekday
    : `${local.start.weekday}–${local.end.weekday}`;
  const times = `${timeText(local.start)}–${timeText(local.end)}`;
  if (difference === 0) return `open today ${times} (${weekday})`;
  if (difference === 1) return `open tomorrow ${times} (${weekday})`;
  return `open ${weekday} ${times}`;
}

/** Current status from weekly hours. null means the schedule cannot answer. */
export function openNow(
  hours: DossierHours[],
  timezone: string,
  now: Date,
): { open: boolean; until?: string } | null {
  const week = schedule(hours);
  const format = formatter(timezone);
  const local = format ? localInstant(now, format) : null;
  if (!week || !local) return null;
  const ranges = week.get(local.day) ?? [];
  let range = ranges.find((item) => local.minute >= item.start && local.minute < item.end);
  if (!range) return { open: false };

  let end = range.end;
  let dayIndex = DAY_INDEX.get(local.day as (typeof DAY_ORDER)[number])!;
  let traversed = 0;
  while (end === 24 * 60 && traversed < 7) {
    dayIndex = (dayIndex + 1) % 7;
    const next = week.get(DAY_ORDER[dayIndex])?.find((item) => item.start === 0);
    if (!next) break;
    end = next.end;
    traversed += 1;
  }
  if (traversed >= 7 && end === 24 * 60) return { open: true };
  if (end === 24 * 60) return { open: true, until: "24:00" };
  return {
    open: true,
    until: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`,
  };
}

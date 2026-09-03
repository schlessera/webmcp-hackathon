import type { TimePart, TimeSpec } from "./types.ts";

type FixedTimePart = Exclude<TimePart, "now">;

/** The sole source of truth for the local windows named in parser prompts. */
export const TIME_PART_WINDOWS: Readonly<Record<FixedTimePart, readonly [number, number]>> = Object.freeze({
  morning: [8 * 60, 11 * 60],
  brunch: [10 * 60, 13 * 60],
  lunch: [12 * 60, 14 * 60],
  afternoon: [14 * 60, 17 * 60],
  evening: [18 * 60, 21 * 60],
  tonight: [18 * 60, 23 * 60],
  night: [20 * 60, 24 * 60],
  late: [22 * 60, 26 * 60],
});

const two = (value: number) => String(value).padStart(2, "0");
const minuteLabel = (value: number) => `${two(Math.floor((value % (24 * 60)) / 60))}:${two(value % 60)}`;

/** Generated from TIME_PART_WINDOWS so Stage A describes the resolver's exact table. */
export const TIME_WINDOW_INSTRUCTIONS = [
  `morning ${minuteLabel(TIME_PART_WINDOWS.morning[0])}-${minuteLabel(TIME_PART_WINDOWS.morning[1])}`,
  `brunch ${minuteLabel(TIME_PART_WINDOWS.brunch[0])}-${minuteLabel(TIME_PART_WINDOWS.brunch[1])}`,
  `lunch ${minuteLabel(TIME_PART_WINDOWS.lunch[0])}-${minuteLabel(TIME_PART_WINDOWS.lunch[1])}`,
  `afternoon ${minuteLabel(TIME_PART_WINDOWS.afternoon[0])}-${minuteLabel(TIME_PART_WINDOWS.afternoon[1])}`,
  `dinner/evening ${minuteLabel(TIME_PART_WINDOWS.evening[0])}-${minuteLabel(TIME_PART_WINDOWS.evening[1])}`,
  `tonight ${minuteLabel(TIME_PART_WINDOWS.tonight[0])}-${minuteLabel(TIME_PART_WINDOWS.tonight[1])}`,
  `night ${minuteLabel(TIME_PART_WINDOWS.night[0])}-${minuteLabel(TIME_PART_WINDOWS.night[1])}`,
  `late ${minuteLabel(TIME_PART_WINDOWS.late[0])}-${minuteLabel(TIME_PART_WINDOWS.late[1])} next day`,
  "now from the captured instant through two hours later",
  "a clock time one hour either side",
  "a day without a part 09:00-23:00",
].join("; ");

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

interface ZonedParts extends CivilDate {
  hour: number;
  minute: number;
  second: number;
}

function formatter(timezone: string, offset: boolean): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(offset ? { timeZoneName: "longOffset" } : {}),
  });
}

function zonedParts(instant: Date, timezone: string): ZonedParts {
  const parts = Object.fromEntries(formatter(timezone, false).formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function addDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function weekday(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Convert a civil clock to an instant without depending on the host timezone. */
function civilInstant(date: CivilDate, minuteOfDay: number, timezone: string): Date {
  const normalizedDate = addDays(date, Math.floor(minuteOfDay / (24 * 60)));
  const normalizedMinute = ((minuteOfDay % (24 * 60)) + 24 * 60) % (24 * 60);
  const desired = Date.UTC(
    normalizedDate.year,
    normalizedDate.month - 1,
    normalizedDate.day,
    Math.floor(normalizedMinute / 60),
    normalizedMinute % 60,
    0,
  );
  let instant = desired;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const actual = zonedParts(new Date(instant), timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const correction = desired - represented;
    if (correction === 0) break;
    instant += correction;
  }
  return new Date(instant);
}

function localIso(instant: Date, timezone: string): string {
  const parts = Object.fromEntries(formatter(timezone, true).formatToParts(instant).map((part) => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName?.replace("GMT", "") ?? "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function validSpec(spec: TimeSpec): boolean {
  return Boolean(
    spec &&
    (spec.day === null || spec.day.kind === "today" || spec.day.kind === "tomorrow" ||
      (spec.day.kind === "weekday" && Number.isInteger(spec.day.weekday) && spec.day.weekday >= 0 && spec.day.weekday <= 6)) &&
    (spec.part === null || spec.part === "now" || Object.hasOwn(TIME_PART_WINDOWS, spec.part)) &&
    (spec.clock === null ||
      (Number.isInteger(spec.clock.hour) && spec.clock.hour >= 0 && spec.clock.hour <= 23 &&
       Number.isInteger(spec.clock.minute) && spec.clock.minute >= 0 && spec.clock.minute <= 59)),
  );
}

/** Resolve civil time words using only the captured instant and IANA timezone. */
export function resolveTimeSpec(
  spec: TimeSpec,
  now: Date,
  timezone: string,
): { start: string; end: string } | null {
  try {
    if (!validSpec(spec) || !Number.isFinite(now.getTime())) return null;
    // Validate the timezone even on the instant-only path.
    const localNow = zonedParts(now, timezone);
    if (spec.part === "now") {
      return { start: localIso(now, timezone), end: localIso(new Date(now.getTime() + 2 * 60 * 60 * 1_000), timezone) };
    }
    if (!spec.day && !spec.part && !spec.clock) return null;

    const today: CivilDate = { year: localNow.year, month: localNow.month, day: localNow.day };
    let dayOffset = spec.day?.kind === "tomorrow" ? 1 : 0;
    if (spec.day?.kind === "weekday") dayOffset = (spec.day.weekday - weekday(today) + 7) % 7;

    let startMinute: number;
    let endMinute: number;
    if (spec.clock) {
      const impliedPm = (spec.part === "evening" || spec.part === "tonight") && spec.clock.hour < 12;
      const centre = (spec.clock.hour + (impliedPm ? 12 : 0)) * 60 + spec.clock.minute;
      startMinute = centre - 60;
      endMinute = centre + 60;
    } else if (spec.part) {
      [startMinute, endMinute] = TIME_PART_WINDOWS[spec.part];
    } else {
      startMinute = 9 * 60;
      endMinute = 23 * 60;
    }

    let date = addDays(today, dayOffset);
    let start = civilInstant(date, startMinute, timezone);
    let end = civilInstant(date, endMinute, timezone);

    if (spec.day?.kind === "weekday" && dayOffset === 0 && end.getTime() <= now.getTime()) {
      date = addDays(date, 7);
      start = civilInstant(date, startMinute, timezone);
      end = civilInstant(date, endMinute, timezone);
    } else if (spec.clock && !spec.day) {
      // "at 8" after eight o'clock means tomorrow; "today at 8" stays today.
      const impliedPm = (spec.part === "evening" || spec.part === "tonight") && spec.clock.hour < 12;
      const centreMinute = (spec.clock.hour + (impliedPm ? 12 : 0)) * 60 + spec.clock.minute;
      const centre = civilInstant(date, centreMinute, timezone);
      if (centre.getTime() <= now.getTime()) {
        date = addDays(date, 1);
        start = civilInstant(date, startMinute, timezone);
        end = civilInstant(date, endMinute, timezone);
      }
    } else if (!spec.day && end.getTime() <= now.getTime()) {
      date = addDays(date, 1);
      start = civilInstant(date, startMinute, timezone);
      end = civilInstant(date, endMinute, timezone);
    }

    if (end.getTime() <= start.getTime()) return null;
    return { start: localIso(start, timezone), end: localIso(end, timezone) };
  } catch {
    return null;
  }
}

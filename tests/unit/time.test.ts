import { describe, expect, it } from "vitest";
import { resolveTimeSpec, type TimeSpec } from "@webmcp-hackathon/contracts";

const weekday = (value: 0 | 1 | 2 | 3 | 4 | 5 | 6, part: TimeSpec["part"] = null): TimeSpec => ({
  day: { kind: "weekday", weekday: value },
  part,
  clock: null,
});

describe("deterministic time resolution", () => {
  it("resolves Sunday to the next Friday", () => {
    expect(resolveTimeSpec(weekday(5, "evening"), new Date("2026-09-06T10:00:00Z"), "Europe/Berlin")).toEqual({
      start: "2026-09-11T18:00:00+02:00",
      end: "2026-09-11T21:00:00+02:00",
    });
  });

  it("moves an elapsed Friday window to the following Friday", () => {
    expect(resolveTimeSpec(weekday(5, "evening"), new Date("2026-09-04T21:30:00Z"), "Europe/Berlin")).toEqual({
      start: "2026-09-11T18:00:00+02:00",
      end: "2026-09-11T21:00:00+02:00",
    });
  });

  it("keeps today's weekday while its window end is ahead", () => {
    expect(resolveTimeSpec(weekday(5, "evening"), new Date("2026-09-04T18:30:00Z"), "Europe/Berlin")).toEqual({
      start: "2026-09-04T18:00:00+02:00",
      end: "2026-09-04T21:00:00+02:00",
    });
  });

  it("moves a clock time that already passed to tomorrow", () => {
    expect(resolveTimeSpec({ day: null, part: null, clock: { hour: 8, minute: 0 } }, new Date("2026-09-03T10:00:00Z"), "Europe/Berlin")).toEqual({
      start: "2026-09-04T07:00:00+02:00",
      end: "2026-09-04T09:00:00+02:00",
    });
  });

  it("uses an evening word to disambiguate a twelve-hour German clock", () => {
    expect(resolveTimeSpec({ day: { kind: "today" }, part: "evening", clock: { hour: 8, minute: 30 } }, new Date("2026-09-03T10:00:00Z"), "Europe/Berlin")).toEqual({
      start: "2026-09-03T19:30:00+02:00",
      end: "2026-09-03T21:30:00+02:00",
    });
  });

  it("is DST-safe across Berlin's autumn transition", () => {
    const window = resolveTimeSpec({ day: { kind: "today" }, part: "late", clock: null }, new Date("2026-10-24T10:00:00Z"), "Europe/Berlin");
    expect(window).toEqual({
      start: "2026-10-24T22:00:00+02:00",
      end: "2026-10-25T02:00:00+01:00",
    });
    expect(Date.parse(window!.end) - Date.parse(window!.start)).toBe(5 * 60 * 60 * 1_000);
  });

  it("uses the target zone rather than the host zone in San Francisco", () => {
    expect(resolveTimeSpec({ day: { kind: "tomorrow" }, part: "lunch", clock: null }, new Date("2026-09-03T19:00:00Z"), "America/Los_Angeles")).toEqual({
      start: "2026-09-04T12:00:00-07:00",
      end: "2026-09-04T14:00:00-07:00",
    });
  });

  it("uses 09:00-23:00 for a day without a part and rejects invalid input", () => {
    expect(resolveTimeSpec({ day: { kind: "tomorrow" }, part: null, clock: null }, new Date("2026-09-03T10:00:00Z"), "Europe/Berlin")).toEqual({
      start: "2026-09-04T09:00:00+02:00",
      end: "2026-09-04T23:00:00+02:00",
    });
    expect(resolveTimeSpec({ day: null, part: null, clock: { hour: 24, minute: 0 } }, new Date(), "Europe/Berlin")).toBeNull();
    expect(resolveTimeSpec({ day: null, part: "lunch", clock: null }, new Date(), "Not/A_Zone")).toBeNull();
  });
});

/** The hours evaluator always uses the area's civil clock and covers every minute of a window. */
import { describe, expect, it } from "vitest";
import {
  coversWindow,
  openNow,
  windowLabel,
  type DossierHours,
} from "../../packages/contracts/src/index.ts";

const weekdays = (open: string, close: string): DossierHours[] =>
  ["mon", "tue", "wed", "thu", "fri"].map((day) => ({ day, open, close }));

describe("coversWindow", () => {
  it("distinguishes covered, uncovered, and unknown schedules", () => {
    const hours = weekdays("11:00", "23:00");
    expect(coversWindow(hours, {
      start: "2026-09-04T12:00:00+02:00",
      end: "2026-09-04T14:00:00+02:00",
    }, "Europe/Berlin")).toBe("covered");
    expect(coversWindow(hours, {
      start: "2026-09-04T22:00:00+02:00",
      end: "2026-09-05T00:30:00+02:00",
    }, "Europe/Berlin")).toBe("uncovered");
    expect(coversWindow([], {
      start: "2026-09-04T12:00:00+02:00",
      end: "2026-09-04T14:00:00+02:00",
    }, "Europe/Berlin")).toBe("unknown");
  });

  it("covers a midnight crossing and a window spanning two weekday rows", () => {
    const hours: DossierHours[] = [
      { day: "fri", open: "18:00", close: "23:59" },
      { day: "sat", open: "00:00", close: "02:00" },
    ];
    expect(coversWindow(hours, {
      start: "2026-09-04T23:00:00+02:00",
      end: "2026-09-05T01:00:00+02:00",
    }, "Europe/Berlin")).toBe("covered");
  });

  it("uses America/Los_Angeles even when the machine runs in Europe/Berlin", () => {
    const hours: DossierHours[] = [{ day: "thu", open: "17:00", close: "19:00" }];
    const window = {
      start: "2026-09-04T00:00:00Z",
      end: "2026-09-04T01:00:00Z",
    };
    expect(coversWindow(hours, window, "America/Los_Angeles")).toBe("covered");
    expect(coversWindow(hours, window, "Europe/Berlin")).toBe("uncovered");
  });
});

describe("window labels and current status", () => {
  const now = new Date("2026-09-01T10:00:00+02:00");

  it("uses today, tomorrow, and weekday forms", () => {
    expect(windowLabel({
      start: "2026-09-01T18:00:00+02:00", end: "2026-09-01T21:00:00+02:00",
    }, "Europe/Berlin", now)).toBe("open today 18:00–21:00 (Tue)");
    expect(windowLabel({
      start: "2026-09-02T12:00:00+02:00", end: "2026-09-02T14:00:00+02:00",
    }, "Europe/Berlin", now)).toBe("open tomorrow 12:00–14:00 (Wed)");
    expect(windowLabel({
      start: "2026-09-04T19:00:00+02:00", end: "2026-09-04T21:00:00+02:00",
    }, "Europe/Berlin", now)).toBe("open Fri 19:00–21:00");
  });

  it("reports open, closed, and unknowable without reading the wall clock", () => {
    const hours = weekdays("11:00", "23:00");
    expect(openNow(hours, "Europe/Berlin", new Date("2026-09-01T12:00:00+02:00")))
      .toEqual({ open: true, until: "23:00" });
    expect(openNow(hours, "Europe/Berlin", new Date("2026-09-01T23:30:00+02:00")))
      .toEqual({ open: false });
    expect(openNow([], "Europe/Berlin", now)).toBeNull();
  });
});

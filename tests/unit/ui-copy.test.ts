import { describe, expect, it } from "vitest";
import {
  citationLabel,
  hoursDays,
  hoursLines,
  isCombinedClaim,
  sourceLabel,
} from "../../apps/web/src/ui/copy.ts";

describe("evidence wording", () => {
  it("names each inference bucket by what the room actually did", () => {
    expect(sourceLabel("infer:m:venue_site")).toBe("read on the place's own site");
    expect(sourceLabel("infer:m:domain_search")).toBe("found by searching the place's site");
    expect(sourceLabel("infer:m:open_web_search")).toBe("found on the web");
    expect(sourceLabel("infer:m:name_category")).toBe("a guess from the kind of place");
  });

  // The server folds menu text into venue_site no longer: a menu read is its
  // own bucket, and it must not fall through to the weakest phrasing.
  it("reads a menu fact as a menu fact", () => {
    expect(sourceLabel("infer:m:menu")).toBe("read from the menu");
    expect(sourceLabel("menu:carte")).toBe("read from the menu");
  });

  // A combined search is the model's account of pages the server never
  // opened. It may not borrow the wording of a page that was read.
  it("never says a combined claim was read off a page", () => {
    const combined = "infer:m:open_web_search:combined";
    expect(isCombinedClaim(combined)).toBe(true);
    expect(isCombinedClaim("infer:m:open_web_search")).toBe(false);
    expect(isCombinedClaim(undefined)).toBe(false);
    expect(sourceLabel(combined)).toBe("found by a web search");
    expect(sourceLabel(combined)).not.toContain("read");
    expect(sourceLabel(combined)).not.toContain("site");
    // Every bucket a combined claim can carry says the same thing.
    for (const bucket of ["venue_site", "domain_search", "menu", "name_category"]) {
      expect(sourceLabel(`infer:m:${bucket}:combined`)).toBe("found by a web search");
    }
  });

  it("offers a combined citation rather than quoting it, and keeps the link", () => {
    expect(citationLabel("https://www.example.com/menu")).toBe("from example.com");
    expect(citationLabel("https://www.example.com/menu", false)).toBe("a page at example.com");
    expect(citationLabel("not a url", false)).toBe("a page the room did not read");
  });
});

// The panel folds the week behind a count of days. A schedule row is not a
// day: a split shift and an overnight range give one day several rows, and
// counting rows would claim a ten-day week.
describe("how much of the week the record carries", () => {
  const week = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => ({
    day,
    open: "09:00",
    close: "17:00",
  }));

  it("counts days, not schedule rows", () => {
    expect(hoursDays(week)).toBe(7);
    const split = [
      { day: "mon", open: "09:00", close: "12:00" },
      { day: "mon", open: "13:00", close: "18:00" },
      { day: "mon", open: "22:00", close: "02:00" },
    ];
    expect(split).toHaveLength(3);
    expect(hoursDays(split)).toBe(1);
  });

  it("never claims more than a week, however the record is shaped", () => {
    const doubled = [...week, ...week];
    expect(doubled).toHaveLength(14);
    expect(hoursDays(doubled)).toBe(7);
  });

  it("counts exactly the days the lines can draw", () => {
    const mixed = [
      { day: "Monday", open: "09:00", close: "17:00" },
      { day: "TUE", open: "09:00", close: "17:00" },
      { day: "holiday", open: "12:00", close: "16:00" },
      { day: "", open: "12:00", close: "16:00" },
    ];
    // The same normalisation both sides: what is drawn is what is counted.
    expect(hoursLines(mixed).map((line) => line.days)).toEqual(["Mon–Tue"]);
    expect(hoursDays(mixed)).toBe(2);
  });

  it("counts nothing when the record carries nothing", () => {
    expect(hoursDays([])).toBe(0);
  });
});

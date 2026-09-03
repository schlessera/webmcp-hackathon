import { afterEach, describe, expect, it, vi } from "vitest";
import { payloadFromText } from "../../apps/web/src/components/Composer.tsx";
import type { Facet } from "@webmcp-hackathon/contracts";

afterEach(() => vi.useRealTimers());

describe("composer offline payloads", () => {
  it("turns exactly open now into a two-hour time need", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T08:15:30.000Z"));

    const payload = payloadFromText("  Open Now  ", []) as {
      kind: string;
      window: { start: string; end: string };
      phrase: string;
    };
    expect(payload).toMatchObject({ kind: "time", phrase: "Open Now" });
    expect(payload.window.start).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(payload.window.end).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(Date.parse(payload.window.start)).toBe(Date.parse("2026-09-03T08:15:30.000Z"));
    expect(Date.parse(payload.window.end) - Date.parse(payload.window.start)).toBe(2 * 60 * 60 * 1000);
  });

  it("keeps the existing facet, money, minutes, and honest-text cases", () => {
    const facets = [{
      key: "wheelchair-accessible",
      label: "step-free access",
      type: "boolean",
      counts: { yes: 3, no: 1, unknown: 2 },
    }] as Facet[];
    expect(payloadFromText("step-free access", facets)).toEqual({
      kind: "attribute", key: "wheelchair-accessible", expect: "verified_true",
    });
    expect(payloadFromText("under €12.50", [])).toEqual({
      kind: "budget", perPersonMax: { amount: 12.5, currency: "EUR" },
    });
    expect(payloadFromText("within 15 min", [])).toEqual({
      kind: "scope", dimension: "walk_min", max: 15,
    });
    expect(payloadFromText("open tomorrow for lunch", [])).toEqual({
      kind: "text", text: "open tomorrow for lunch",
    });
  });
});

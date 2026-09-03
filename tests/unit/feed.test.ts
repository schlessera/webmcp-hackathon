import { describe, expect, it } from "vitest";
import type { ProjectedEvent } from "@webmcp-hackathon/contracts";
import { mergeFeed } from "../../apps/web/src/feed.ts";

const event = (
  revision: number,
  type: string,
  text: string,
  actorId?: string,
): ProjectedEvent => ({
  revision,
  type,
  level: "existence",
  text,
  ...(actorId ? { actorId } : {}),
});

describe("feed projection", () => {
  it("collapses only consecutive whole-area fill rows", () => {
    const rows = mergeFeed([
      event(6, "candidates_added", "20 more places on the map."),
      event(5, "candidates_added", "50 more places on the map."),
      event(4, "requirement_submitted", "A need changed."),
      event(3, "candidates_added", "10 more places on the map."),
      event(2, "candidates_added", "You brought 3 places in.", "p_org"),
    ], []);

    expect(rows.map((row) => row.text)).toEqual([
      "70 more places on the map.",
      "A need changed.",
      "10 more places on the map.",
      "You brought 3 places in.",
    ]);
  });
});

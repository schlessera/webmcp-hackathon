import { describe, expect, it } from "vitest";
import {
  citationLabel,
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

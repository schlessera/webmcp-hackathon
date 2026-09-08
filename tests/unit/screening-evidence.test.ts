import { describe, expect, it } from "vitest";
import type { CandidateDossier } from "@webmcp-hackathon/contracts";
import { supportedScreeningVerdict } from "../../apps/server/src/nl/screening.ts";

const candidate = { name: "Corner House", attributes: [
  { key: "dog-friendly", status: "likely_false" },
  { key: "wifi", status: "verified_true" },
  { key: "quiet", status: "unknown" },
] } as CandidateDossier;

describe("private verdict evidence ceiling", () => {
  it("refuses to promote a likely refusal, missing evidence or an incomplete conjunction", () => {
    for (const supportingKeys of [undefined, [], ["dog-friendly"], ["wifi", "quiet"], ["invented"]]) {
      expect(supportedScreeningVerdict({ candidateId: "c", verdict: "unacceptable", supportingKeys }, candidate, "private condition"))
        .toBe("needs_info");
    }
  });
  it("accepts verified support and literal place references without publishing the condition", () => {
    expect(supportedScreeningVerdict({ candidateId: "c", verdict: "acceptable", supportingKeys: ["wifi"] }, candidate, "Wi-Fi"))
      .toBe("acceptable");
    expect(supportedScreeningVerdict({ candidateId: "c", verdict: "unacceptable", supportingKeys: ["$name"] }, candidate, "avoid Corner House"))
      .toBe("unacceptable");
    expect(supportedScreeningVerdict({ candidateId: "c", verdict: "unacceptable", supportingKeys: ["$name"] }, candidate, "somewhere quiet"))
      .toBe("needs_info");
  });
});

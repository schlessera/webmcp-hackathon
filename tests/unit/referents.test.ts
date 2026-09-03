import { describe, expect, it } from "vitest";
import {
  classifyCandidate,
  whyFor,
  type CandidateRow,
  type RequirementRow,
  type ScopeState,
} from "../../apps/server/src/eligibility.ts";
import { labelForRequirement } from "../../apps/server/src/facets.ts";

const scope: ScopeState = {
  scopeId: "scope_ref",
  area: { kind: "circle", center: { lat: 52.5, lng: 13.4 }, radiusM: 5000 },
  transport: ["walk"],
  category: "places",
};
const candidate: CandidateRow = {
  id: "candidate_target",
  map_revision: 0,
  name: "Target",
  category: "place",
  price_level: null,
  walk_min: 1,
  location: { lat: 52.509, lng: 13.4 },
  attributes: [],
};

function need(
  referent: NonNullable<NonNullable<RequirementRow["payload"]>["referent"]> | undefined,
  extra: Partial<RequirementRow> = {},
): RequirementRow {
  return {
    id: `need_${referent?.kind ?? "self"}`,
    owner_id: "owner",
    visibility: "shared",
    hardness: "hard",
    payload: {
      kind: "scope",
      dimension: "radius_m",
      max: 300,
      ...(referent ? { referent } : {}),
    },
    withdrawn: false,
    ...extra,
  };
}

describe("scope referent classification", () => {
  it.each([
    ["self", need({ kind: "self" }, { owner_origin: candidate.location })],
    ["scope centre", {
      ...need({ kind: "scopeCenter" }, { referent_location: scope.area.center, referent_status: "resolved" }),
      payload: { kind: "scope", dimension: "radius_m", max: 1200, referent: { kind: "scopeCenter" } },
    } as RequirementRow],
    ["candidate", need({ kind: "candidate", candidateId: "source" }, { referent_location: candidate.location, referent_status: "resolved" })],
    ["participant", need({ kind: "participant", participantId: "person" }, { referent_location: candidate.location, referent_status: "resolved" })],
    ["point", need({ kind: "point", ...candidate.location, label: "The steps" })],
    ["landmark", need({ kind: "landmark", landmarkId: "lm" }, { referent_location: candidate.location, referent_status: "resolved" })],
  ])("resolves a %s referent", (_name, requirement) => {
    expect(classifyCandidate(candidate, [requirement], [], scope, "UTC").eligibility).toBe("eligible");
  });

  it("falls an absent/self referent back to the scope centre", () => {
    const row = classifyCandidate(candidate, [need(undefined, { owner_origin: null })], [], scope, "UTC");
    expect(row.eligibility).toBe("excluded");
  });

  it.each([
    ["deleted candidate", need({ kind: "candidate", candidateId: "gone" }, { referent_status: "missing" })],
    ["unknown landmark", need({ kind: "landmark", landmarkId: "gone" }, { referent_status: "missing" })],
    ["missing participant", need({ kind: "participant", participantId: "gone" }, { referent_status: "missing" })],
    ["private participant", need({ kind: "participant", participantId: "private" }, { referent_status: "private" })],
  ])("keeps a %s referent pending and never excludes", (_name, requirement) => {
    const row = classifyCandidate(candidate, [requirement], [], scope, "UTC");
    expect(row.eligibility).toBe("uncertain");
    expect(row.exclusion).toBeUndefined();
    expect(whyFor(row, "peer")).toBeTruthy();
  });
});

describe("scope referent labels", () => {
  const label = (requirement: RequirementRow, own = true) =>
    labelForRequirement(requirement, own);

  it("composes every referent kind", () => {
    expect(label(need({ kind: "self" }))).toBe("within 300 m of where you start");
    expect(label(need({ kind: "scopeCenter" }))).toBe("within 300 m of the room centre");
    expect(label(need({ kind: "candidate", candidateId: "c" }, { referent_label: "Café Einstein" })))
      .toBe("within 300 m of Café Einstein");
    expect(label(need({ kind: "participant", participantId: "p" }, { referent_label: "where you start" })))
      .toBe("within 300 m of where you start");
    expect(label(need({ kind: "point", lat: 1, lng: 2, label: "The steps" })))
      .toBe("within 300 m of The steps");
    expect(label(need({ kind: "landmark", landmarkId: "lm" }, { referent_label: "U Alexanderplatz" })))
      .toBe("within 300 m of U Alexanderplatz");
  });

  it("never names a participant whose position is private to this peer", () => {
    const privatePeer = need(
      { kind: "participant", participantId: "sarah" },
      { referent_status: "private", referent_label: "where someone starts from" },
    );
    const text = label(privatePeer, false);
    expect(text).toBe("within 300 m of where someone starts from");
    expect(text).not.toContain("Sarah");
  });
});

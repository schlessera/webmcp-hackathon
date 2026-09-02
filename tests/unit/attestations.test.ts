import { describe, expect, it } from "vitest";
import {
  applyAttestations,
  type AttestationRow,
  type MergedAttribute,
} from "../../apps/server/src/attestations.ts";
import { classifyAll, type CandidateRow, type RequirementRow } from "../../apps/server/src/eligibility.ts";

/**
 * SPATIAL-PROTOCOL.md §8.1: attestations are merged at read time, a verified
 * record fact wins, an attestation over silence is decisive, disagreement
 * reads as unverified. The status vocabulary never grows.
 */

const row = (over: Partial<AttestationRow>): AttestationRow => ({
  candidate_id: "c1",
  key: "lactose-free-options",
  participant_id: "p_sarah",
  status: "verified_true",
  confidence: 0.8,
  note: "called them",
  source_url: null,
  at_revision: 3,
  ...over,
});

const unknown: MergedAttribute = { key: "lactose-free-options", status: "unknown", source: "osm:diet:lactose_free" };
const osmNo: MergedAttribute = { key: "lactose-free-options", status: "verified_false", source: "osm:diet:lactose_free" };

describe("applyAttestations", () => {
  it("is a no-op without attestations for the place", () => {
    const attrs = [unknown];
    expect(applyAttestations("c1", attrs, [row({ candidate_id: "c2" })])).toBe(attrs);
  });

  it("decides an unknown fact, labelled with the attester", () => {
    const [a] = applyAttestations("c1", [unknown], [row({})]);
    expect(a).toMatchObject({
      status: "verified_true",
      source: "agent:p_sarah",
      attestedBy: "p_sarah",
      note: "called them",
      confidence: 0.8,
    });
  });

  it("leaves a verified record fact alone when the attestation agrees", () => {
    const [a] = applyAttestations("c1", [osmNo], [row({ status: "verified_false" })]);
    expect(a).toBe(osmNo);
  });

  it("disputes, never overwrites, a verified record fact", () => {
    const [a] = applyAttestations("c1", [osmNo], [row({ status: "verified_true" })]);
    expect(a.status).toBe("unknown");
    expect(a.source).toMatch(/^disputed:osm:diet:lactose_free\|agent:p_sarah$/);
    expect(a.attestedBy).toBe("p_sarah");
  });

  it("two attesters who disagree over silence read as unknown, both on record", () => {
    const [a] = applyAttestations(
      "c1",
      [unknown],
      [row({}), row({ participant_id: "p_joe", status: "verified_false", at_revision: 4 })],
    );
    expect(a.status).toBe("unknown");
    expect(a.source).toBe("disputed:agent:p_sarah|agent:p_joe");
  });

  it("grades by confidence: a sure attester verifies, a less sure one makes it likely (§8.2)", () => {
    expect(applyAttestations("c1", [unknown], [row({ confidence: 0.9 })])[0].status).toBe("verified_true");
    expect(applyAttestations("c1", [unknown], [row({ confidence: 0.6 })])[0]).toMatchObject({ status: "likely_true", confidence: 0.6 });
    expect(applyAttestations("c1", [unknown], [row({ status: "verified_false", confidence: 0.5 })])[0].status).toBe("likely_false");
    // A likely fact from a guess yields to a person's word.
    const guessed = { key: "lactose-free-options", status: "likely_false", source: "guess:cuisine", confidence: 0.55 };
    expect(applyAttestations("c1", [guessed], [row({ confidence: 0.9 })])[0]).toMatchObject({ status: "verified_true", source: "agent:p_sarah" });
  });

  it("creates the fact when the dossier had no row for it", () => {
    const out = applyAttestations("c1", [], [row({ key: "dog-friendly" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "dog-friendly", status: "verified_true", source: "agent:p_sarah" });
  });

  it("only ever emits the five statuses", () => {
    const cases = [
      applyAttestations("c1", [unknown], [row({})]),
      applyAttestations("c1", [osmNo], [row({})]),
      applyAttestations("c1", [unknown], [row({}), row({ participant_id: "p_joe", status: "verified_false" })]),
    ].flat();
    for (const a of cases) {
      expect(["verified_true", "likely_true", "likely_false", "verified_false", "unknown"]).toContain(a.status);
    }
  });
});

describe("attested facts and the classifier", () => {
  const candidate = (attributes: CandidateRow["attributes"]): CandidateRow => ({
    id: "c1",
    name: "X",
    category: "cafe",
    price_level: null,
    walk_min: 5,
    location: { lat: 0, lng: 0 },
    attributes,
  });
  const need: RequirementRow = {
    id: "r1",
    owner_id: "p_joe",
    visibility: "shared",
    hardness: "hard",
    payload: { kind: "attribute", key: "lactose-free-options", expect: "verified_true" },
    withdrawn: false,
  };

  it("an attestation over an unknown fact makes the place eligible; a dispute keeps it unsure", () => {
    const before = classifyAll([candidate([unknown])], [need], [], null);
    expect(before[0].eligibility).toBe("uncertain");
    const attested = classifyAll(
      [candidate(applyAttestations("c1", [unknown], [row({})]))],
      [need], [], null,
    );
    expect(attested[0].eligibility).toBe("eligible");
    const disputed = classifyAll(
      [candidate(applyAttestations("c1", [osmNo], [row({})]))],
      [need], [], null,
    );
    expect(disputed[0].eligibility).toBe("uncertain");
  });
});

import { describe, expect, it } from "vitest";
import { COMMAND_TYPES, type CommandType } from "@webmcp-hackathon/contracts";
import {
  PHASES,
  PHASE_GATES,
  availableCommands,
  isCommandLegal,
  isDecided,
  nextPhase,
  type Phase,
} from "../../apps/server/src/phase.ts";

/** Lane 1: the session phase machine and its gating table (§7.1). */

describe("phase transitions", () => {
  it("walks the demo trajectory: gathering → deliberation → agreed → arrival", () => {
    let phase: Phase = "gathering";
    phase = nextPhase(phase, ["requirement_submitted", "candidates_updated"]);
    expect(phase).toBe("gathering");
    phase = nextPhase(phase, ["impasse_detected", "adjustment_proposed"]);
    expect(phase).toBe("deliberation");
    phase = nextPhase(phase, ["proposal_created"]);
    expect(phase).toBe("deliberation");
    phase = nextPhase(phase, ["agreement_committed", "proposal_withdrawn"]);
    expect(phase).toBe("agreed");
    phase = nextPhase(phase, ["arrival_plan_updated"]);
    expect(phase).toBe("arrival");
  });

  it("enters deliberation on a first proposal without an impasse", () => {
    expect(nextPhase("gathering", ["proposal_created"])).toBe("deliberation");
  });

  it("chains several triggers inside one command", () => {
    // A room seeded in setup that joins, proposes, and commits in one go.
    expect(
      nextPhase("setup", [
        "participant_joined",
        "proposal_created",
        "agreement_committed",
      ]),
    ).toBe("agreed");
  });

  it("never runs backwards and ignores unrelated events", () => {
    expect(nextPhase("deliberation", ["impasse_detected"])).toBe("deliberation");
    expect(nextPhase("arrival", ["agreement_committed"])).toBe("arrival");
    expect(nextPhase("agreed", ["requirement_withdrawn"])).toBe("agreed");
    expect(nextPhase("gathering", [])).toBe("gathering");
  });

  it("treats agreed, arrival, and closed as decided", () => {
    expect(PHASES.filter(isDecided)).toEqual(["agreed", "arrival", "closed"]);
  });
});

describe("phase gating table", () => {
  it("covers every command in the registry", () => {
    expect(Object.keys(PHASE_GATES).sort()).toEqual([...COMMAND_TYPES].sort());
    for (const [type, phases] of Object.entries(PHASE_GATES)) {
      expect(phases.length, type).toBeGreaterThan(0);
      for (const phase of phases) expect(PHASES).toContain(phase);
    }
  });

  it("closes negotiation once the destination is decided", () => {
    const negotiation: CommandType[] = [
      "SubmitRequirement", "WithdrawRequirement", "EvaluateCandidates",
      "RespondToProposal", "SetSearchScope", "ProposeDestination",
      "ResolvePrivateRequest", "ConfirmPrivateRequest", "ConfirmAgreement",
      "CommitAgreement",
    ];
    for (const type of negotiation) {
      expect(isCommandLegal(type, "agreed"), type).toBe(false);
      expect(isCommandLegal(type, "arrival"), type).toBe(false);
    }
  });

  it("opens arrival planning only once a destination is agreed", () => {
    expect(isCommandLegal("PlanArrival", "gathering")).toBe(false);
    expect(isCommandLegal("PlanArrival", "deliberation")).toBe(false);
    expect(isCommandLegal("PlanArrival", "agreed")).toBe(true);
    expect(isCommandLegal("PlanArrival", "arrival")).toBe(true);
  });

  it("stages and commits agreement in deliberation only — the phase a proposal creates", () => {
    for (const type of ["ConfirmAgreement", "CommitAgreement"] as CommandType[]) {
      expect(PHASE_GATES[type]).toEqual(["deliberation"]);
    }
  });

  it("accepts no command at all once closed", () => {
    expect(availableCommands("closed")).toEqual([]);
  });

  it("reports what is available for the phase_unavailable recovery string", () => {
    // Registry order, so the recovery string reads the same way every time.
    expect(availableCommands("arrival")).toEqual(["SetReadyState", "SetOrigin", "PlanArrival"]);
    expect(availableCommands("gathering")).toContain("SubmitRequirement");
    expect(availableCommands("gathering")).not.toContain("PlanArrival");
  });
});

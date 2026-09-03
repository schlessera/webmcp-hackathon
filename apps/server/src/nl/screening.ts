import type { Participant } from "../auth.ts";
import { config } from "../config.ts";
import { submitCommand } from "../engine.ts";
import { inspectCandidates } from "../spatial.ts";
import { parseJson, respondPrivate } from "./llm.ts";

/**
 * Agent-private screening (the L0 loop): the condition lives with the agent,
 * the room receives verdicts only. Judging evidence against a person's
 * private condition is exactly where a wrong call costs the most — a place
 * wrongly ruled out never comes back into view — so this runs on the smart
 * tier, and it is told to prefer needs_info over a guess.
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "verdict"],
        properties: {
          candidateId: { type: "string" },
          verdict: { type: "string", enum: ["acceptable", "unacceptable", "needs_info"] },
        },
      },
    },
  },
};

interface Draft {
  verdicts: Array<{ candidateId: string; verdict: "acceptable" | "unacceptable" | "needs_info" }>;
}

export interface ScreeningOutcome {
  screened: number;
  unacceptable: number;
  ms: number;
}

export async function screen(
  actor: Participant,
  condition: string,
  candidateIds: string[],
  /** Still the condition to screen against? Checked after the model answers
   * and before anything is written: a superseded run writes nothing. */
  isCurrent: () => boolean = () => true,
): Promise<ScreeningOutcome> {
  const started = Date.now();
  const ids = candidateIds.slice(0, 10);
  const dossiers = await inspectCandidates(actor, ids);
  if (!dossiers.ok) return { screened: 0, unacceptable: 0, ms: Date.now() - started };

  const mapRevisions = new Map(
    dossiers.candidates.map((d) => [d.candidateId, d.mapRevision]),
  );
  const rows = dossiers.candidates.map((d) => ({
    candidateId: d.candidateId,
    name: d.name,
    category: d.category,
    priceLevel: d.priceLevel,
    facts: d.attributes.map(
      (a) => `${a.key}: ${a.status}${a.value !== undefined ? ` (${String(a.value)})` : ""}`,
    ),
  }));

  const turn = await respondPrivate({
    model: config.llmJudgeModel,
    intent: "interactive",
    instructions: [
      `You screen places for one person against a condition they told you in confidence: "${condition}".`,
      "For each place, answer exactly one of:",
      "- unacceptable: the facts on record, or the condition itself (for example a place it names), make the place clearly fail the condition;",
      "- acceptable: the facts on record clearly satisfy it, or the condition plainly does not concern anything a place could fail on;",
      "- needs_info: the record does not say. Prefer this over a guess — a place wrongly ruled out never comes back.",
      "'unknown' or 'unverified' facts are not evidence either way. Return one verdict per candidateId, all of them, and nothing else.",
    ].join("\n"),
    input: [{ role: "user", content: JSON.stringify(rows) }],
    schema: { name: "screening", schema: SCHEMA },
    reasoning: config.llmReasoningEffort,
    maxOutputTokens: 1_300,
    timeoutMs: 90_000,
  });
  const draft = parseJson<Draft>(turn.text);
  const known = new Set(ids);
  const verdicts = (draft?.verdicts ?? []).filter((v) => known.has(v.candidateId));
  // Every asked id gets an answer: silence from the model reads as needs_info.
  for (const id of ids) {
    if (!verdicts.some((v) => v.candidateId === id)) {
      verdicts.push({ candidateId: id, verdict: "needs_info" });
    }
  }
  if (!isCurrent()) return { screened: 0, unacceptable: 0, ms: Date.now() - started };
  const result = await submitCommand(actor, "EvaluateCandidates", {
    // X2: the dossier revision is the state the model actually judged. A
    // lookup/attestation that commits after this read makes baseRevision
    // stale instead of silently rebasing the verdict onto newer facts.
    baseRevision: dossiers.revision,
    verdicts: verdicts.map((verdict) => ({
      ...verdict,
      screenedMapRevision: mapRevisions.get(verdict.candidateId),
    })),
  });
  return {
    screened: result.ok ? verdicts.length : 0,
    unacceptable: verdicts.filter((v) => v.verdict === "unacceptable").length,
    ms: Date.now() - started,
  };
}

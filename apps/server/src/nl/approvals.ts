import { randomBytes } from "node:crypto";
import { pool } from "../db.ts";
import type { Participant } from "../auth.ts";
import { submitCommand, validateCommandInput } from "../engine.ts";

export interface PendingAgentAction {
  id: string;
  title: string;
  details: Array<{ label: string; value: string }>;
  expiresAt: string;
}

const TITLES: Record<string, string> = {
  SubmitRequirement: "Add or change your requirement", WithdrawRequirement: "Withdraw your requirement",
  SetRequirementActive: "Change whether your requirement applies", EvaluateCandidates: "Change your place verdicts",
  RespondToProposal: "Respond to a proposed place", ResolvePrivateRequest: "Respond to a private request",
  SetReadyState: "Change your ready state", SetOrigin: "Change your starting point",
  ConfirmAgreement: "Stage an agreement", SetSearchScope: "Change the search area",
  AddCandidates: "Add places to the room", ProposeDestination: "Propose a place",
  PlanArrival: "Change your arrival plan", AttestAttribute: "Share evidence about a place",
  ConfirmFact: "Confirm a fact for this room",
};

export async function stageAgentAction(
  actor: Participant, command: string, input: Record<string, unknown>,
  names: Map<string, string>,
): Promise<PendingAgentAction | null> {
  if (!Object.hasOwn(TITLES, command) || !validateCommandInput(command, input)) return null;
  const details: PendingAgentAction["details"] = [];
  const visit = (value: unknown, path: string) => {
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path} / ${key}` : key);
    } else {
      details.push({
        label: path.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " "),
        value: typeof value === "string" ? (names.get(value) ?? value) : JSON.stringify(value),
      });
    }
  };
  for (const [key, value] of Object.entries(input)) if (key !== "baseRevision") visit(value, key);
  const id = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  // One current proposal per participant; an old card cannot approve a newer
  // model suggestion. Staging never changes the revisioned room.
  await pool.query("DELETE FROM nl_pending_actions WHERE participant_id = $1 OR expires_at < now()", [actor.id]);
  await pool.query(
    "INSERT INTO nl_pending_actions (id, participant_id, command, input, expires_at) VALUES ($1, $2, $3, $4, $5)",
    [id, actor.id, command, input, expiresAt],
  );
  return { id, title: TITLES[command], details, expiresAt };
}

export async function approveAgentAction(actor: Participant, id: string) {
  const row = (await pool.query(
    `UPDATE nl_pending_actions SET consumed_at = now()
     WHERE id = $1 AND participant_id = $2 AND expires_at > now() AND consumed_at IS NULL
     RETURNING command, input`, [id, actor.id],
  )).rows[0] as { command: string; input: Record<string, unknown> } | undefined;
  if (!row) return {
    ok: false as const,
    error: { code: "not_found", message: "This suggestion expired or was already reviewed.", recovery: "Ask again for a fresh suggestion." },
  };
  // The original revision and exact stored arguments are authoritative.
  // Ordinary ownership, role, schema and additional consent checks still run.
  return submitCommand(actor, row.command, row.input);
}

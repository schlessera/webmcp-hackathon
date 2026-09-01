import { useState } from "react";
import type { CommandEnvelope } from "../spatial-types.ts";
import type { KnownRequirement } from "../requirements.ts";

/**
 * "Needs": the room's requirement list as this viewer is allowed to see it
 * (reconstructed from projected events — peers' private needs appear only as
 * the redacted lines the server sent), plus the add-a-need form. Visibility is
 * a first-class choice with plain-language consequences.
 */

const NEED_KINDS = [
  { id: "vegetarian-options", label: "Vegetarian options", kind: "attribute" },
  { id: "lactose-free-options", label: "Lactose-free options", kind: "attribute" },
  { id: "wheelchair-accessible", label: "Wheelchair accessible", kind: "attribute" },
  { id: "outdoor-seating", label: "Outdoor seating", kind: "attribute" },
  { id: "dog-friendly", label: "Dog-friendly", kind: "attribute" },
  { id: "budget", label: "Budget per person (€)", kind: "budget" },
  { id: "exclude-cuisine", label: "Avoid a cuisine", kind: "exclusion" },
  { id: "max-walk", label: "Max walk (minutes)", kind: "scope" },
] as const;

const VISIBILITY_NOTES: Record<string, string> = {
  shared: "Everyone in the room sees this need and that it is yours.",
  "application-private":
    "Only the council evaluates it. Others see just its effect on the map.",
  "agent-private":
    "Never leaves your agent. The room only learns a constraint exists.",
};

const CUISINES = ["italian", "asian", "german", "burger", "indian", "mexican"];

interface Props {
  requirements: KnownRequirement[];
  ownDisplayName: string;
  /** Requirements are only editable while the room is still deciding. */
  phase: string;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

export function RequirementsPanel({
  requirements,
  ownDisplayName,
  phase,
  run,
}: Props) {
  const [need, setNeed] = useState<(typeof NEED_KINDS)[number]["id"]>("vegetarian-options");
  const [visibility, setVisibility] = useState("shared");
  const [hardness, setHardness] = useState<"hard" | "soft">("hard");
  const [amount, setAmount] = useState(15);
  const [cuisine, setCuisine] = useState("italian");
  const [walkMax, setWalkMax] = useState(15);

  const submit = () => {
    const meta = NEED_KINDS.find((k) => k.id === need)!;
    let payload: Record<string, unknown>;
    switch (meta.kind) {
      case "attribute":
        payload = { kind: "attribute", key: meta.id, expect: "verified_true" };
        break;
      case "budget":
        payload = { kind: "budget", perPersonMax: { amount, currency: "EUR" } };
        break;
      case "exclusion":
        payload = { kind: "exclusion", key: "cuisine", values: [cuisine], lifetime: "session" };
        break;
      case "scope":
        payload = { kind: "scope", dimension: "walk_min", max: walkMax };
        break;
    }
    if (visibility === "agent-private") {
      // Declaration only: content never reaches the server (§5.3).
      void run("SubmitRequirement", {
        visibility,
        hardness,
        delegation: { mode: "approval_required" },
        scopeHint: { affects: "candidate-eligibility" },
      });
      return;
    }
    void run("SubmitRequirement", {
      visibility,
      hardness,
      delegation: { mode: hardness === "soft" ? "soft" : "approval_required" },
      payload,
    });
  };

  const mine = (r: KnownRequirement) =>
    r.text.startsWith("You ") || r.text.includes(ownDisplayName);
  // Past deliberation the server refuses requirement edits (phase gating,
  // NEGOTIATION-PROTOCOL.md §7.1); don't offer a control that cannot work.
  const editable = phase === "gathering" || phase === "deliberation";

  return (
    <div>
      {requirements.length > 0 ? (
        <ul className="req-list" data-testid="req-list">
          {requirements.map((r) => (
            <li className="req-item" key={r.key}>
              <span className="req-text">{r.text}</span>
              {r.visibility && (
                <span
                  className={`badge badge-${
                    r.visibility === "application-private"
                      ? "app-private"
                      : r.visibility === "agent-private"
                        ? "agent-private"
                        : "shared"
                  }`}
                >
                  {r.visibility === "application-private"
                    ? "private"
                    : r.visibility === "agent-private"
                      ? "agent-only"
                      : "shared"}
                </span>
              )}
              {r.hardness && (
                <span className={`badge badge-${r.hardness}`}>{r.hardness}</span>
              )}
              {r.withdrawn ? (
                <span className="badge badge-soft">withdrawn</span>
              ) : (
                editable &&
                r.requirementId &&
                mine(r) && (
                  <button
                    className="btn"
                    style={{ padding: "1px 8px", fontSize: 12 }}
                    onClick={() =>
                      void run("WithdrawRequirement", { requirementId: r.requirementId! })
                    }
                  >
                    Withdraw
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-note">
          No needs yet. Add what matters to you — dietary, budget, distance — and
          choose who gets to see it.
        </p>
      )}

      {!editable ? (
        <p className="empty-note" data-testid="req-form-closed">
          The destination is settled — needs are closed for this room.
        </p>
      ) : (
        <div className="req-form" data-testid="req-form">
          <h3>Add a need</h3>
          <div className="form-row">
            <select
              aria-label="Need"
              data-testid="need-select"
              value={need}
              onChange={(e) => setNeed(e.target.value as typeof need)}
            >
              {NEED_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            {need === "budget" && (
              <input
                type="number"
                aria-label="Euro per person"
                min={5}
                max={100}
                value={amount}
                data-testid="budget-input"
                onChange={(e) => setAmount(Number(e.target.value))}
                style={{ width: 70 }}
              />
            )}
            {need === "exclude-cuisine" && (
              <select
                aria-label="Cuisine to avoid"
                data-testid="cuisine-select"
                value={cuisine}
                onChange={(e) => setCuisine(e.target.value)}
              >
                {CUISINES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            {need === "max-walk" && (
              <input
                type="number"
                aria-label="Max walk minutes"
                min={5}
                max={60}
                value={walkMax}
                onChange={(e) => setWalkMax(Number(e.target.value))}
                style={{ width: 70 }}
              />
            )}
          </div>
          <div className="form-row">
            <label>Who sees it?</label>
            <div className="seg" role="group" aria-label="Visibility">
              {(["shared", "application-private", "agent-private"] as const).map((v) => (
                <button
                  key={v}
                  aria-pressed={visibility === v}
                  data-testid={`visibility-${v}`}
                  onClick={() => setVisibility(v)}
                >
                  {v === "shared" ? "Shared" : v === "application-private" ? "Private" : "Agent-only"}
                </button>
              ))}
            </div>
          </div>
          <div className="visibility-note">{VISIBILITY_NOTES[visibility]}</div>
          <div className="form-row">
            <label>How firm?</label>
            <div className="seg" role="group" aria-label="Hardness">
              <button aria-pressed={hardness === "hard"} onClick={() => setHardness("hard")}>
                Must have
              </button>
              <button aria-pressed={hardness === "soft"} onClick={() => setHardness("soft")}>
                Nice to have
              </button>
            </div>
            <button className="btn btn-primary" data-testid="add-need" onClick={submit}>
              Add need
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

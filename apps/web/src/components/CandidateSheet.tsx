import { useEffect, useState } from "react";
import { spatialInspectRaw } from "../api.ts";
import type {
  CandidateDossier,
  CandidateSummary,
  CommandEnvelope,
  ProposalView,
} from "../spatial-types.ts";

/**
 * Bottom sheet for the selected candidate. Every negotiation-meaningful action
 * here dispatches the same commands an agent's tools produce (one command
 * model, two entry surfaces): propose → ProposeDestination, veto/accept →
 * RespondToProposal against the candidate's proposal.
 */

const VETO_REASONS = [
  { label: "Visited too recently", payload: { kind: "history", note: "visited too recently" } },
  { label: "Too far for me", payload: { kind: "history", note: "too far" } },
  { label: "Not my taste", payload: { kind: "history", note: "not my taste" } },
];

const ATTRIBUTE_LABELS: Record<string, string> = {
  "vegetarian-options": "vegetarian",
  "lactose-free-options": "lactose-free",
  "wheelchair-accessible": "wheelchair",
  "outdoor-seating": "outdoor seating",
  "dog-friendly": "dog-friendly",
};

const STATUS_GLYPH: Record<string, string> = {
  verified_true: "✓",
  verified_false: "✗",
  unverified: "?",
  unknown: "?",
};

interface Props {
  candidate: CandidateSummary;
  proposal: ProposalView | undefined;
  phase: string;
  onClose(): void;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

export function CandidateSheet({ candidate, proposal, phase, onClose, run }: Props) {
  const [vetoOpen, setVetoOpen] = useState(false);
  const [customReason, setCustomReason] = useState("");
  const [dossier, setDossier] = useState<CandidateDossier | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    setVetoOpen(false);
    setShowDetails(false);
    setDossier(null);
    let cancelled = false;
    void (async () => {
      // The contract's InspectCandidatesResult returns the dossier array as
      // `candidates` (matching the server), not `dossiers`.
      const result = (await spatialInspectRaw({
        candidateIds: [candidate.candidateId],
      })) as { ok?: boolean; candidates?: CandidateDossier[] };
      if (!cancelled && result.ok && result.candidates?.[0]) {
        setDossier(result.candidates[0]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [candidate.candidateId]);

  const stance = (disposition: string, reason?: unknown) => {
    if (!proposal) return;
    void run("RespondToProposal", {
      proposalId: proposal.proposalId,
      disposition,
      visibility: "shared",
      ...(reason ? { reason } : {}),
    });
    setVetoOpen(false);
  };

  const attributes = dossier?.attributes?.filter((a) => ATTRIBUTE_LABELS[a.key]) ?? [];
  const negotiable = phase === "gathering" || phase === "deliberation";

  return (
    <div className="candidate-sheet" data-testid="candidate-sheet">
      <div className="sheet-head">
        <span className="sheet-title" data-testid="sheet-name">{candidate.name}</span>
        <span className="sheet-meta">
          {candidate.category} · {"€".repeat(candidate.priceLevel ?? 0) || "€?"} ·{" "}
          {candidate.walkMin} min walk
        </span>
        <button className="sheet-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <p className="sheet-why" data-eligibility={candidate.eligibility} data-testid="sheet-why">
        {candidate.why ??
          (candidate.eligibility === "eligible" ? "Meets every confirmed need." : "")}
      </p>
      {attributes.length > 0 && (
        <div className="attr-chips">
          {attributes.map((a) => (
            <span className="attr-chip" data-status={a.status} key={a.key}>
              {STATUS_GLYPH[a.status]} {ATTRIBUTE_LABELS[a.key]}
            </span>
          ))}
        </div>
      )}
      <div className="sheet-actions">
        {negotiable && !proposal && (
          <button
            className="btn btn-primary"
            data-testid="propose-btn"
            onClick={() => void run("ProposeDestination", { candidateId: candidate.candidateId })}
          >
            Propose this
          </button>
        )}
        {negotiable && proposal && (proposal.status === "open" || proposal.status === "vetoed") && (
          <>
            <button className="btn btn-accept" data-testid="accept-btn" onClick={() => stance("accept")}>
              Works for me
            </button>
            <button
              className="btn btn-danger"
              data-testid="veto-btn"
              onClick={() => setVetoOpen((v) => !v)}
              aria-expanded={vetoOpen}
            >
              Veto…
            </button>
          </>
        )}
        <button className="btn" onClick={() => setShowDetails((v) => !v)} data-testid="details-btn">
          {showDetails ? "Hide details" : "Details"}
        </button>
      </div>
      {vetoOpen && (
        <div className="veto-menu" data-testid="veto-menu">
          {VETO_REASONS.map((r) => (
            <button key={r.label} className="btn" onClick={() => stance("reject", r.payload)}>
              {r.label}
            </button>
          ))}
          <div className="form-row">
            <input
              type="text"
              maxLength={200}
              placeholder="Another reason (optional, shared)"
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
            />
            <button
              className="btn btn-danger"
              onClick={() =>
                stance(
                  "reject",
                  customReason ? { kind: "history", note: customReason } : undefined,
                )
              }
            >
              Veto
            </button>
          </div>
        </div>
      )}
      {showDetails && dossier && (
        <div className="veto-menu" data-testid="dossier-details">
          {dossier.attributes.map((a) => (
            <div key={a.key} style={{ fontSize: 12, color: "var(--ink-soft)" }}>
              <strong>{a.key}</strong>
              {a.value !== undefined ? ` = ${String(a.value)}` : ""} — {a.status}{" "}
              <span style={{ color: "var(--ink-faint)" }}>
                ({a.source}, {a.observedAt.slice(0, 10)}, conf {a.confidence})
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

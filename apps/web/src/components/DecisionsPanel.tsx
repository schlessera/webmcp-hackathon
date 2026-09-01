import { spatial } from "../spatial-store.ts";
import type {
  CommandEnvelope,
  OutstandingAdjustment,
  OutstandingItem,
  ProposalView,
  SpatialContext,
} from "../spatial-types.ts";

/**
 * "Decisions": everything pending for THIS participant — private adjustment
 * requests from the council, screening batches for the agent, stances still
 * owed, and (for the organizer) agreement staging + the in-page commit.
 * Grants that exceed delegated authority stage first and are confirmed here,
 * on the page — never by an agent alone.
 */

/** Stances arrive per participant now; peers' private ones read "none". */
const acceptCount = (p: ProposalView) =>
  p.stances.filter((s) => s.stance === "accept").length;

function describeAdjustment(item: OutstandingAdjustment): string {
  const change = item.change as { dimension?: string; from?: unknown; to?: unknown };
  const gain = item.projectedGain?.newCandidates;
  const gainText = gain !== undefined ? ` Adds ~${gain} candidate${gain === 1 ? "" : "s"}.` : "";
  if (change.dimension === "radius_m") {
    return `Widen the search area from ${String(change.from)} m to ${String(change.to)} m?${gainText}`;
  }
  if (change.dimension === "per_person_eur") {
    return `Raise the budget from €${String(change.from)} to €${String(change.to)} per person?${gainText}`;
  }
  return `Apply a ${item.kind.replace(/_/g, " ")}: ${JSON.stringify(change)}.${gainText}`;
}

interface Props {
  context: SpatialContext;
  outstanding: OutstandingItem[];
  isOrganizer: boolean;
  candidateName(candidateId: string): string;
  onSelectCandidate(candidateId: string): void;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

export function DecisionsPanel({
  context,
  outstanding,
  isOrganizer,
  candidateName,
  onSelectCandidate,
  run,
}: Props) {
  // A grant beyond the delegated bound succeeds (ok:true) and comes back as
  // an outstanding adjustment with staged:true — the result's refreshed
  // outstanding list is the single source for the confirm card below.
  const resolve = (requestId: string, decision: "grant" | "deny") =>
    run("ResolvePrivateRequest", { requestId, decision });

  // The two applying commands carry the single-use nonce the server pushed to
  // this page's realtime channel when the stage happened — the page gesture is
  // the only place it exists (INTERACTION-AND-BINDING.md §5.4).
  const confirmStaged = async (requestId: string) =>
    run("ConfirmPrivateRequest", {
      requestId,
      confirmationNonce: await spatial.takeConfirmation(
        "private_request",
        requestId,
      ),
    });

  const commitAgreement = async (proposalId: string) =>
    run("CommitAgreement", {
      proposalId,
      confirmationNonce: await spatial.takeConfirmation("agreement", proposalId),
    });

  const adjustments = outstanding.filter(
    (i): i is OutstandingAdjustment => i.type === "adjustment_request",
  );
  const evaluations = outstanding.filter((i) => i.type === "evaluation_request");
  const openProposals = context.proposals.filter((p) => p.status === "open");
  // Derived from the spatial context (live over WS) rather than the sync-time
  // outstanding list, so a passive viewer's card appears the moment a peer
  // proposes.
  const stancesNeeded = openProposals.filter((p) => !p.ownStance);
  const stagedProposals = context.proposals.filter((p) => p.status === "staged");
  const deliberating = context.phase === "gathering" || context.phase === "deliberation";

  const empty =
    adjustments.length === 0 &&
    evaluations.length === 0 &&
    stancesNeeded.length === 0 &&
    stagedProposals.length === 0 &&
    !(isOrganizer && deliberating && openProposals.length > 0);

  return (
    <div data-testid="decisions-panel">
      {adjustments.map((item) =>
        item.staged ? (
          // Granted beyond the delegated bound: applies only after this
          // in-page confirmation (an agent cannot take this step).
          <div
            className="decision-card decision-confirm"
            data-testid="confirm-card"
            key={item.requestId}
          >
            <h4>Confirm on this page</h4>
            <p>
              {describeAdjustment(item)} You granted this beyond what you delegated —
              it applies once you confirm here.
            </p>
            <div className="decision-actions">
              <button
                className="btn btn-primary"
                data-testid="confirm-grant"
                onClick={() => void confirmStaged(item.requestId)}
              >
                Confirm
              </button>
              <button
                className="btn"
                data-testid={`deny-${item.requestId}`}
                onClick={() => void resolve(item.requestId, "deny")}
              >
                Cancel the grant
              </button>
            </div>
          </div>
        ) : (
          <div
            className="decision-card decision-private"
            data-testid="adjustment-card"
            key={item.requestId}
          >
            <h4>
              Private request <span className="badge badge-app-private">only you see this</span>
            </h4>
            <p>{describeAdjustment(item)}</p>
            <div className="decision-actions">
              <button
                className="btn btn-primary"
                data-testid={`grant-${item.requestId}`}
                onClick={() => void resolve(item.requestId, "grant")}
              >
                {item.withinDelegatedBound ? "Accept" : "Accept…"}
              </button>
              <button
                className="btn"
                data-testid={`deny-${item.requestId}`}
                onClick={() => void resolve(item.requestId, "deny")}
              >
                Decline
              </button>
            </div>
          </div>
        ),
      )}

      {evaluations.map((item, index) => (
        <div className="decision-card" key={`eval-${index}`}>
          <h4>
            Agent screening <span className="badge badge-agent-private">agent-only</span>
          </h4>
          <p>
            Your agent has{" "}
            {(item as { candidateIds?: string[] }).candidateIds?.length ?? "some"} candidates to
            screen against your private need. Ask your ChatGPT to evaluate them.
          </p>
        </div>
      ))}

      {stancesNeeded.map((proposal) => {
        const proposalId = proposal.proposalId;
        return (
          <div className="decision-card" data-testid="stance-card" key={proposalId}>
            <h4>Your call: {candidateName(proposal.candidateId)}</h4>
            <p>
              {acceptCount(proposal)} in favor
              {proposal.vetoStands ? " · a veto stands" : ""}
            </p>
            <div className="decision-actions">
              <button
                className="btn btn-accept"
                data-testid="stance-accept"
                onClick={() =>
                  void run("RespondToProposal", {
                    proposalId,
                    disposition: "accept",
                    visibility: "shared",
                  })
                }
              >
                Works for me
              </button>
              <button
                className="btn"
                data-testid="stance-look"
                onClick={() => onSelectCandidate(proposal.candidateId)}
              >
                Look at it
              </button>
            </div>
          </div>
        );
      })}

      {isOrganizer &&
        deliberating &&
        openProposals.map((p) => (
          <div className="decision-card" data-testid="stage-card" key={p.proposalId}>
            <h4>Stage the agreement?</h4>
            <p>
              {candidateName(p.candidateId)} — {acceptCount(p)} in favor
              {p.vetoStands ? ", a veto stands" : ""}. Staging checks that everyone is ready
              and no veto stands.
            </p>
            <div className="decision-actions">
              <button
                className="btn btn-primary"
                data-testid={`stage-${p.proposalId}`}
                onClick={() => void run("ConfirmAgreement", { proposalId: p.proposalId })}
              >
                Stage agreement
              </button>
            </div>
          </div>
        ))}

      {stagedProposals.map((p) => (
        <div className="decision-card decision-confirm" data-testid="commit-card" key={p.proposalId}>
          <h4>Agreement staged: {candidateName(p.candidateId)}</h4>
          {isOrganizer ? (
            <>
              <p>Final step — committing locks the destination for the whole room.</p>
              <div className="decision-actions">
                <button
                  className="btn btn-gold"
                  data-testid={`commit-${p.proposalId}`}
                  onClick={() => void commitAgreement(p.proposalId)}
                >
                  Commit destination
                </button>
              </div>
            </>
          ) : (
            <p>Waiting for the organizer to commit.</p>
          )}
        </div>
      ))}

      {empty && (
        <p className="empty-note" data-testid="decisions-empty">
          Nothing needs your decision right now. The council will put private requests
          here when they concern you.
        </p>
      )}
    </div>
  );
}

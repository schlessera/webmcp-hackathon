import { useEffect, useRef } from "react";
import { spatial } from "../spatial-store.ts";
import type {
  CommandEnvelope,
  OutstandingAdjustment,
  OutstandingItem,
  ProposalView,
  SpatialContext,
} from "../spatial-types.ts";
import { joinNames, numberWord } from "../ui/copy.ts";

/**
 * Consent — three rungs of authority, and the ladder must read as authority,
 * so all three are `--spoke-act`: in every case an agent moved. Scope badges
 * inside them stay `--spoke-scope`, because those are about who may see
 * (SPOKES-UI §7, CLAUDE.md §2).
 *
 *   1 · within the grant      act border + tint      Accept / Decline
 *   2 · beyond it, staged     act border + tint      Confirm / Cancel the grant
 *   3 · agent-only screening  surface + act shadow   status only
 *
 * A consent card is a decision, not a notification: nothing here dismisses on
 * an outside tap, and it is rendered in the brief's flow rather than as an
 * overlay.
 */

function metres(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)} km` : `${n} m`;
}

/** The boundary, stated numerically — that is what makes rung 2 a decision. */
/** "the €30 you delegated" when the wire names the ceiling; "what you
 * delegated" when it does not (scope changes carry no bound). */
function boundPhrase(item: OutstandingAdjustment): string {
  const b = item.delegatedBound;
  if (!b) return "what you delegated";
  const amount =
    b.dimension === "per_person_eur"
      ? `€${b.max}`
      : b.dimension === "radius_m"
        ? metres(b.max)
        : `${b.max} min`;
  return `the ${amount} you delegated`;
}

function describeChange(item: OutstandingAdjustment): string {
  const change = item.change as { dimension?: string; from?: unknown; to?: unknown };
  if (change.dimension === "radius_m") {
    return `Widen the area from ${metres(change.from)} to ${metres(change.to)}`;
  }
  if (change.dimension === "per_person_eur") {
    return `Raise what each person spends from €${String(change.from)} to €${String(change.to)}`;
  }
  if (change.dimension === "walk_min") {
    return `Stretch the walk from ${String(change.from)} to ${String(change.to)} minutes`;
  }
  return `Apply a change to ${String(change.dimension ?? item.kind).replace(/_/g, " ")}`;
}

function gainSentence(item: OutstandingAdjustment): string {
  const gain = item.projectedGain?.newCandidates;
  if (gain === undefined) return "";
  return ` Brings back ${gain} place${gain === 1 ? "" : "s"}.`;
}

/**
 * "Waiting on Sarah and Joe to finish adding · one hasn't said · a veto
 * stands." Names only for readiness (roster-public); the acceptance gap is a
 * count, so a private accept reads like silence (D1).
 */
function stagingWaitsOn(
  p: ProposalView,
  nameOf: (id: string) => string,
): string {
  const s = p.staging;
  if (!s) return "Staging checks that everyone is in and no veto stands.";
  const parts: string[] = [];
  if (s.vetoStands) parts.push("a veto stands");
  if (s.unaccepted > 0) {
    parts.push(
      s.unaccepted === 1 ? "one person hasn't said" : `${numberWord(s.unaccepted)} haven't said`,
    );
  }
  if (s.notReady.length > 0) {
    parts.push(`${joinNames(s.notReady.map(nameOf))} still adding`);
  }
  if (parts.length === 0) return "Staging checks that everyone is in and no veto stands.";
  return `Waiting: ${parts.join(" · ")}.`;
}

interface Props {
  context: SpatialContext;
  outstanding: OutstandingItem[];
  isOrganizer: boolean;
  candidateName(candidateId: string): string;
  onOpenCandidate(candidateId: string): void;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
  meId: string;
}

export function ConsentCards({
  context,
  outstanding,
  isOrganizer,
  candidateName,
  onOpenCandidate,
  run,
  meId,
}: Props) {
  const resolve = (requestId: string, decision: "grant" | "deny") =>
    run("ResolvePrivateRequest", { requestId, decision });

  // The two applying commands carry the single-use nonce the server pushed to
  // this page's realtime channel when the stage happened — the page gesture is
  // the only place it exists (INTERACTION-AND-BINDING.md §5.4).
  const confirmStaged = async (requestId: string) =>
    run("ConfirmPrivateRequest", {
      requestId,
      confirmationNonce: await spatial.takeConfirmation("private_request", requestId),
    });

  const commitAgreement = async (proposalId: string) =>
    run("CommitAgreement", {
      proposalId,
      confirmationNonce: await spatial.takeConfirmation("agreement", proposalId),
    });

  const nameOf = (id: string) =>
    id === meId
      ? "you"
      : (context.participants.find((p) => p.participantId === id)?.displayName ?? "someone");

  const adjustments = outstanding.filter(
    (i): i is OutstandingAdjustment => i.type === "adjustment_request",
  );
  // With the page's own agent holding the condition (server truth on the
  // item), screening is already happening; the need row's unknown count is
  // the honest state. An agent elsewhere still gets its card.
  const evaluations = outstanding.filter(
    (i) => i.type === "evaluation_request" && !i.heldByPageAgent,
  );
  const openProposals = context.proposals.filter((p) => p.status === "open");
  const stancesNeeded = openProposals.filter((p) => !p.ownStance);
  const staged = context.proposals.filter((p) => p.status === "staged");
  const deliberating =
    context.phase === "gathering" || context.phase === "deliberation";

  // A card that asks for a decision must not appear above an already-scrolled
  // brief where nobody sees it: whenever the set of cards changes, the brief
  // returns to the top. The identity key ignores re-renders of the same cards.
  const cardKey = [
    ...adjustments.map((a) => `${a.requestId}:${a.staged ? "s" : "p"}`),
    ...stancesNeeded.map((p) => `stance:${p.proposalId}`),
    ...staged.map((p) => `staged:${p.proposalId}`),
  ].join("|");
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!cardKey) return;
    sectionRef.current?.closest(".brief")?.scrollTo({ top: 0 });
  }, [cardKey]);

  const nothing =
    adjustments.length === 0 &&
    evaluations.length === 0 &&
    stancesNeeded.length === 0 &&
    staged.length === 0 &&
    !(isOrganizer && deliberating && openProposals.length > 0);
  if (nothing) return null;

  return (
    <section data-testid="consent" ref={sectionRef}>
      {adjustments.map((item) =>
        item.staged ? (
          <div className="card" data-tone="act" data-testid="confirm-card" key={item.requestId}>
            <div className="card-kicker">Confirm here to apply it</div>
            <div className="card-head">
              <span className="card-title">{describeChange(item)}?</span>
            </div>
            <div className="card-body">
              {item.delegatedBound
                ? `Beyond ${boundPhrase(item)}.`
                : "Nothing about this was delegated, so it is yours to decide."}
              {gainSentence(item)} Your agent staged it; only this gesture applies it.
            </div>
            <div className="card-actions">
              <button
                className="btn"
                data-tone="act"
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
          <div className="card" data-tone="act" data-testid="adjustment-card" key={item.requestId}>
            <div className="card-badges">
              <span className="badge" data-kind="scope">only you see this</span>
            </div>
            <div className="card-head">
              <span className="card-title">{describeChange(item)}?</span>
            </div>
            <div className="card-body">
              {gainSentence(item).trim()}
              {item.withinDelegatedBound
                ? ` Inside ${boundPhrase(item)}, so accepting applies it straight away.`
                : item.delegatedBound
                  ? ` Beyond ${boundPhrase(item)}, so accepting stages it for a second gesture here.`
                  : " Nothing about this was delegated, so accepting stages it for a second gesture here."}
            </div>
            <div className="card-actions">
              <button
                className="btn"
                data-tone="act"
                data-testid={`grant-${item.requestId}`}
                onClick={() => void resolve(item.requestId, "grant")}
              >
                Accept
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

      {/* Rung 3: two meanings coincide, so both marks are shown — violet for
          who may see, woad for who moved. Status, never a decision. */}
      {evaluations.map((item, index) => {
        const count = (item as { candidateIds?: string[] }).candidateIds?.length ?? 0;
        return (
          <div className="card" data-tone="acting" data-testid="screening-card" key={`eval-${index}`}>
            <div className="card-badges">
              <span className="badge" data-kind="scope">agent only</span>
              <span className="badge" data-kind="act">acting now</span>
            </div>
            <div className="card-head">
              <span className="card-title">
                Your agent has {count} place{count === 1 ? "" : "s"} to screen
              </span>
            </div>
            <div className="card-body">
              Against the condition it holds for you. Nothing about it reaches the
              room, or us.
            </div>
          </div>
        );
      })}

      {stancesNeeded.map((proposal) => (
        <div className="card" data-tone="act" data-testid="stance-card" key={proposal.proposalId}>
          <div className="card-kicker">Needs you</div>
          <div className="card-head">
            <span className="card-title">
              {candidateName(proposal.candidateId)} is on the table
            </span>
          </div>
          <div className="card-body">
            {proposal.stances.filter((s) => s.stance === "accept").length} in favour
            {proposal.vetoStands ? " · a veto stands" : ""}.
          </div>
          <div className="card-actions">
            <button
              className="btn"
              data-tone="works"
              data-testid="stance-accept"
              onClick={() =>
                void run("RespondToProposal", {
                  proposalId: proposal.proposalId,
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
              onClick={() => onOpenCandidate(proposal.candidateId)}
            >
              Look at it
            </button>
          </div>
        </div>
      ))}

      {/* The organizer's card is a decision only once the §3.7 precondition
          holds; until then it is status and says, by name where names are
          public, what staging waits on. */}
      {isOrganizer &&
        deliberating &&
        openProposals.map((p) => {
          const ready = p.staging?.ready ?? false;
          return (
            <div
              className="card"
              data-tone={ready ? "works" : undefined}
              data-testid="stage-card"
              data-ready={ready}
              key={p.proposalId}
            >
              <div className="card-head">
                <span className="card-title">
                  {ready
                    ? `Everyone is in on ${candidateName(p.candidateId)}`
                    : `Settle on ${candidateName(p.candidateId)}?`}
                </span>
              </div>
              <div className="card-body" data-testid="waits-on">
                {ready
                  ? "Staging sends it to you for one more confirmation, then it is settled for the whole room."
                  : stagingWaitsOn(p, nameOf)}
              </div>
              <div className="card-actions">
                <button
                  className="btn"
                  data-tone="works"
                  data-testid={`stage-${p.proposalId}`}
                  disabled={!ready}
                  onClick={() => void run("ConfirmAgreement", { proposalId: p.proposalId })}
                >
                  Stage it
                </button>
              </div>
            </div>
          );
        })}

      {staged.map((p) => (
        <div className="card" data-tone="act" data-testid="commit-card" key={p.proposalId}>
          <div className="card-kicker">Confirm here to apply it</div>
          <div className="card-head">
            <span className="card-title">
              {candidateName(p.candidateId)} is staged
            </span>
          </div>
          {isOrganizer ? (
            <>
              <div className="card-body">
                Committing settles it for the whole room.
              </div>
              <div className="card-actions">
                <button
                  className="btn"
                  data-tone="works"
                  data-testid={`commit-${p.proposalId}`}
                  onClick={() => void commitAgreement(p.proposalId)}
                >
                  Settle it
                </button>
              </div>
            </>
          ) : (
            <div className="card-body">Waiting for the organizer to settle it.</div>
          )}
        </div>
      ))}
    </section>
  );
}

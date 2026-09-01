import { useEffect, useState } from "react";
import { ATTRIBUTE_LABELS, PRICE_LEVEL_EUR } from "@webmcp-hackathon/contracts";
import { spatialInspectRaw } from "../api.ts";
import type {
  ActiveNeed,
  CandidateDossier,
  CandidateSummary,
  CommandEnvelope,
  ParticipantSummary,
  ProposalView,
} from "../spatial-types.ts";
import {
  COPY,
  attributeValue,
  initials,
  personColor,
  sourceLabel,
  UNKNOWN_SOURCE,
} from "../ui/copy.ts";

/**
 * Place details. A side panel that pushes the map ≥980px, a full-screen
 * takeover on phone — never a bottom sheet, because the map is the context
 * (SPOKES-UI §6).
 *
 * The panel is schema-driven: it renders whatever attribute rows the server
 * sends, in server order. There is no per-domain layout, and no invented icon
 * per attribute type — label and value in the type ramp.
 */

/** Need label → attribute key. The mapping is the contract manifest's own
 * (ATTRIBUTE_LABELS), so it is protocol, not a domain branch in the client. */
const LABEL_TO_KEY = new Map<string, string>(
  Object.entries(ATTRIBUTE_LABELS).map(([key, label]) => [label.toLowerCase(), key]),
);

function eurBand(level: number | null): string | null {
  const eur = level === null ? undefined : PRICE_LEVEL_EUR[level as 1 | 2 | 3 | 4];
  return eur === undefined ? null : `about €${eur} each`;
}

type Mark = "in" | "unknown" | "out" | "private";
const GLYPH: Record<Mark, string> = { in: "✓", unknown: "?", out: "✗", private: "●" };

interface Props {
  candidate: CandidateSummary;
  proposal: ProposalView | undefined;
  activeNeeds: ActiveNeed[];
  participants: ParticipantSummary[];
  meId: string;
  phase: string;
  onClose(): void;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

export function PlaceDetails({
  candidate,
  proposal,
  activeNeeds,
  participants,
  meId,
  phase,
  onClose,
  run,
}: Props) {
  const [dossier, setDossier] = useState<CandidateDossier | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setDossier(null);
    let cancelled = false;
    void (async () => {
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

  const eligible = candidate.eligibility === "eligible";
  const verdictState =
    candidate.eligibility === "eligible"
      ? "works"
      : candidate.eligibility === "uncertain"
        ? "unsure"
        : "out";

  /* One check row per stated need. Unknown is drawn, never treated as a
     failure and never silently dropped (CLAUDE.md §4). */
  const checks = activeNeeds
    .filter((n) => n.active)
    .map((n) => {
      if (n.visibility !== "shared") {
        return {
          id: n.id,
          mark: "private" as Mark,
          text: eligible
            ? "Passes the one private condition"
            : "Checked against a private condition",
          source: "checked, not shown",
        };
      }
      const key = LABEL_TO_KEY.get(n.label.toLowerCase());
      const attr = key ? dossier?.attributes.find((a) => a.key === key) : undefined;
      if (!attr) {
        return {
          id: n.id,
          mark: (eligible ? "in" : "unknown") as Mark,
          text: n.label,
          source: eligible ? "clears every stated need" : UNKNOWN_SOURCE,
        };
      }
      const mark: Mark =
        attr.status === "verified_true"
          ? "in"
          : attr.status === "verified_false"
            ? "out"
            : "unknown";
      return {
        id: n.id,
        mark,
        text: `${n.label} — ${attributeValue(attr.value, attr.status)}`,
        source: mark === "unknown" ? UNKNOWN_SOURCE : sourceLabel(attr.source),
      };
    });

  const stanceOf = (participantId: string) =>
    proposal?.stances.find((s) => s.participantId === participantId)?.stance ?? "none";

  const negotiable = phase === "gathering" || phase === "deliberation";
  const meta = [
    candidate.category,
    candidate.walkMin > 0 ? `${candidate.walkMin} min away` : null,
    // `priceLevel` is a 1–4 band, not an amount. PRICE_LEVEL_EUR is the
    // manifest's own band → per-person cap mapping, the same one the server
    // measures a budget need against, so both read the same number.
    eurBand(candidate.priceLevel),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <aside className="details" data-testid="place-details" aria-label={candidate.name}>
      <div className="details-nav">
        <button className="btn-text" data-testid="details-close" onClick={onClose}>
          Close
        </button>
        <span className="details-nav-title">{candidate.name}</span>
      </div>

      <div className="details-body">
        <div className="details-group">
          <div className="details-title">{candidate.name}</div>
          {meta && <div className="details-meta">{meta}</div>}
          {/* Verdict first: the reader's question is always "why is this here?" */}
          <div className="verdict" data-state={verdictState} data-testid="verdict">
            <span className="verdict-dot" aria-hidden="true" />
            <span className="verdict-text">
              {eligible ? COPY.verdictClears : candidate.why}
            </span>
          </div>
        </div>

        {checks.length > 0 && (
          <div className="details-group">
            <div className="group-heading">Against what the room asked</div>
            <div className="check-list">
              {checks.map((c) => (
                <div className="check-row" data-mark={c.mark} key={c.id}>
                  <span className="check-glyph" aria-hidden="true">{GLYPH[c.mark]}</span>
                  <span className="check-text">{c.text}</span>
                  <span className="check-source">{c.source}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {dossier && dossier.attributes.length > 0 && (
          <div className="details-group">
            <div className="group-heading">Also known about it</div>
            {/* Server order, verbatim. No invented icons, no reordering. */}
            {dossier.attributes.map((a) => (
              <div className="attr-row" data-status={a.status} key={a.key}>
                <span className="attr-key">
                  {ATTRIBUTE_LABELS[a.key as keyof typeof ATTRIBUTE_LABELS] ??
                    a.key.replace(/-/g, " ")}
                </span>
                <span className="attr-value">
                  {a.status === "unknown"
                    ? "?"
                    : a.key === "price-level"
                      ? (eurBand(Number(a.value)) ?? attributeValue(a.value, a.status))
                      : attributeValue(a.value, a.status)}{" "}
                  <span style={{ opacity: 0.7 }}>
                    · {a.status === "unknown" ? UNKNOWN_SOURCE : sourceLabel(a.source)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="details-group">
          <div className="group-heading">Where everyone stands</div>
          {participants.map((p, i) => {
            const stance = stanceOf(p.participantId);
            const you = p.participantId === meId;
            return (
              <div className="stand-row" data-stance={stance} key={p.participantId}>
                <span
                  className="stand-avatar"
                  style={{ background: personColor(i) }}
                  aria-hidden="true"
                >
                  {initials(p.displayName)}
                </span>
                <span className="stand-text">
                  {stance === "accept"
                    ? `${you ? "You are" : `${p.displayName} is`} in`
                    : stance === "veto"
                      ? `${you ? "You" : p.displayName} ruled it out`
                      : `${you ? "You haven't" : `${p.displayName} hasn't`} said`}
                </span>
                {stance === "accept" && (
                  <span className="stand-mark" aria-hidden="true">✓</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="details-actions">
        {negotiable && !proposal && (
          <button
            className="btn"
            data-tone="works"
            data-testid="propose-btn"
            onClick={() =>
              void run("ProposeDestination", { candidateId: candidate.candidateId })
            }
          >
            Put it forward
          </button>
        )}
        {negotiable && proposal && (proposal.status === "open" || proposal.status === "vetoed") && (
          <>
            <button
              className="btn"
              data-tone="works"
              data-testid="accept-btn"
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
              data-fit="hug"
              data-testid="veto-btn"
              onClick={() =>
                void run("RespondToProposal", {
                  proposalId: proposal.proposalId,
                  disposition: "reject",
                  visibility: "shared",
                })
              }
            >
              Rule it out
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

import { useEffect, useState } from "react";
import { ATTRIBUTE_LABELS, PRICE_LEVEL_EUR } from "@webmcp-hackathon/contracts";
import { spatialInspectRaw } from "../api.ts";
import type {
  ActiveNeed,
  CandidateDossier,
  CandidateSummary,
  CommandEnvelope,
  DossierAttribute,
  ParticipantSummary,
  PrivateEffect,
  ProposalView,
} from "../spatial-types.ts";
import {
  COPY,
  attributeValue,
  initials,
  numberWord,
  personColor,
  sourceLabel,
  UNKNOWN_SOURCE,
} from "../ui/copy.ts";

/**
 * Place details. A side panel that pushes the map ≥980px, a full-screen
 * takeover on phone — never a bottom sheet, because the map is the context
 * (SPOKES-UI §6).
 *
 * Three groups after the verdict, each answering one reader question:
 *   Does it fit        — one row per need the room stated: a mark, the need,
 *                        the answer in words. The marks are the map's own
 *                        dot vocabulary (filled works / hollow unsure / small
 *                        grey out / scope), never a glyph.
 *   Also on record     — the facts nobody asked about, as pills; unknowns
 *                        counted, not listed.
 *   Where everyone stands — per person, with the same marks.
 * Schema-driven: whatever attributes the server sends, in server order. No
 * per-domain layout, no invented icon per attribute type.
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

/** The mark vocabulary shared with the map: in = filled works dot, unknown =
 * hollow unsure ring, out = small grey dot, private = scope dot, silent =
 * ghost ring, veto = hollow act ring. */
type Mark = "in" | "unknown" | "out" | "private" | "silent" | "veto";

interface Check {
  id: string;
  mark: Mark;
  label: string;
  answer: string;
  source?: string;
}

/**
 * A need's own answer for one place, from the measure its label names:
 * true / false when the record can say, null when it cannot. Mirrors the
 * server's classifier (eligibility.ts) for the typed kinds the dossier has
 * no attribute for; free text is unverifiable by construction.
 */
function ownMeasure(
  label: string,
  candidate: CandidateSummary,
  dossier: CandidateDossier | null,
): boolean | null {
  const budget = /^budget €(\d+)$/.exec(label);
  if (budget) {
    const band =
      candidate.priceLevel === null
        ? undefined
        : PRICE_LEVEL_EUR[candidate.priceLevel as 1 | 2 | 3 | 4];
    return band === undefined ? null : band <= Number(budget[1]);
  }
  const walk = /^within (\d+) min walk$/.exec(label);
  if (walk) return candidate.walkMin <= Number(walk[1]);
  const avoid = /^avoid (.+)$/.exec(label);
  if (avoid) {
    if (!dossier) return null;
    const attr = dossier.attributes.find((a) => a.key === "cuisine");
    const tokens =
      typeof attr?.value === "string"
        ? attr.value.split(";").map((t) => t.trim()).filter(Boolean)
        : [candidate.category];
    const avoided = avoid[1].split(",").map((t) => t.trim());
    return !tokens.some((t) => avoided.includes(t));
  }
  return null;
}

/** The fixed, viewer-safe tokens eligibility.ts emits for a peer's private need. */
const PRIVATE_EXCLUDED = "excluded by a private requirement";
const PRIVATE_PENDING = "private evidence pending";

interface Props {
  candidate: CandidateSummary;
  proposal: ProposalView | undefined;
  activeNeeds: ActiveNeed[];
  privateEffects: PrivateEffect[];
  participants: ParticipantSummary[];
  meId: string;
  phase: string;
  /** participantId -> candidateId: who has which place open right now. */
  viewing: Record<string, string>;
  onClose(): void;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

export function PlaceDetails({
  candidate,
  proposal,
  activeNeeds,
  privateEffects,
  participants,
  meId,
  phase,
  viewing,
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
  /* One row per stated need. Unknown is drawn, never treated as a failure
     and never silently dropped (CLAUDE.md §4). A need with dossier evidence
     answers from the evidence; one without answers from the verdict. */
  const askedKeys = new Set<string>();
  const checks: Check[] = activeNeeds
    .filter((n) => n.active)
    .map((n): Check => {
      const own = n.ownerId === meId;
      const isPrivate = n.visibility !== "shared";
      const key = LABEL_TO_KEY.get(n.label.replace(/^no /, "").toLowerCase());
      const attr = key ? dossier?.attributes.find((a) => a.key === key) : undefined;
      if (attr && key) {
        askedKeys.add(key);
        const wantsAbsence = n.label.startsWith("no ");
        const verified = attr.status === "verified_true" || attr.status === "verified_false";
        const satisfied = verified && (attr.status === "verified_true") !== wantsAbsence;
        const mark: Mark = !verified ? "unknown" : satisfied ? "in" : "out";
        return {
          id: n.id,
          mark: isPrivate && mark === "in" ? "private" : mark,
          label: n.label,
          answer: mark === "unknown" ? UNKNOWN_SOURCE : attributeValue(attr.value, attr.status),
          source: mark === "unknown" ? undefined : sourceLabel(attr.source),
        };
      }
      if (n.visibility === "agent-private") {
        const why = candidate.why;
        return {
          id: n.id,
          mark: why.includes("unacceptable") ? "out" : eligible ? "private" : "unknown",
          label: n.label,
          answer: why.includes("unacceptable")
            ? "your agent ruled it out"
            : eligible
              ? "your agent passed it"
              : "your agent hasn't said",
        };
      }
      // Needs without a dossier field answer from their own measure, never
      // from the place's aggregate verdict: another need's exclusion must not
      // read as this one's. The server-composed label is the contract here
      // (labelForRequirement): "budget €15", "within 10 min walk", "avoid x".
      const verdict = ownMeasure(n.label, candidate, dossier);
      const mark: Mark =
        verdict === null ? "unknown" : verdict ? (isPrivate ? "private" : "in") : "out";
      return {
        id: n.id,
        mark,
        label: own || !isPrivate ? n.label : "a private condition",
        answer: verdict === null ? UNKNOWN_SOURCE : verdict ? "yes" : "no",
      };
    });

  /* Peers' private needs: their effect on THIS place, never their content.
     The why-string carries two fixed tokens and nothing else about them (§5)
     — one token for however many private needs touch the place, so with
     several the row is one row too: the room cannot tell which one spoke,
     and must not pretend to. The owner is not named (COPY.md privacy
     phrasing), the topic only when they opted into one. */
  if (privateEffects.length > 0) {
    const ruledOut = candidate.why === PRIVATE_EXCLUDED;
    const pending = candidate.why.includes(PRIVATE_PENDING);
    // A place ruled out by something else never got as far as these needs:
    // the honest answer is that nothing is known here, not "passes".
    const unreached = candidate.eligibility === "excluded" && !ruledOut;
    const several = privateEffects.length > 1;
    const topic = !several && privateEffects[0].topic ? ` about ${privateEffects[0].topic}` : "";
    checks.push({
      id: "private-effects",
      mark: ruledOut ? "out" : pending || unreached ? "unknown" : "private",
      label: several
        ? `${numberWord(privateEffects.length)} private conditions`
        : `A private condition${topic}`,
      answer: ruledOut
        ? several
          ? "one of them ruled it out"
          : "ruled it out"
        : pending
          ? "not yet checked"
          : unreached
            ? "not checked here"
            : several
              ? "all pass"
              : "passes",
    });
  }

  /* The facts nobody asked about. Verified ones become pills; unknowns are a
     count, not a list — the reader's question is "what else is true", and a
     wall of question marks answers nothing. */
  const facts = (dossier?.attributes ?? []).filter((a) => !askedKeys.has(a.key));
  const known = facts.filter((a) => a.status !== "unknown");
  const unknownCount = facts.length - known.length;
  const factLabel = (a: DossierAttribute) => {
    const label =
      ATTRIBUTE_LABELS[a.key as keyof typeof ATTRIBUTE_LABELS] ?? a.key.replace(/-/g, " ");
    if (a.key === "price-level") return eurBand(Number(a.value)) ?? `${label}: ${attributeValue(a.value, a.status)}`;
    if (typeof a.value === "boolean" || a.value === undefined || a.value === null) {
      return a.status === "verified_false" ? `no ${label}` : label;
    }
    return `${label}: ${String(a.value).replace(/[_;]/g, ", ")}`;
  };

  const sources = [
    ...new Set(
      [...checks.map((c) => c.source), ...known.map((a) => sourceLabel(a.source))].filter(
        (s): s is string => Boolean(s),
      ),
    ),
  ];

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
            <div className="group-heading">Does it fit</div>
            <div className="ledger" data-testid="fit-ledger">
              {checks.map((c) => (
                <div className="ledger-row check-row" data-mark={c.mark} key={c.id}>
                  <i className="mark" data-mark={c.mark} aria-hidden="true" />
                  <span className="ledger-label check-text">{c.label}</span>
                  <span className="ledger-answer" data-mark={c.mark}>
                    <span className="sr-only">
                      {c.mark === "in" || c.mark === "private" ? "yes: " : c.mark === "out" ? "no: " : "unknown: "}
                    </span>
                    {c.answer}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {dossier && (known.length > 0 || unknownCount > 0) && (
          <div className="details-group">
            <div className="group-heading">Also on record</div>
            {/* Server order, verbatim. No invented icons, no reordering. */}
            <div className="fact-row" data-testid="facts">
              {known.map((a) => (
                <span className="fact attr-row" data-status={a.status} key={a.key}>
                  {factLabel(a)}
                  {a.status === "unverified" && <span className="fact-note"> · unverified</span>}
                </span>
              ))}
              {unknownCount > 0 && (
                <span className="fact-unknown" data-testid="facts-unknown">
                  {unknownCount} not on record
                </span>
              )}
            </div>
          </div>
        )}

        {sources.length > 0 && (
          <div className="details-group details-sources" data-testid="sources">
            {sources.length === 1 ? `Facts ${sources[0]}.` : `Facts ${sources.join("; ")}.`}
          </div>
        )}

        <div className="details-group">
          <div className="group-heading">Where everyone stands</div>
          <div className="ledger">
            {participants.map((p, i) => {
              const stance = stanceOf(p.participantId);
              const you = p.participantId === meId;
              const looking = !you && viewing[p.participantId] === candidate.candidateId;
              const mark: Mark = stance === "accept" ? "in" : stance === "veto" ? "veto" : "silent";
              return (
                <div className="ledger-row stand-row" data-stance={stance} key={p.participantId}>
                  <span
                    className="stand-avatar"
                    style={{ background: personColor(i) }}
                    aria-hidden="true"
                  >
                    {initials(p.displayName)}
                  </span>
                  <span className="ledger-label stand-text">
                    {stance === "accept"
                      ? `${you ? "You are" : `${p.displayName} is`} in`
                      : stance === "veto"
                        ? `${you ? "You" : p.displayName} ruled it out`
                        : `${you ? "You haven't" : `${p.displayName} hasn't`} said`}
                    {looking && (
                      <span className="stand-looking" data-testid={`looking-${p.participantId}`}>
                        {" "}· looking now
                      </span>
                    )}
                  </span>
                  <i className="mark" data-mark={mark} aria-hidden="true" />
                </div>
              );
            })}
          </div>
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

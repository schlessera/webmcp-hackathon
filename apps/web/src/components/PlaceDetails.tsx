import { useEffect, useRef, useState } from "react";
import { ATTRIBUTE_LABELS, PRICE_LEVEL_EUR } from "@webmcp-hackathon/contracts";
import { placeImageBlob, spatialInspectRaw, spatialLookupRaw } from "../api.ts";
import type {
  ActiveNeed,
  CandidateDossier,
  CandidateNeedVerdict,
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
  confidenceWord,
  hoursLines,
  initials,
  numberWord,
  personColor,
  readableWhy,
  citationLabel,
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

function eurBand(level: number | null): string | null {
  const eur = level === null ? undefined : PRICE_LEVEL_EUR[level as 1 | 2 | 3 | 4];
  return eur === undefined ? null : `about €${eur} each`;
}

/** The mark vocabulary shared with the map: in = filled works dot, unknown =
 * hollow unsure ring, out = small grey dot, private = scope dot, silent =
 * ghost ring, veto = hollow act ring, busy = the turning ring. */
type Mark = "in" | "likely" | "unlikely" | "unknown" | "out" | "private" | "silent" | "veto" | "busy";

interface Check {
  id: string;
  mark: Mark;
  label: string;
  answer: string;
  /** Under the answer: the evidence, in the reader's words. */
  note?: string;
  source?: string;
  /** Where a web-derived fact was read; rendered as a link, always. */
  sourceUrl?: string;
}

/** A server verdict → the mark it is drawn with. A private need that passes
 * is drawn scope-coloured: visibility, never a second meaning for works. */
function markOf(v: CandidateNeedVerdict): Mark {
  if (v.verdict === "yes") return v.private ? "private" : "in";
  if (v.verdict === "no") return "out";
  if (v.verdict === "likely") return "likely";
  if (v.verdict === "unlikely") return "unlikely";
  return "unknown";
}

/** The answer in words. The server's `why` when it wrote one; otherwise the
 * verdict word, with a guess saying how sure (COPY.md confidence). */
function answerOf(v: CandidateNeedVerdict): string {
  if (v.why) return v.why;
  if (v.verdict === "yes") return "yes";
  if (v.verdict === "no") return "no";
  if (v.verdict === "likely" || v.verdict === "unlikely") {
    // The verdict word already says "likely"; the confidence word only
    // adds something at either end of the scale.
    const sure = v.confidence === undefined ? null : confidenceWord(v.confidence);
    return sure && sure !== "likely" ? `${v.verdict} · ${sure}` : v.verdict;
  }
  return UNKNOWN_SOURCE;
}

/**
 * The verdict strip from the per-need verdicts, so the main UI never shows
 * the classifier's wire phrasing (CLAUDE.md §6). Falls back to the server's
 * `why`, made readable, when a dossier has no verdicts.
 */
function verdictText(
  candidate: CandidateSummary,
  needs: CandidateNeedVerdict[] | undefined,
): string {
  if (candidate.eligibility === "eligible") return COPY.verdictClears;
  if (!needs || needs.length === 0) return readableWhy(candidate.why);
  const name = (v: CandidateNeedVerdict) => (v.private ? "a private condition" : `“${v.label}”`);
  const nos = needs.filter((v) => v.verdict === "no");
  const unknowns = needs.filter((v) => v.verdict === "unknown");
  const unlikely = needs.filter((v) => v.verdict === "unlikely");
  if (candidate.eligibility === "excluded") {
    if (nos.length === 0) return readableWhy(candidate.why);
    if (nos.every((v) => v.private)) {
      return nos.length === 1 ? "Ruled out by a private condition" : "Ruled out by private conditions";
    }
    return `Ruled out by ${nos.map(name).join(", ")}`;
  }
  if (candidate.eligibility === "unlikely" && unlikely.length > 0) {
    return `Unlikely to clear ${unlikely.map(name).join(", ")}`;
  }
  if (candidate.eligibility === "likely") return "Likely clears every need, on a guess";
  if (unknowns.length === 1) return `${unknowns[0].private ? "A private condition" : name(unknowns[0])} still to check`;
  if (unknowns.length > 1) return `${numberWord(unknowns.length)} needs still to check`;
  return readableWhy(candidate.why);
}

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
  /** The server is looking this place up right now (`lookups` frame). */
  busy: boolean;
  /** The last `facts` frame: re-read the dossier when it named this place. */
  factsFrame: { ids: string[]; nonce: number };
  onClose(): void;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

type DossierImage = NonNullable<CandidateDossier["images"]>[number];

function PlacePhoto({ image, alt }: { image: DossierImage; alt: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      void placeImageBlob(image.url, controller.signal).then((blob) => {
        if (!blob || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      });
    };
    const observer = "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            load();
            observer?.disconnect();
          }
        }, { rootMargin: "120px" })
      : null;
    if (observer) observer.observe(element);
    else load();
    return () => {
      observer?.disconnect();
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.url]);
  return (
    <div className="details-photo-frame" ref={frame}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        width={image.width}
        height={image.height}
      />
    </div>
  );
}

function photoCredit(image: DossierImage): string {
  if (image.source.startsWith("web:")) return COPY.photoFromPlaceSite;
  if (image.license) {
    return COPY.photoCredit(image.credit ?? "Wikimedia Commons", image.license);
  }
  return COPY.photoFromOpenStreetMap;
}

/** One line per fact — status, source, value, note — so a re-read can say
 * how many facts a lookup changed without trusting a count from anywhere. */
function factSignatures(dossier: CandidateDossier | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of dossier?.attributes ?? []) {
    out.set(a.key, [a.status, a.source, a.value ?? "", a.note ?? ""].join("|"));
  }
  return out;
}

function countChanged(before: Map<string, string> | null, after: Map<string, string>): number {
  if (!before) return 0;
  let changed = 0;
  for (const [key, signature] of after) {
    if (before.get(key) !== signature) changed += 1;
  }
  return changed;
}

function dossierStatusSignature(dossier: CandidateDossier): string {
  return JSON.stringify({
    attributes: dossier.attributes.map((attribute) => [
      attribute.key,
      attribute.status,
      attribute.value,
      attribute.source,
    ]),
    needs: dossier.needs?.map((need) => [
      need.requirementId,
      need.verdict,
      need.confidence,
      need.why,
    ]),
  });
}

function cssDurationMs(value: string): number {
  const trimmed = value.trim();
  const amount = Number.parseFloat(trimmed);
  if (!Number.isFinite(amount)) return 0;
  return trimmed.endsWith("ms") ? amount : trimmed.endsWith("s") ? amount * 1000 : 0;
}

/** External facts are links only when their absolute URL is safe to open. */
function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
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
  busy,
  factsFrame,
  onClose,
  run,
}: Props) {
  const [loadedDossier, setDossier] = useState<CandidateDossier | null>(null);
  const dossier = loadedDossier?.candidateId === candidate.candidateId ? loadedDossier : null;
  const dossierRef = useRef<CandidateDossier | null>(dossier);
  dossierRef.current = dossier;
  const [factsSettlingCandidate, setFactsSettlingCandidate] = useState<string | null>(null);
  const handledFactsNonce = useRef(0);
  const settleTimer = useRef<number | null>(null);
  const [activePhoto, setActivePhoto] = useState(0);
  /* A facts frame naming this place re-reads the dossier in place — the
     rows update, the panel does not blank. */
  const factsNonce = factsFrame.ids.includes(candidate.candidateId) ? factsFrame.nonce : 0;
  /* The per-need rows are the server's verdicts for the need set as it
     stands: a peer adding, toggling or withdrawing a need while this panel
     is open must re-read them, or the ledger contradicts the strip above. */
  const needSignature = `${activeNeeds.map((n) => `${n.id}:${n.active ? 1 : 0}`).join(",")}|${privateEffects.length}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* "Look it up" (force): asked → running while the server says so →
     done with what it changed. The outcome is a diff of the dossier's
     facts before and after, so the line never claims more than the rows
     show. Client-side state only. */
  const [lookupPhase, setLookupPhase] = useState<"idle" | "asked" | "running" | "done">("idle");
  const [lookupChanged, setLookupChanged] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const factsBefore = useRef<Map<string, string> | null>(null);
  const awaitingDiff = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let frame: number | null = null;
    void (async () => {
      const result = (await spatialInspectRaw({
        candidateIds: [candidate.candidateId],
      })) as { ok?: boolean; candidates?: CandidateDossier[] };
      if (!cancelled && result.ok && result.candidates?.[0]) {
        const next = result.candidates[0];
        const current = dossierRef.current;
        const factsChanged =
          factsNonce > 0 &&
          handledFactsNonce.current !== factsNonce &&
          current !== null &&
          dossierStatusSignature(current) !== dossierStatusSignature(next);
        if (factsNonce > 0) handledFactsNonce.current = factsNonce;
        const applyDossier = () => {
          if (!cancelled) setDossier(next);
        };
        if (factsChanged) {
          setFactsSettlingCandidate(candidate.candidateId);
          frame = requestAnimationFrame(applyDossier);
          if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
          const settleMs = cssDurationMs(
            getComputedStyle(document.documentElement).getPropertyValue("--spoke-dur-settle"),
          );
          settleTimer.current = window.setTimeout(() => {
            setFactsSettlingCandidate(null);
            settleTimer.current = null;
          }, settleMs);
        } else {
          applyDossier();
        }
        if (awaitingDiff.current) {
          awaitingDiff.current = false;
          setLookupChanged(countChanged(factsBefore.current, factSignatures(next)));
          setLookupPhase("done");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [candidate.candidateId, factsNonce, needSignature, refreshNonce]);
  // A different place: the old dossier must not read as this one's.
  useEffect(() => {
    setDossier(null);
    setActivePhoto(0);
    setLookupPhase("idle");
    setLookupChanged(0);
    setFactsSettlingCandidate(null);
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    factsBefore.current = null;
    awaitingDiff.current = false;
  }, [candidate.candidateId]);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );
  const lookingUp = busy || dossier?.lookupPending === true;

  useEffect(() => {
    if (lookupPhase === "asked" && lookingUp) setLookupPhase("running");
    if (lookupPhase === "running" && !lookingUp) {
      // The server is done: re-read once and settle on what changed.
      awaitingDiff.current = true;
      setRefreshNonce((n) => n + 1);
    }
  }, [lookingUp, lookupPhase]);
  useEffect(() => {
    // A lookup nobody ever started (offline server, budget spent) must not
    // leave the button stuck on "Asked": settle as nothing new after 8 s.
    if (lookupPhase !== "asked") return;
    const timer = window.setTimeout(() => {
      awaitingDiff.current = true;
      setRefreshNonce((n) => n + 1);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [lookupPhase]);

  const eligible = candidate.eligibility === "eligible";
  const verdictState =
    candidate.eligibility === "eligible"
      ? "works"
      : candidate.eligibility === "likely"
        ? "likely"
        : candidate.eligibility === "uncertain"
          ? "unsure"
          : candidate.eligibility === "unlikely"
            ? "unlikely"
            : "out";
  /* One row per stated need. Unknown is drawn, never treated as a failure
     and never silently dropped (CLAUDE.md §4). A need with dossier evidence
     answers from the evidence; one without answers from the verdict. */
  /* Provenance in the reader's language. An attested fact names its
     attester — that is the point of an attestation — and "you" when it was
     this person. */
  const nameOf = (pid: string) =>
    pid === meId ? "you" : (participants.find((p) => p.participantId === pid)?.displayName ?? "someone");
  const sourceOf = (a: { source: string; attestedBy?: string }) => {
    if (a.source.startsWith("disputed:") && a.attestedBy) return `disputed by ${nameOf(a.attestedBy)}`;
    if (a.source.startsWith("agent:") && a.attestedBy) return `checked by ${nameOf(a.attestedBy)}`;
    return sourceLabel(a.source);
  };
  const askedKeys = new Set<string>();
  /* One row per need, from the server's own verdicts on this dossier
     (needs[]): the page never parses a label or guesses which fact a need
     reads. A peer's private need arrives as a row with no content (§5). A
     verdict on an attribute need lifts that fact out of "Also on record". */
  const verdicts = dossier?.needs;
  const checks: Check[] = (verdicts ?? []).map((v): Check => {
    const mark = markOf(v);
    const own = activeNeeds.find((n) => n.id === v.requirementId);
    // The attribute this need reads, so its pill does not repeat below. The
    // key is protocol (ATTRIBUTE_LABELS is the manifest's own table).
    // A question need reads the `q:` fact the server keyed on its criterion;
    // an attribute need reads its vocabulary key.
    const key = own?.criterionId?.startsWith("q:")
      ? own.criterionId
      : own
        ? Object.entries(ATTRIBUTE_LABELS).find(
            ([, label]) => own.label.replace(/^no /, "").toLowerCase() === label.toLowerCase(),
          )?.[0]
        : undefined;
    const attr = key ? dossier?.attributes.find((a) => a.key === key) : undefined;
    if (key && attr && attr.status !== "unknown") askedKeys.add(key);
    return {
      id: v.requirementId,
      mark,
      label: v.private ? "A private condition" : (v.label ?? own?.label ?? "a need"),
      answer: answerOf(v),
      note: attr?.note,
      source: attr && attr.status !== "unknown" ? sourceOf(attr) : undefined,
      sourceUrl: attr && attr.status !== "unknown"
        ? safeHttpUrl(attr.sourceUrl) ?? undefined
        : undefined,
    };
  });
  /* No verdicts yet (the dossier is still loading): every stated need is a
     row being checked, so the panel's shape holds from the first paint. */
  if (!verdicts && checks.length === 0) {
    for (const n of activeNeeds.filter((n) => n.active)) {
      checks.push({
        id: n.id,
        mark: "busy",
        label: n.ownerId === meId || n.visibility === "shared" ? n.label : "A private condition",
        answer: dossier ? UNKNOWN_SOURCE : "checking…",
      });
    }
    if (privateEffects.length > 0) {
      checks.push({
        id: "private-effects",
        mark: "busy",
        label: privateEffects.length > 1 ? `${numberWord(privateEffects.length)} private conditions` : "A private condition",
        answer: dossier ? UNKNOWN_SOURCE : "checking…",
      });
    }
  }

  /* The facts nobody asked about. Verified ones become pills; unknowns are a
     count, not a list — the reader's question is "what else is true", and a
     wall of question marks answers nothing. */
  const inVocabulary = (key: string) => key in ATTRIBUTE_LABELS;
  const facts = (dossier?.attributes ?? []).filter(
    (a) =>
      !askedKeys.has(a.key) &&
      // The price band is said once, in the meta line (W8).
      !(a.key === "price-level" && candidate.priceLevel !== null) &&
      // A fact with neither a value nor a place in the vocabulary has no
      // words to render ("hours · likely" said nothing, W8).
      (inVocabulary(a.key) || (a.value !== undefined && a.value !== null)),
  );
  // A question the room asked (`q:`) shows only with its label — a peer's
  // private question arrives without one and stays out of both the record
  // and its unknown count (§5). Its opaque key can therefore never surface.
  const visibleFacts = facts.filter((a) => !a.key.startsWith("q:") || Boolean(a.label));
  const known = visibleFacts.filter((a) => a.status !== "unknown");
  const unknownCount = visibleFacts.length - known.length;
  const factLabel = (a: DossierAttribute) => {
    const label =
      a.label ??
      ATTRIBUTE_LABELS[a.key as keyof typeof ATTRIBUTE_LABELS] ??
      a.key.replace(/-/g, " ");
    if (a.key === "price-level") {
      const band = eurBand(Number(a.value));
      // A guessed band says so once, in front, never twice (W8).
      return band ? (a.status === "likely_true" ? `likely ${band}` : band) : `${label}: ${attributeValue(a.value, a.status)}`;
    }
    if (typeof a.value === "boolean" || a.value === undefined || a.value === null) {
      return a.status === "verified_false" ? `no ${label}` : label;
    }
    // OSM multi-values are ";"-separated and words are "_"-joined: "steak_house;brazilian".
    return `${label}: ${String(a.value).replace(/;/g, ", ").replace(/_/g, " ")}`;
  };

  const sources = [
    ...new Set(
      [...checks.map((c) => c.source), ...known.map((a) => sourceOf(a))].filter(
        (s): s is string => Boolean(s),
      ),
    ),
  ];

  const stanceOf = (participantId: string) =>
    proposal?.stances.find((s) => s.participantId === participantId)?.stance ?? "none";

  const negotiable = phase === "gathering" || phase === "deliberation";
  // `priceLevel` is a 1–4 band, not an amount. PRICE_LEVEL_EUR is the
  // manifest's own band → per-person cap mapping, the same one the server
  // measures a budget need against, so both read the same number. A band
  // the record only guessed is said as a guess, once, here — and not again
  // as a pill (W8).
  const priceAttr = dossier?.attributes.find((a) => a.key === "price-level");
  const priceGuessed = priceAttr?.status === "likely_true" || priceAttr?.status === "likely_false";
  const priceText =
    candidate.priceLevel === null
      ? null
      : priceGuessed
        ? `likely ${eurBand(candidate.priceLevel)}`
        : eurBand(candidate.priceLevel);
  const meta = [
    candidate.category.replace(/_/g, " "),
    candidate.walkMin > 0 ? `${candidate.walkMin} min away` : null,
    priceText,
  ]
    .filter(Boolean)
    .join(" · ");
  const hours = hoursLines(dossier?.hours ?? []);
  const hoursStatus = dossier?.openNow === true
    ? `open now${dossier.openUntil ? ` · until ${dossier.openUntil}` : ""}`
    : dossier?.openNow === false
      ? `closed${dossier.nextOpen ? ` · opens ${dossier.nextOpen}` : ""}`
      : null;
  const whereWhen = dossier && (dossier.address || dossier.phone || hours.length > 0 || hoursStatus);
  const askLookup = () => {
    factsBefore.current = factSignatures(dossier);
    setLookupPhase("asked");
    void spatialLookupRaw({ candidateIds: [candidate.candidateId], force: true });
  };
  const minutesSinceLookup = dossier?.lookedUpAt
    ? Math.floor((Date.now() - new Date(dossier.lookedUpAt).getTime()) / 60_000)
    : null;
  const recentlyLookedUp =
    lookupPhase === "done" || (minutesSinceLookup !== null && minutesSinceLookup < 10);
  const safeLinks = (dossier?.links ?? []).flatMap((link) => {
    const href = safeHttpUrl(link.url);
    return href ? [{ ...link, href }] : [];
  });
  const photos = dossier?.images ?? [];
  const creditPhoto = photos[Math.min(activePhoto, Math.max(0, photos.length - 1))];

  return (
    <aside
      className="details"
      data-facts-settling={factsSettlingCandidate === candidate.candidateId || undefined}
      data-testid="place-details"
      aria-label={candidate.name}
    >
      <div className="details-nav">
        <button className="btn-text tap-wide" data-testid="details-close" onClick={onClose}>
          Close
        </button>
        <span className="details-nav-spacer" aria-hidden="true" />
        {/* Ask the room's server to look this place up now; what lands
            arrives on the facts frame and updates the rows in place. */}
        {negotiable && (
          <>
            {recentlyLookedUp && lookupPhase !== "done" && minutesSinceLookup !== null && (
              <span className="details-lookup-ago" data-testid="details-lookup-ago">
                {COPY.lookedUpAgo(minutesSinceLookup)}
              </span>
            )}
            <button
              className="btn-text tap-wide"
              data-testid="details-lookup-btn"
              disabled={lookingUp || lookupPhase === "asked"}
              onClick={askLookup}
            >
              {lookingUp
                ? "Looking it up"
                : lookupPhase === "asked"
                  ? "Asked"
                  : recentlyLookedUp
                    ? COPY.lookAgain
                    : "Look it up"}
            </button>
          </>
        )}
      </div>

      <div className="details-body">
        {photos.length > 0 && (
          <div className="details-photo" data-testid="photo-band">
            <div
              className="details-photo-band"
              data-count={photos.length}
              onScroll={(event) => {
                const element = event.currentTarget;
                if (element.clientWidth > 0) {
                  setActivePhoto(Math.round(element.scrollLeft / element.clientWidth));
                }
              }}
              tabIndex={photos.length > 1 ? 0 : undefined}
              aria-label={photos.length > 1 ? `Photos of ${candidate.name}` : undefined}
            >
              {photos.map((image) => (
                <PlacePhoto image={image} alt={candidate.name} key={image.url} />
              ))}
            </div>
            {creditPhoto &&
              (creditPhoto.pageUrl ? (
                <a
                  className="details-photo-credit"
                  href={creditPhoto.pageUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-testid="photo-credit"
                >
                  {photoCredit(creditPhoto)}
                </a>
              ) : (
                /* Attribution is owed whether or not there is somewhere to
                   link; only the arrow belongs to the link. */
                <span className="details-photo-credit" data-testid="photo-credit">
                  {photoCredit(creditPhoto).replace(" \u2197", "")}
                </span>
              ))}
          </div>
        )}
        <div className="details-group">
          <div className="details-title">{candidate.name}</div>
          {meta && <div className="details-meta">{meta}</div>}
          {/* Verdict first: the reader's question is always "why is this here?" */}
          <div className="verdict" data-state={verdictState} data-testid="verdict">
            <span className="verdict-dot" aria-hidden="true" />
            <span className="verdict-text">{verdictText(candidate, dossier?.needs)}</span>
          </div>
          {/* Reserved from the first paint (SPOKES-UI §6): the panel never
              looks final before the facts have landed. */}
          <div
            className="details-lookup"
            data-state={lookingUp ? "busy" : dossier ? "done" : "loading"}
            data-testid="details-lookup"
            role="status"
            aria-busy={lookingUp || !dossier || undefined}
          >
            {lookingUp || !dossier ? (
              <>
                <i className="busy-ring line-busy" aria-hidden="true" />
                {lookingUp ? COPY.lookingUp : COPY.readingRecord}
              </>
            ) : lookupPhase === "done" ? (
              COPY.lookedUpJustNow(lookupChanged)
            ) : (
              COPY.recordRead
            )}
          </div>
        </div>

        {checks.length > 0 && (
          <div className="details-group">
            <div className="group-heading">Does it fit</div>
            <div className="ledger" data-testid="fit-ledger">
              {checks.map((c) => (
                <div className="ledger-row check-row" data-mark={c.mark} key={c.id}>
                  {c.mark === "busy" ? (
                    <i className="busy-ring mark-busy" aria-hidden="true" />
                  ) : (
                    <i className="mark" data-mark={c.mark} aria-hidden="true" />
                  )}
                  <span className="ledger-label check-text">
                    {c.label}
                    {c.note && <span className="ledger-note"> · {c.note}</span>}
                    {c.sourceUrl && (
                      <a
                        className="fact-cite"
                        href={c.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="fact-cite"
                      >
                        {citationLabel(c.sourceUrl)}
                      </a>
                    )}
                  </span>
                  <span className="ledger-answer" data-mark={c.mark}>
                    <span className="sr-only">
                      {c.mark === "in" || c.mark === "private"
                        ? "yes: "
                        : c.mark === "out"
                          ? "no: "
                          : c.mark === "likely"
                            ? "likely: "
                            : c.mark === "unlikely"
                              ? "unlikely: "
                              : c.mark === "busy"
                                ? ""
                                : "unknown: "}
                    </span>
                    {c.answer}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {whereWhen && (
          <div className="details-group" data-testid="where-when">
            <div className="group-heading">Where and when</div>
            <div className="ledger">
              {hoursStatus && (
                <div className="ledger-row hours-status">
                  <span className="ledger-label">{hoursStatus}</span>
                </div>
              )}
              {dossier.address && (
                <div className="ledger-row">
                  <span className="ledger-label">{dossier.address}</span>
                </div>
              )}
              {dossier.phone && (
                <div className="ledger-row">
                  <a className="ledger-label details-phone" href={`tel:${dossier.phone.replace(/\s+/g, "")}`}>
                    {dossier.phone}
                  </a>
                </div>
              )}
              {hours.map((h) => (
                <div className="ledger-row hours-row" key={h.days}>
                  <span className="ledger-label">{h.days}</span>
                  <span className="ledger-answer hours-times">{h.times}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {dossier && (dossier.description || dossier.rating || dossier.awards) && (
          <div className="details-group" data-testid="about">
            {dossier.description && (
              <p className="details-description">
                {dossier.description.text}
                <span className="fact-note"> · {sourceLabel(dossier.description.source)}</span>
              </p>
            )}
            {dossier.awards?.map((a) => (
              <span className="fact attr-row" data-status="verified_true" key={a.label}>
                {a.label}
                <span className="fact-note"> · {sourceLabel(a.source)}</span>
              </span>
            ))}
            {dossier.rating && (
              <p className="details-rating" data-testid="rating">
                Rated {dossier.rating.value} of {dossier.rating.best}
                {dossier.rating.count ? ` by ${dossier.rating.count}` : ""}, {dossier.rating.label}.
              </p>
            )}
          </div>
        )}

        {safeLinks.length > 0 && (
          <div className="details-group details-links" data-testid="links">
            {/* Server labels, verbatim; a link is a fact about the place, not
                chrome, and opens outside the room. */}
            {safeLinks.map((l) => (
              <a
                key={l.kind + l.url}
                className="details-link"
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                title={sourceLabel(l.source)}
              >
                {l.label}
              </a>
            ))}
          </div>
        )}

        {dossier && (known.length > 0 || unknownCount > 0) && (
          <div className="details-group">
            <div className="group-heading">Also on record</div>
            {/* Server order, verbatim. No invented icons, no reordering. */}
            <div className="fact-row" data-testid="facts">
              {known.map((a) => {
                const sourceUrl = safeHttpUrl(a.sourceUrl);
                return (
                  <span
                    className="fact attr-row"
                    data-status={a.status}
                    key={a.key}
                    title={a.note ? `${sourceOf(a)}: ${a.note}` : sourceOf(a)}
                  >
                    {factLabel(a)}
                    {a.status === "likely_true" && a.key !== "price-level" && (
                      <span className="fact-note"> · likely</span>
                    )}
                    {a.status === "likely_false" && <span className="fact-note"> · unlikely</span>}
                    {a.status === "verified_false" && a.key.startsWith("q:") && (
                      <span className="fact-note"> · no</span>
                    )}
                    {a.key.startsWith("q:") && a.note && (
                      <span className="fact-note"> · “{a.note}”</span>
                    )}
                    {sourceUrl && (
                      <a
                        className="fact-cite"
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="fact-cite"
                      >
                        {citationLabel(sourceUrl)}
                      </a>
                    )}
                  </span>
                );
              })}
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

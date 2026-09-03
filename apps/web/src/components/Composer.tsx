import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ATTRIBUTE_LABELS,
  ATTRIBUTE_VOCABULARY,
  NEARNESS_DEFAULT,
  PRICE_WORDS,
  mapPreparsedConcept,
  preparse,
  type Concept,
} from "@webmcp-hackathon/contracts";
import { nlCondition, nlSay } from "../api.ts";
import { diagnostics } from "../diagnostics-store.ts";
import { shouldPreserveNlText } from "../nl-result.ts";
import { spatial } from "../spatial-store.ts";
import { wire, type WireStep } from "../wire-store.ts";
import type {
  ActiveNeed,
  CommandEnvelope,
  Facet,
  Visibility,
} from "../spatial-types.ts";
import { COPY } from "../ui/copy.ts";

/**
 * The composer. One bar: scope chosen on the LEFT, before speaking; a
 * transparent field; `Add` flush right as a word, never a glyph
 * (SPOKES-UI §5).
 *
 * Above it, suggestion pills generated from the facets the server returned
 * for the current set. The app ships zero domain chips: every pill's text is
 * a server `label`, and the only branch is on facet `type` — protocol, not
 * domain (FACETS.md §1).
 *
 * Free text goes to the person's agent when the serving process offers one
 * (docs/NL-AGENT.md): a sentence that states a need comes back as payloads
 * this page submits like any typed need; a question or an instruction comes
 * back answered, as a card in the brief. Without an agent, the label match
 * below is all the parsing there is.
 */

/* Each scope says what leaves the device and what the room sees, at the
   point of choice (SPOKES-UI §5, W10). Visibility, in the reader's words. */
const SCOPES: Array<{ value: Visibility; label: string; means: string }> = [
  { value: "shared", label: "Shared", means: "everyone in the room reads it" },
  { value: "application-private", label: "Private", means: "the room sees only what it rules out" },
  { value: "agent-private", label: "Agent only", means: "your agent holds it; the room learns a condition exists" },
];

const ATTRIBUTE_KEYS = new Set<string>(ATTRIBUTE_VOCABULARY);
const LABEL_TO_KEY = new Map<string, string>(
  Object.entries(ATTRIBUTE_LABELS).map(([key, label]) => [label.toLowerCase(), key]),
);

type Payload = Record<string, unknown>;

/**
 * Free text → a requirement payload, without an agent. Four protocol-level
 * attempts, then an honest fallback:
 *   1. the text names a facet the server sent → that attribute
 *   2. it reads as money → a budget
 *   3. it reads as minutes → a walking-distance scope
 *   4. it is exactly "open now" → a two-hour absolute window
 *   5. otherwise a `text` predicate, which rules nothing out and marks every
 *      place pending, because nothing about it has been checked.
 * There is no domain parsing beyond the labels the server itself supplied.
 */
export function payloadFromText(
  text: string,
  facets: Facet[],
  time: { now?: Date; timezone?: string } = {},
): Payload {
  const parsed = preparse(text, { currency: roomCurrency(facets) });
  const now = time.now ?? new Date();
  const timezone = time.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (parsed.preparsedWhole) {
    const payload = parsed.concepts
      .map((concept) => mapPreparsedConcept(concept, {
        currency: roomCurrency(facets),
        transport: ["walk"],
        now,
        timezone,
      }))
      .find(Boolean);
    if (payload) return payload;
  }
  const t = text.trim().toLowerCase();

  for (const facet of facets) {
    if (facet.type !== "boolean" || !ATTRIBUTE_KEYS.has(facet.key)) continue;
    const label = facet.label.toLowerCase();
    if (t === label || t.includes(label)) {
      return { kind: "attribute", key: facet.key, expect: "verified_true" };
    }
  }
  // A vocabulary label only states a boolean need; a facet the server typed
  // as anything else (enum, numeric) is not a yes/no claim about a place.
  const byLabel = LABEL_TO_KEY.get(t);
  const nonBoolean = new Set(facets.filter((f) => f.type !== "boolean").map((f) => f.key));
  if (byLabel && ATTRIBUTE_KEYS.has(byLabel) && !nonBoolean.has(byLabel)) {
    return { kind: "attribute", key: byLabel, expect: "verified_true" };
  }

  const money = /(?:€\s*(\d+(?:[.,]\d+)?))|(?:(\d+(?:[.,]\d+)?)\s*(?:€|eur\b|euros?\b))/i.exec(text);
  if (money) {
    const amount = Number((money[1] ?? money[2]).replace(",", "."));
    if (Number.isFinite(amount) && amount > 0) {
      return { kind: "budget", perPersonMax: { amount, currency: "EUR" } };
    }
  }

  const minutes = /(\d+)\s*(?:min\b|mins\b|minutes?\b)/i.exec(text);
  if (minutes) {
    const max = Number(minutes[1]);
    if (Number.isFinite(max) && max > 0) {
      return { kind: "scope", dimension: "walk_min", max };
    }
  }

  return { kind: "text", text: text.trim().slice(0, 200) };
}

function roomCurrency(facets: Facet[]): "EUR" | "USD" {
  return facets.find((facet) => facet.key === "price-level")?.unit === "USD" ? "USD" : "EUR";
}

function offlineAssumption(
  concept: Concept,
  currency: "EUR" | "USD",
  hasOwnOrigin: boolean,
): string | undefined {
  if (
    !hasOwnOrigin &&
    (concept.role === "distance" || concept.role === "travel_time") &&
    concept.referent?.kind !== "named"
  ) return "measured from the area centre until you set where you start";
  if (concept.gist === "close by") return NEARNESS_DEFAULT.assumed;
  const priceWords = Object.values(PRICE_WORDS).flat();
  if (concept.role === "money" && priceWords.includes(concept.surface.toLocaleLowerCase())) {
    const symbol = currency === "EUR" ? "€" : "$";
    return `read as under ${symbol}${concept.quantity?.value ?? 0}`;
  }
  return undefined;
}

function preparsedPayloads(
  text: string,
  facets: Facet[],
  hasOwnOrigin: boolean,
  now: Date,
  timezone: string,
): Array<{ payload: Payload; assumed?: string }> | null {
  const currency = roomCurrency(facets);
  const parsed = preparse(text, { currency });
  if (!parsed.preparsedWhole) return null;
  const payloads = parsed.concepts.flatMap((concept) => {
    const payload = mapPreparsedConcept(concept, { currency, transport: ["walk"], now, timezone });
    const assumed = offlineAssumption(concept, currency, hasOwnOrigin);
    return payload ? [{
      payload: payload as Payload,
      ...(assumed ? { assumed } : {}),
    }] : [];
  });
  return payloads.length === parsed.concepts.length && payloads.length > 0 ? payloads : null;
}

/** A facet pill → the command that states it as a need (FACETS.md §1). */
export function payloadFromFacet(facet: Facet, value?: string): Payload | null {
  if (facet.type === "boolean" && ATTRIBUTE_KEYS.has(facet.key)) {
    return { kind: "attribute", key: facet.key, expect: "verified_true" };
  }
  if (facet.type === "enum" && value) {
    return { kind: "exclusion", key: facet.key, values: [value], lifetime: "session" };
  }
  if (facet.key === "walk-minutes" && facet.range) {
    return { kind: "scope", dimension: "walk_min", max: facet.range.max };
  }
  if (facet.key === "price-level" && facet.range) {
    return {
      kind: "budget",
      perPersonMax: { amount: facet.range.max, currency: "EUR" },
    };
  }
  return null;
}

interface SayResult {
  ok: boolean;
  intent?: "need" | "ask" | "act" | "clarify" | "unclear";
  needs?: Array<{ payload: Payload; label: string; topic?: string; gist: string; assumed?: string }>;
  clarify?: {
    question: string;
    choices: Array<{ id: string; label: string; needs: Array<{ payload: Payload; label: string; topic?: string; gist: string; assumed?: string }> }>;
    allowFreeText: boolean;
    said: string;
  } | null;
  suggestions?: Array<{ id: string; label: string; needs: Array<{ payload: Payload; label: string; topic?: string; gist: string; assumed?: string }> }>;
  reply?: string | null;
  choices?: Array<{ label: string; payload: Payload }>;
  actions?: Array<{ tool: string; ok: boolean; effect: string }>;
  partial?: boolean;
  failureCategory?: string;
  meta?: {
    route?: { model: string | null; ms: number; provider?: string };
    agent?: {
      model: string;
      ms: number;
      rounds: number;
      provider?: string;
      /** Every tool call the agent made, reads included; never args or results. */
      calls?: Array<{ tool: string; round: number; ok: boolean; ms: number }>;
    };
  };
  error?: { code: string; message: string };
}

/** The tiers a turn went through, as timeline sub-steps. */
function turnSteps(meta: SayResult["meta"]): WireStep[] {
  const steps: WireStep[] = [];
  const route = meta?.route;
  const agent = meta?.agent;
  if (route && route.model) {
    steps.push({ label: `route ${route.model}${route.provider ? ` · ${route.provider}` : ""}`, ms: route.ms });
  }
  if (agent) {
    steps.push({
      label: `agent ${agent.model}${agent.provider ? ` · ${agent.provider}` : ""} · ${agent.rounds} rounds`,
      ms: agent.ms,
    });
    for (const call of agent.calls ?? []) {
      steps.push({ label: `${call.tool} (round ${call.round})`, ms: call.ms, ok: call.ok });
    }
  }
  return steps;
}

interface Props {
  facets: Facet[];
  activeNeeds: ActiveNeed[];
  /** In-scope places, for "updating 40 places…". */
  placeCount: number;
  hasOwnOrigin: boolean;
  timezone: string;
  disabled: boolean;
  run(type: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<CommandEnvelope>;
}

export function Composer({ facets, activeNeeds, placeCount, hasOwnOrigin, timezone, disabled, run }: Props) {
  const [scope, setScope] = useState<Visibility>("shared");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [text, setText] = useState("");
  const [clarifyOf, setClarifyOf] = useState<{ said: string; question: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nlAvailable = useSyncExternalStore(
    (cb) => diagnostics.subscribe(cb),
    () => diagnostics.state.nlAvailable,
  );
  const busy = useSyncExternalStore(
    (cb) => spatial.subscribe(cb),
    () => spatial.state.agentBusy,
  );
  const agentPhase = useSyncExternalStore(
    (cb) => spatial.subscribe(cb),
    () => spatial.state.agentPhase,
  );
  const composerPrefill = useSyncExternalStore(
    (cb) => spatial.subscribe(cb),
    () => spatial.state.composerPrefill,
  );

  useEffect(() => {
    if (!composerPrefill) return;
    setText(composerPrefill.text);
    setClarifyOf(composerPrefill.question
      ? { said: composerPrefill.text, question: composerPrefill.question }
      : null);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, [composerPrefill]);

  const stated = useMemo(
    () => new Set(activeNeeds.map((n) => n.label.toLowerCase())),
    [activeNeeds],
  );

  /* The pill row scrolls sideways under the finger; a clipped third pill
     needs a cue that there is more (W15). Measured, not assumed. */
  const pillRowRef = useRef<HTMLDivElement>(null);
  const [pillOverflow, setPillOverflow] = useState<"right" | "left" | "both" | null>(null);
  useEffect(() => {
    const el = pillRowRef.current;
    if (!el) {
      setPillOverflow(null);
      return;
    }
    const measure = () => {
      const more = el.scrollWidth - el.clientWidth > 2;
      if (!more) return setPillOverflow(null);
      const atStart = el.scrollLeft <= 1;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      setPillOverflow(atStart ? "right" : atEnd ? "left" : "both");
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  });

  /* The scope menu closes on Escape, like every other disclosure. */
  useEffect(() => {
    if (!scopeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setScopeOpen(false);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scopeOpen]);

  /* Focusing the pinned field must never scroll the app frame (W16): the
     browser's scroll-into-view can drag the header and map off-screen on a
     phone. Only the brief may scroll (CLAUDE.md §11). */
  const holdFrame = () => {
    const reset = () => {
      const scroller = document.scrollingElement ?? document.documentElement;
      if (scroller.scrollTop !== 0) scroller.scrollTop = 0;
      const app = document.querySelector<HTMLElement>(".app");
      if (app && app.scrollTop !== 0) app.scrollTop = 0;
    };
    reset();
    requestAnimationFrame(reset);
    window.setTimeout(reset, 120);
  };

  /* Top three yes/no facets nobody has stated yet, most available first.
     Order comes from the server; we only drop what is already a need. */
  const pills = useMemo(
    () =>
      facets
        .filter(
          (f) =>
            f.type === "boolean" &&
            (f.counts.yes ?? 0) + (f.counts.likely ?? 0) > 0 &&
            !stated.has(f.label.toLowerCase()),
        )
        .slice(0, 3),
    [facets, stated],
  );

  const agentOnly = scope === "agent-private";

  // The topic the agent read off a sentence is deliberately NOT attached as
  // a scope hint: disclosing a category is the owner's opt-in (FACETS.md §4)
  // and the composer offers no way to give it yet.
  // The row exists on the brief from this moment (SPOKES-UI §4, pending):
  // in the person's words until the room brings the real one.
  const submitPayload = async (
    payload: Payload | null,
    said: string,
    assumed?: string,
    signal?: AbortSignal,
  ) => {
    const localId = spatial.beginPendingNeed(said, scope, assumed);
    const result = await run("SubmitRequirement", {
      visibility: scope,
      hardness: "hard",
      delegation: { mode: "approval_required" },
      // An agent-private need is a DECLARATION: the server never receives its
      // content, so no payload is sent with it (commands.ts SubmitRequirement).
      ...(agentOnly
        ? { scopeHint: { affects: "candidate-eligibility" } }
        : payload
          ? { payload }
          : {}),
    }, signal);
    spatial.settlePendingCommit(localId, result.ok);
    return result;
  };
  /** What the row says while the room has not phrased it yet. */
  const saidLabel = (sentence: string) =>
    agentOnly ? COPY.pendingAgentOnly : sentence.trim().slice(0, 80);

  /** A pill or a sentence without an agent: the label match, then the bus. */
  const submitPlain = (payload: Payload | null, said: string, assumed?: string) => {
    if (disabled) return;
    void submitPayload(payload, said, assumed);
    setText("");
    setClarifyOf(null);
  };

  /** A sentence with an agent: route it, then act on what came back. */
  const submitSentence = async (sentence: string) => {
    if (disabled || busy) return;
    const trimmed = sentence.trim();
    if (!trimmed) return;
    spatial.setAgentBusy(true, "reading");
    // One agent span per turn; the request and every follow-up command hang
    // under it through the turn's signal. An agent-private sentence is never
    // written to the timeline, only that a turn happened.
    const turn = wire.begin({
      lane: "agent",
      label: agentOnly ? "condition" : "say",
      detail: agentOnly ? { scope: "agent-private" } : { said: trimmed.slice(0, 80), scope },
    });
    const turnSignal = wire.child(turn).signal;
    try {
      if (agentOnly) {
        const result = (await nlCondition(trimmed, turnSignal)) as SayResult & { topic?: string | null };
        if (!result.ok) {
          wire.end(turn, { outcome: "error", note: `refused · ${result.error?.code ?? "error"}` });
          // The declaration still stands; the agent simply holds nothing.
          void submitPayload(null, saidLabel(trimmed), undefined, turnSignal);
        } else {
          wire.end(turn, { outcome: "ok", note: "held", steps: turnSteps(result.meta) });
          spatial.pushAgentReply({ text: COPY.agentHolds, actions: [], answer: true });
        }
        setText("");
        return;
      }
      const result = (await nlSay(trimmed, scope, undefined, clarifyOf ?? undefined, turnSignal)) as SayResult;
      const preserveForRetry = shouldPreserveNlText(result);
      if (!result.ok) {
        // R7: a failed question/action may already have committed an earlier
        // step. Never reinterpret the original words as an unrelated need;
        // keep them in the composer and make retry explicit.
        wire.end(turn, { outcome: "error", note: result.error?.code ?? "error", detail: { retry: "text preserved" } });
        spatial.pushAgentReply({ text: COPY.agentRetry, actions: [], answer: true });
        return;
      }
      const steps = turnSteps(result.meta);
      wire.patch(turn, { note: result.intent, steps });
      if (result.intent === "need") {
        spatial.setAgentBusy(true, "applying");
        for (const need of result.needs ?? []) {
          await submitPayload(need.payload, need.label || need.gist || saidLabel(trimmed), need.assumed, turnSignal);
        }
      } else if (result.intent === "ask" || result.intent === "act") {
        for (const need of result.needs ?? []) {
          await submitPayload(need.payload, need.label || need.gist || saidLabel(trimmed), need.assumed, turnSignal);
        }
        spatial.pushAgentReply({
          text: result.reply ?? "",
          actions: result.actions ?? [],
          answer: result.intent === "ask",
        });
        void spatial.refetch();
        if (preserveForRetry) {
          wire.end(turn, {
            outcome: "error",
            note: `partial · ${result.failureCategory ?? "unknown"}`,
            detail: { retry: "text preserved" },
          });
          return;
        }
      } else if (result.intent === "clarify" && result.clarify) {
        spatial.setAgentBusy(true, "applying");
        for (const need of result.needs ?? []) {
          await submitPayload(need.payload, need.label || need.gist || saidLabel(trimmed), need.assumed, turnSignal);
        }
        spatial.pushAgentReply({
          text: result.clarify.question,
          actions: [],
          answer: true,
          scope: scope === "application-private" ? "application-private" : "shared",
          clarify: result.clarify,
        });
      } else {
        const suggestions = result.suggestions ?? [];
        spatial.pushAgentReply({
          text: result.reply ?? COPY.agentUnclear,
          actions: [],
          answer: true,
          scope: scope === "application-private" ? "application-private" : "shared",
          ...(suggestions.length
            ? { clarify: { question: result.reply ?? COPY.agentUnclear, choices: suggestions, allowFreeText: true, said: trimmed } }
            : {}),
        });
      }
      wire.end(turn, { outcome: "ok" });
      setText("");
      setClarifyOf(null);
    } finally {
      // A turn that threw is closed here; a closed one is left alone.
      if (wire.isOpen(turn)) wire.end(turn, { outcome: "error", note: "failed" });
      spatial.setAgentBusy(false);
    }
  };

  const submitText = () => {
    const now = new Date();
    const offline = !agentOnly ? preparsedPayloads(text, facets, hasOwnOrigin, now, timezone) : null;
    if (offline) {
      for (const need of offline) submitPlain(need.payload, saidLabel(text), need.assumed);
      return;
    }
    if (nlAvailable) return void submitSentence(text);
    submitPlain(agentOnly ? null : payloadFromText(text, facets, { now, timezone }), saidLabel(text));
  };

  const scopeLabel = SCOPES.find((s) => s.value === scope)!.label;
  const canType = !disabled && !busy && (nlAvailable || !agentOnly);
  const placeholder = agentOnly
    ? nlAvailable
      ? "…what your agent should hold for you"
      : "your agent keeps the condition"
    : nlAvailable
      ? "…or say it, or ask"
      : "…or say it yourself";

  return (
    <div className="composer" data-testid="composer" data-busy={busy || undefined}>
      {busy ? (
        <div className="composer-suggest-label" data-tone="act" role="status" data-testid="agent-busy">
          <i className="busy-ring row-busy" aria-hidden="true" />
          {agentPhase === "applying" ? COPY.agentApplying(placeCount) : COPY.agentReading}
        </div>
      ) : (
        pills.length > 0 &&
        !agentOnly && (
          <>
            <div className="composer-suggest-label">Also worth asking for</div>
            <div
              className="pill-row"
              data-testid="facet-pills"
              data-overflow={pillOverflow ?? undefined}
              ref={pillRowRef}
            >
              {pills.map((f) => (
                <button
                  key={f.key}
                  className="pill"
                  data-testid={`pill-${f.key}`}
                  disabled={disabled}
                  onClick={() => submitPlain(payloadFromFacet(f), f.label)}
                >
                  {f.label}
                  <span className="pill-count">{(f.counts.yes ?? 0) + (f.counts.likely ?? 0)}</span>
                </button>
              ))}
            </div>
          </>
        )
      )}

      {/* The bar clips its own overflow (so the Add button squares off against
          the rounded corner), so the scope menu lives on the wrapper instead —
          inside the bar it would be silently cut off. */}
      <div className="composer-bar-wrap">
        {scopeOpen && (
          <div className="scope-menu" role="menu">
            {SCOPES.map((s) => (
              <button
                key={s.value}
                role="menuitemradio"
                aria-checked={s.value === scope}
                data-scope={s.value}
                data-testid={`scope-${s.value}`}
                onClick={() => {
                  setScope(s.value);
                  setScopeOpen(false);
                  inputRef.current?.focus();
                }}
              >
                <span className="scope-option-label">{s.label}</span>
                <span className="scope-option-means">{s.means}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-bar" data-active={text.length > 0 || undefined}>
        <span className="composer-scope">
          <button
            className="scope-chip"
            data-scope={scope}
            data-testid="composer-scope"
            aria-haspopup="true"
            aria-expanded={scopeOpen}
            onClick={() => setScopeOpen((v) => !v)}
          >
            {scopeLabel}
            <span className="scope-caret" aria-hidden="true" />
          </button>
        </span>

        <input
          ref={inputRef}
          className="composer-input"
          type="text"
          maxLength={300}
          value={agentOnly && !nlAvailable ? "" : text}
          disabled={!canType}
          aria-label="What matters to you?"
          placeholder={placeholder}
          onFocus={holdFrame}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (text.trim() || (agentOnly && !nlAvailable))) {
              e.preventDefault();
              submitText();
            }
          }}
        />

        <button
          className="composer-add"
          data-testid="composer-add"
          disabled={
            disabled || busy || (text.trim().length === 0 && !(agentOnly && !nlAvailable))
          }
          onClick={submitText}
        >
          Add
        </button>
        </div>
      </div>
    </div>
  );
}

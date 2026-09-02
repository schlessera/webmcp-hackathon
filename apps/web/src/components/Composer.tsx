import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ATTRIBUTE_LABELS, ATTRIBUTE_VOCABULARY } from "@webmcp-hackathon/contracts";
import { nlCondition, nlSay } from "../api.ts";
import { diagnostics } from "../diagnostics-store.ts";
import { spatial } from "../spatial-store.ts";
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

const SCOPES: Array<{ value: Visibility; label: string }> = [
  { value: "shared", label: "Shared" },
  { value: "application-private", label: "Private" },
  { value: "agent-private", label: "Agent only" },
];

const ATTRIBUTE_KEYS = new Set<string>(ATTRIBUTE_VOCABULARY);
const LABEL_TO_KEY = new Map<string, string>(
  Object.entries(ATTRIBUTE_LABELS).map(([key, label]) => [label.toLowerCase(), key]),
);

type Payload = Record<string, unknown>;

/**
 * Free text → a requirement payload, without an agent. Three protocol-level
 * attempts, then an honest fallback:
 *   1. the text names a facet the server sent → that attribute
 *   2. it reads as money → a budget
 *   3. it reads as minutes → a walking-distance scope
 *   4. otherwise a `text` predicate, which rules nothing out and marks every
 *      place pending, because nothing about it has been checked.
 * There is no domain parsing beyond the labels the server itself supplied.
 */
export function payloadFromText(text: string, facets: Facet[]): Payload {
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
  intent?: "need" | "ask" | "act" | "unclear";
  needs?: Array<{ payload: Payload; topic?: string; gist: string }>;
  reply?: string | null;
  actions?: Array<{ tool: string; ok: boolean; effect: string }>;
  meta?: { route?: { model: string; ms: number }; agent?: { model: string; ms: number; rounds: number } };
  error?: { code: string; message: string };
}

interface Props {
  facets: Facet[];
  activeNeeds: ActiveNeed[];
  disabled: boolean;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

export function Composer({ facets, activeNeeds, disabled, run }: Props) {
  const [scope, setScope] = useState<Visibility>("shared");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const nlAvailable = useSyncExternalStore(
    (cb) => diagnostics.subscribe(cb),
    () => diagnostics.state.nlAvailable,
  );
  const busy = useSyncExternalStore(
    (cb) => spatial.subscribe(cb),
    () => spatial.state.agentBusy,
  );

  const stated = useMemo(
    () => new Set(activeNeeds.map((n) => n.label.toLowerCase())),
    [activeNeeds],
  );

  /* Top three yes/no facets nobody has stated yet, most available first.
     Order comes from the server; we only drop what is already a need. */
  const pills = useMemo(
    () =>
      facets
        .filter(
          (f) =>
            f.type === "boolean" &&
            (f.counts.yes ?? 0) > 0 &&
            !stated.has(f.label.toLowerCase()),
        )
        .slice(0, 3),
    [facets, stated],
  );

  const agentOnly = scope === "agent-private";

  // The topic the agent read off a sentence is deliberately NOT attached as
  // a scope hint: disclosing a category is the owner's opt-in (FACETS.md §4)
  // and the composer offers no way to give it yet.
  const submitPayload = (payload: Payload | null) =>
    run("SubmitRequirement", {
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
    });

  /** A pill or a sentence without an agent: the label match, then the bus. */
  const submitPlain = (payload: Payload | null) => {
    if (disabled) return;
    void submitPayload(payload);
    setText("");
  };

  /** A sentence with an agent: route it, then act on what came back. */
  const submitSentence = async (sentence: string) => {
    if (disabled || busy) return;
    const trimmed = sentence.trim();
    if (!trimmed) return;
    spatial.setAgentBusy(true);
    try {
      if (agentOnly) {
        const result = (await nlCondition(trimmed)) as SayResult & { topic?: string | null };
        if (!result.ok) {
          diagnostics.log(`agent condition refused: ${result.error?.code}`);
          // The declaration still stands; the agent simply holds nothing.
          void submitPayload(null);
        } else {
          diagnostics.log(`agent holds a condition (${result.meta?.route?.model} ${result.meta?.route?.ms}ms)`);
          spatial.pushAgentReply({ text: COPY.agentHolds, actions: [], answer: true });
        }
        setText("");
        return;
      }
      const result = (await nlSay(trimmed, scope)) as SayResult;
      if (!result.ok) {
        // No agent to be had: the label match is the honest fallback.
        diagnostics.log(`agent unavailable (${result.error?.code}); label match used`);
        void submitPayload(payloadFromText(trimmed, facets));
        setText("");
        return;
      }
      const route = result.meta?.route;
      const agent = result.meta?.agent;
      diagnostics.log(
        `agent routed "${result.intent}" (${route?.model} ${route?.ms}ms${
          agent ? `; ${agent.model} ${agent.ms}ms, ${agent.rounds} rounds` : ""
        })`,
      );
      if (result.intent === "need") {
        for (const need of result.needs ?? []) await submitPayload(need.payload);
      } else if (result.intent === "ask" || result.intent === "act") {
        spatial.pushAgentReply({
          text: result.reply ?? "",
          actions: result.actions ?? [],
          answer: result.intent === "ask",
        });
        void spatial.refetch();
      } else {
        spatial.pushAgentReply({
          text: result.reply ?? COPY.agentUnclear,
          actions: [],
          answer: true,
        });
      }
      setText("");
    } finally {
      spatial.setAgentBusy(false);
    }
  };

  const submitText = () => {
    if (nlAvailable) return void submitSentence(text);
    submitPlain(agentOnly ? null : payloadFromText(text, facets));
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
          {COPY.agentBusy}
        </div>
      ) : (
        pills.length > 0 &&
        !agentOnly && (
          <>
            <div className="composer-suggest-label">Also worth asking for</div>
            <div className="pill-row" data-testid="facet-pills">
              {pills.map((f) => (
                <button
                  key={f.key}
                  className="pill"
                  data-testid={`pill-${f.key}`}
                  disabled={disabled}
                  onClick={() => submitPlain(payloadFromFacet(f))}
                >
                  {f.label}
                  <span className="pill-count">{f.counts.yes}</span>
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
                data-testid={`scope-${s.value}`}
                onClick={() => {
                  setScope(s.value);
                  setScopeOpen(false);
                  inputRef.current?.focus();
                }}
              >
                {s.label}
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

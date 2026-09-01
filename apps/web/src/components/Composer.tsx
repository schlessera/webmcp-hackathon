import { useMemo, useRef, useState } from "react";
import { ATTRIBUTE_LABELS, ATTRIBUTE_VOCABULARY } from "@webmcp-hackathon/contracts";
import type {
  ActiveNeed,
  CommandEnvelope,
  Facet,
  Visibility,
} from "../spatial-types.ts";

/**
 * The composer. One bar: scope chosen on the LEFT, before speaking; a
 * transparent field; `Add` flush right as a word, never a glyph
 * (SPOKES-UI §5).
 *
 * Above it, suggestion pills generated from the facets the server returned
 * for the current set. The app ships zero domain chips: every pill's text is
 * a server `label`, and the only branch is on facet `type` — protocol, not
 * domain (FACETS.md §1).
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
 * Free text → a requirement payload. Three protocol-level attempts, then an
 * honest fallback:
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
  const byLabel = LABEL_TO_KEY.get(t);
  if (byLabel && ATTRIBUTE_KEYS.has(byLabel) && byLabel !== "cuisine" && byLabel !== "price-level") {
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
  if (facet.key === "cuisine" && value) {
    return { kind: "exclusion", key: "cuisine", values: [value], lifetime: "session" };
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

  const submit = (payload: Payload | null) => {
    if (disabled) return;
    // An agent-private need is a DECLARATION: the server never receives its
    // content, so no payload is sent with it (commands.ts SubmitRequirement).
    void run("SubmitRequirement", {
      visibility: scope,
      hardness: "hard",
      delegation: { mode: "approval_required" },
      ...(agentOnly
        ? { scopeHint: { affects: "candidate-eligibility" } }
        : payload
          ? { payload }
          : {}),
    });
    setText("");
  };

  const scopeLabel = SCOPES.find((s) => s.value === scope)!.label;

  return (
    <div className="composer" data-testid="composer">
      {pills.length > 0 && !agentOnly && (
        <>
          <div className="composer-suggest-label">Also worth asking for</div>
          <div className="pill-row" data-testid="facet-pills">
            {pills.map((f) => (
              <button
                key={f.key}
                className="pill"
                data-testid={`pill-${f.key}`}
                disabled={disabled}
                onClick={() => submit(payloadFromFacet(f))}
              >
                {f.label}
                <span className="pill-count">{f.counts.yes}</span>
              </button>
            ))}
          </div>
        </>
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
          maxLength={200}
          value={agentOnly ? "" : text}
          disabled={disabled || agentOnly}
          aria-label="What matters to you?"
          placeholder={
            agentOnly ? "your agent keeps the condition" : "…or say it yourself"
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (text.trim() || agentOnly)) {
              e.preventDefault();
              submit(agentOnly ? null : payloadFromText(text, facets));
            }
          }}
        />

        <button
          className="composer-add"
          data-testid="composer-add"
          disabled={disabled || (!agentOnly && text.trim().length === 0)}
          onClick={() => submit(agentOnly ? null : payloadFromText(text, facets))}
        >
          Add
        </button>
        </div>
      </div>
    </div>
  );
}

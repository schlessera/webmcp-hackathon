import type React from "react";
import { PROTOCOL_VERSIONS, TOOL_CONTRACT_VERSION } from "@webmcp-hackathon/contracts";
import type { DiagnosticsState } from "../diagnostics-store.ts";
import type { SessionIdentity } from "../session.ts";
import type { CommandEnvelope, SpatialContext } from "../spatial-types.ts";
import type { LookupReason, PendingNeed } from "../spatial-store.ts";
import { COPY } from "../ui/copy.ts";

/**
 * The `{ }` drawer.
 *
 * EVERYTHING protocol-shaped lives here and nowhere else (CLAUDE.md §6):
 * tool names, JSON, MCP vocabulary, version strings, connection internals,
 * timing, raw payloads, the phase enum, the feasibility state, the revision.
 * If any of it surfaces in the main UI, that is a bug.
 *
 * It is deliberately styled as a tool, not a feature: ink ground, cream,
 * mono throughout, no shadows or tints from the app's palette.
 */

interface Props {
  identity: SessionIdentity;
  diagnostics: DiagnosticsState;
  context: SpatialContext | null;
  revision: number;
  /** Presentation-only frames the page is holding right now. */
  busy: string[];
  busyReason: LookupReason | null;
  pendingNeeds: PendingNeed[];
  onClose(): void;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

export function Drawer({
  identity,
  diagnostics,
  context,
  revision,
  busy,
  busyReason,
  pendingNeeds,
  onClose,
  run,
}: Props) {
  /* Collapsible groups (W13): the raw dumps are long; the drawer opens on
     the state that matters and folds the rest. Native <details>: no state
     to keep, keyboard for free. */
  const Section = ({
    title,
    open,
    children,
  }: {
    title: string;
    open?: boolean;
    children: React.ReactNode;
  }) => (
    <details className="drawer-section" open={open}>
      <summary className="drawer-section-title">{title}</summary>
      {children}
    </details>
  );
  return (
    <div className="drawer" data-testid="diagnostics" role="dialog" aria-label="Under the hood">
      <button className="drawer-scrim" aria-label="Close" onClick={onClose} />
      <div className="drawer-panel">
        <div className="drawer-head">
          <div className="drawer-head-row">
            <span className="drawer-title">{"{ } under the hood"}</span>
            <button className="drawer-close" data-testid="close-drawer" onClick={onClose}>
              Close
            </button>
          </div>
          <span className="drawer-chip">{COPY.reassurance}</span>
        </div>

        <div className="drawer-body">
          {context?.area && (
            <Section title="places" open>
              <div className="drawer-kv">
                <span>
                  area <code data-testid="diag-area">{context.area.areaId}</code>
                </span>
                <span>
                  source <code>{context.area.kind}</code>
                </span>
                <span>
                  extract <code>{context.area.dataAsOf}</code>
                </span>
                <span>
                  pool {context.pool?.size ?? context.area.poolSize}
                  {context.pool ? ` / cap ${context.pool.cap}` : ""} of {context.area.focusVenues} within reach
                </span>
              </div>
            </Section>
          )}
          <Section title="session" open>
            <div className="drawer-kv">
              <span>
                room <code data-testid="room-id">{identity.roomId}</code>
              </span>
              <span>
                you <code data-testid="participant-id">{identity.participantId}</code>
              </span>
              <span data-testid="role">role {identity.role}</span>
              <span data-testid="display-name">as {identity.displayName}</span>
              <span>
                rev <strong data-testid="revision">{revision}</strong>
              </span>
              <span>
                build <code data-testid="build-id">{diagnostics.buildId ?? "…"}</code>
              </span>
              <span>
                server build <code data-testid="diag-server-build">{diagnostics.serverBuildId ?? "…"}</code>
              </span>
              <span>
                contract v<span data-testid="contract-version">{TOOL_CONTRACT_VERSION}</span>
              </span>
              <span>
                <code data-testid="protocols">
                  negotiation/{PROTOCOL_VERSIONS.negotiation} {PROTOCOL_VERSIONS.domain}
                </code>
              </span>
            </div>
          </Section>

          <Section title="connection" open>
            <div className="drawer-kv">
              <span>
                document.modelContext{" "}
                <strong data-testid="diag-modelcontext">
                  {diagnostics.modelContextPresent ? "present" : "absent"}
                </strong>
              </span>
              <span>
                registration <strong data-testid="diag-registration">{diagnostics.registration}</strong>
              </span>
              <span>
                websocket{" "}
                <strong
                  className={diagnostics.wsState === "open" ? "drawer-ok" : undefined}
                  data-testid="diag-ws"
                >
                  {diagnostics.wsState}
                </strong>
              </span>
              {diagnostics.registrationError && (
                <span role="alert">{diagnostics.registrationError}</span>
              )}
            </div>
          </Section>

          <Section title="in flight" open>
            <div className="drawer-kv" data-testid="diag-inflight">
              <span>
                lookups pending <strong data-testid="diag-lookups">{busy.length}</strong>
                {busyReason ? ` (${busyReason.kind}${busyReason.label ? `: ${busyReason.label}` : ""})` : ""}
              </span>
              <span>
                pending needs <strong>{pendingNeeds.length}</strong>
                {pendingNeeds.length > 0
                  ? ` — ${pendingNeeds.map((n) => `${n.label}${n.needId ? ` → ${n.needId}` : n.committedAt ? " (committed)" : " (sent)"}`).join("; ")}`
                  : ""}
              </span>
              {busy.length > 0 && <code>{busy.join(" ")}</code>}
            </div>
          </Section>

          {context && (
            <Section title="state" open>
              <div className="drawer-kv">
                <span data-testid="phase-chip">phase {context.phase}</span>
                <span data-testid="feasibility-chip">
                  feasibility {context.feasibility.state} · {context.feasibility.eligible}/
                  {context.total} · {context.feasibility.uncertain} uncertain
                </span>
                <span>scope {Math.round(context.scope.area.radiusM)} m</span>
                <span>category {context.scope.category}</span>
              </div>
            </Section>
          )}

          <Section title="what crossed the wire" open>
            <pre className="drawer-log" data-testid="diag-log">
              {diagnostics.lines.join("\n")}
            </pre>
          </Section>

          {context && (
            <>
              <Section title={`candidates (raw, ${context.candidates.length})`}>
                <pre className="drawer-json" data-testid="raw-candidates">
                  {JSON.stringify(context.candidates, null, 1)}
                </pre>
              </Section>
              <Section title={`facets (raw, ${context.facets.length})`}>
                <pre className="drawer-json" data-testid="raw-facets">
                  {JSON.stringify(context.facets, null, 1)}
                </pre>
              </Section>
            </>
          )}

          <Section title="put a command on the wire" open>
            <div className="drawer-actions">
              <button
                className="drawer-btn"
                data-testid="submit-shared"
                onClick={() =>
                  void run("SubmitRequirement", {
                    visibility: "shared",
                    hardness: "hard",
                    delegation: { mode: "approval_required" },
                    payload: {
                      kind: "attribute",
                      key: "vegetarian-options",
                      expect: "verified_true",
                    },
                  })
                }
              >
                SubmitRequirement · attribute · shared
              </button>
              <button
                className="drawer-btn"
                data-testid="submit-private"
                onClick={() =>
                  void run("SubmitRequirement", {
                    visibility: "application-private",
                    hardness: "hard",
                    delegation: { mode: "approval_required" },
                    payload: {
                      kind: "budget",
                      perPersonMax: { amount: 18, currency: "EUR" },
                    },
                  })
                }
              >
                SubmitRequirement · budget · application-private
              </button>
              <button
                className="drawer-btn"
                data-testid="declare-agent-private"
                onClick={() =>
                  void run("SubmitRequirement", {
                    visibility: "agent-private",
                    hardness: "hard",
                    delegation: { mode: "approval_required" },
                    scopeHint: { affects: "candidate-eligibility" },
                  })
                }
              >
                SubmitRequirement · declaration · agent-private
              </button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

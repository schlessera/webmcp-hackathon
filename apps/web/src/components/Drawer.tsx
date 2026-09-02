import { PROTOCOL_VERSIONS, TOOL_CONTRACT_VERSION } from "@webmcp-hackathon/contracts";
import type { DiagnosticsState } from "../diagnostics-store.ts";
import type { SessionIdentity } from "../session.ts";
import type { CommandEnvelope, SpatialContext } from "../spatial-types.ts";
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
  onClose(): void;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

export function Drawer({
  identity,
  diagnostics,
  context,
  revision,
  onClose,
  run,
}: Props) {
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
            <div className="drawer-section">
              <div className="drawer-section-title">places</div>
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
                  pool {context.area.poolSize} of {context.area.focusVenues} within reach
                </span>
              </div>
            </div>
          )}
          <div className="drawer-section">
            <div className="drawer-section-title">session</div>
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
          </div>

          <div className="drawer-section">
            <div className="drawer-section-title">connection</div>
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
          </div>

          {context && (
            <div className="drawer-section">
              <div className="drawer-section-title">state</div>
              <div className="drawer-kv">
                <span data-testid="phase-chip">phase {context.phase}</span>
                <span data-testid="feasibility-chip">
                  feasibility {context.feasibility.state} · {context.feasibility.eligible}/
                  {context.total} · {context.feasibility.uncertain} uncertain
                </span>
                <span>scope {Math.round(context.scope.area.radiusM)} m</span>
                <span>category {context.scope.category}</span>
              </div>
            </div>
          )}

          <div className="drawer-section">
            <div className="drawer-section-title">what crossed the wire</div>
            <pre className="drawer-log" data-testid="diag-log">
              {diagnostics.lines.join("\n")}
            </pre>
          </div>

          {context && (
            <>
              <div className="drawer-section">
                <div className="drawer-section-title">candidates (raw)</div>
                <pre className="drawer-json" data-testid="raw-candidates">
                  {JSON.stringify(context.candidates, null, 1)}
                </pre>
              </div>
              <div className="drawer-section">
                <div className="drawer-section-title">facets (raw)</div>
                <pre className="drawer-json" data-testid="raw-facets">
                  {JSON.stringify(context.facets, null, 1)}
                </pre>
              </div>
            </>
          )}

          <div className="drawer-section">
            <div className="drawer-section-title">put a command on the wire</div>
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
          </div>
        </div>
      </div>
    </div>
  );
}

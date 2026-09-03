import { useRef } from "react";
import type { ProjectedEvent } from "@webmcp-hackathon/contracts";
import type { AgentReply, PendingNeed } from "../spatial-store.ts";
import type {
  ActiveNeed,
  CommandEnvelope,
  ParticipantSummary,
  PrivateEffect,
} from "../spatial-types.ts";
import { COPY, initials, joinNames, personColor, ruledOutLabel } from "../ui/copy.ts";

/**
 * "What matters" — the group's stated needs, each toggleable, each carrying
 * what it costs. This replaces every predefined filter control: the app ships
 * zero domain chips and every row's text is a server label (CLAUDE.md §1).
 *
 * Press and hold previews the set WITHOUT that need, live on the map, and
 * restores on release. It is the core gesture of the app (§7), so it has a
 * keyboard equivalent (focus the row, hold Space) and an aria-live count.
 */

const HOLD_MS = 220;

interface RowProps {
  need: ActiveNeed;
  ownerName: string | null;
  isOwn: boolean;
  /** Only the author may set a need aside (server-enforced, owner-only), so
      a peer's row draws no toggle rather than a control that would fail. */
  canToggle: boolean;
  justApplied: boolean;
  previewing: boolean;
  /** Said, committed, and the room is still checking places for it. */
  pending: boolean;
  /** How many places are being looked up right now (for the pending text). */
  busyCount: number;
  onToggle(): void;
  onHoldStart(): void;
  onHoldEnd(): void;
}

/** "checking 12 places…" / "checking…" (COPY.md in progress). */
function checkingText(busyCount: number): string {
  return busyCount > 0 ? `checking ${busyCount} place${busyCount === 1 ? "" : "s"}…` : "checking…";
}

function NeedRow({
  need,
  ownerName,
  isOwn,
  canToggle,
  justApplied,
  previewing,
  pending,
  busyCount,
  onToggle,
  onHoldStart,
  onHoldEnd,
}: RowProps) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);

  const isPrivate = need.visibility !== "shared";
  const variant = isPrivate
    ? "private"
    : need.unknown > 0
      ? "unsure"
      : justApplied
        ? "applied"
        : "shared";

  const beginHold = () => {
    held.current = false;
    timer.current = window.setTimeout(() => {
      held.current = true;
      onHoldStart();
    }, HOLD_MS);
  };
  const endHold = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (held.current) {
      held.current = false;
      onHoldEnd();
      return true;
    }
    return false;
  };

  return (
    <button
      type="button"
      className="need-row"
      data-variant={variant}
      data-inactive={!need.active || undefined}
      data-previewing={previewing || undefined}
      data-pending={pending || undefined}
      data-kind={need.criterionId?.startsWith("q:") ? "question" : undefined}
      data-testid={`need-${need.id}`}
      aria-pressed={need.active}
      aria-busy={pending || undefined}
      aria-describedby="brief-preview-count"
      onPointerDown={(e) => {
        // Capture so the release always lands here even if the finger drifts.
        // NOTE: setting capture retargets the pointer and fires pointerleave
        // on the old chain, so this row must NOT end the hold on leave — that
        // pairing silently cancels every press before it starts.
        e.currentTarget.setPointerCapture?.(e.pointerId);
        beginHold();
      }}
      onPointerUp={() => {
        if (!endHold() && canToggle) onToggle();
      }}
      onPointerCancel={endHold}
      onKeyDown={(e) => {
        if (e.key === " " && !e.repeat) {
          e.preventDefault();
          held.current = true;
          onHoldStart();
        } else if (e.key === "Enter" && canToggle) {
          e.preventDefault();
          onToggle();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " && held.current) {
          held.current = false;
          onHoldEnd();
        }
      }}
    >
      {canToggle && (
        <span
          className="need-toggle"
          data-on={need.active}
          data-tone={isPrivate ? "private" : need.unknown > 0 ? "unsure" : "works"}
          aria-hidden="true"
        />
      )}
      <span className="need-label">
        {need.label}
        {!isOwn && ownerName && <span className="need-author"> · {ownerName}</span>}
        {need.criterionId?.startsWith("q:") &&
          (need.likely ?? 0) + (need.unlikely ?? 0) > 0 && (
            <span className="need-looked" data-testid="need-looked">
              {" "}
              · {COPY.lookedUp}
            </span>
          )}
      </span>
      <span className="need-badges">
      {(need.likely ?? 0) > 0 && (
        <span className="badge" data-kind="likely">
          {need.likely} likely
        </span>
      )}
      {(need.unlikely ?? 0) > 0 && (
        <span className="badge" data-kind="unlikely">
          {need.unlikely} unlikely
        </span>
      )}
      {pending ? (
        <span className="need-pending" data-testid="need-pending">
          <i className="busy-ring row-busy" aria-hidden="true" />
          {checkingText(busyCount)}
        </span>
      ) : need.unknown > 0 ? (
        <span className="badge" data-kind="unsure">
          {need.unknown} unknown
        </span>
      ) : isPrivate ? (
        <span className="badge" data-kind="scope">
          private
        </span>
      ) : (
        <span className="need-delta">{ruledOutLabel(need.ruledOut)}</span>
      )}
      </span>
    </button>
  );
}

interface NeedsProps {
  needs: ActiveNeed[];
  privateEffects: PrivateEffect[];
  participants: ParticipantSummary[];
  meId: string;
  /** Display names of the people invited who have not opened the room yet. */
  absent: string[];
  justAppliedId: string | null;
  previewNeedId: string | null;
  /** Needs this page said that have not settled yet (store truth). */
  pendingNeeds: PendingNeed[];
  busyCount: number;
  /** The room holds no places at all. */
  noPlaces: boolean;
  matching: number;
  onToggle(need: ActiveNeed): void;
  onHoldStart(need: ActiveNeed): void;
  onHoldEnd(): void;
}

export function NeedsSection({
  needs,
  privateEffects,
  participants,
  meId,
  absent,
  justAppliedId,
  previewNeedId,
  pendingNeeds,
  busyCount,
  noPlaces,
  matching,
  onToggle,
  onHoldStart,
  onHoldEnd,
}: NeedsProps) {
  const nameOf = (id: string) =>
    participants.find((p) => p.participantId === id)?.displayName ?? null;
  /* Rows the room has not shown yet: a need said a moment ago exists on the
     brief at once, in the person's own words, dashed, and settles into its
     real row when the context brings it (the bound ones render there). */
  const provisional = pendingNeeds.filter((n) => n.needId === null);
  const pendingIds = new Set(pendingNeeds.map((n) => n.needId).filter(Boolean));
  const empty =
    needs.length === 0 && privateEffects.length === 0 && provisional.length === 0;
  const anyPending = pendingNeeds.length > 0;
  const held = previewNeedId ? needs.find((n) => n.id === previewNeedId) : undefined;

  return (
    <section data-testid="brief-needs">
      <div className="section-head">
        <span className="section-title">What matters</span>
        {!empty && (
          <span className="section-count">{needs.length + privateEffects.length}</span>
        )}
        {/* While a row is held the hint names the preview (W11); a bare
            instruction the rest of the time. */}
        {!empty &&
          (held ? (
            <span className="section-hint" data-tone="preview" data-testid="preview-label">
              previewing without “{held.label}”
            </span>
          ) : (
            <span className="section-hint">{COPY.holdHint}</span>
          ))}
      </div>

      {/* The press-and-hold count, announced politely (SPOKES-UI §11). While
          a need is pending the region is busy, so the count is announced once
          when it settles rather than at every interim step. */}
      <span
        id="brief-preview-count"
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-busy={anyPending || undefined}
      >
        {matching} still work
      </span>

      {noPlaces ? (
        <p className="empty-note" data-testid="brief-no-places">
          {COPY.noCandidates}
        </p>
      ) : empty ? (
        <p className="empty-note" data-testid="brief-empty">
          {COPY.emptyRoom}
        </p>
      ) : null}

      {/* Mockup 7a: who has not opened the link yet. The card is status, not
          an action — invite links are minted per person and never come back
          to the page, so there is nothing here to send. */}
      {absent.length > 0 && (
        <div className="invite-card" data-testid="invite-card">
          <div className="invite-title">
            {joinNames(absent)} {absent.length === 1 ? "hasn't" : "haven't"} arrived
          </div>
          <div className="invite-body">
            They'll see the map exactly as it stands when they open the link.
          </div>
        </div>
      )}

      {empty ? null : (
        <div className="need-list">
          {needs.map((n) => (
            <NeedRow
              key={n.id}
              need={n}
              isOwn={n.ownerId === meId}
              canToggle={n.ownerId === meId}
              ownerName={nameOf(n.ownerId)}
              justApplied={n.id === justAppliedId && !pendingIds.has(n.id)}
              previewing={n.id === previewNeedId}
              pending={pendingIds.has(n.id)}
              busyCount={busyCount}
              onToggle={() => onToggle(n)}
              onHoldStart={() => onHoldStart(n)}
              onHoldEnd={onHoldEnd}
            />
          ))}

          {provisional.map((n) => (
            <div
              key={n.localId}
              className="need-row"
              data-variant={n.visibility === "shared" ? "shared" : "private"}
              data-pending="true"
              data-provisional="true"
              data-testid="need-provisional"
              aria-busy="true"
            >
              <span className="need-label">{n.label}</span>
              <span className="need-pending">
                <i className="busy-ring row-busy" aria-hidden="true" />
                {n.committedAt === null ? "saying it…" : checkingText(busyCount)}
              </span>
            </div>
          ))}

          {/* A peer's private need: its EFFECT is public, its CONTENT never
              leaves its owner's client (CLAUDE.md §5). No label beyond the
              coarse topic the owner opted into, no toggle, no shadow. */}
          {privateEffects.map((e, i) => (
            <div
              key={`${e.owner}-${i}`}
              className="need-row"
              data-variant="peer-private"
              data-testid="private-effect"
            >
              <span className="need-label">
                A private condition{e.topic ? ` about ${e.topic}` : ""}
              </span>
              {e.ruledOut > 0 && (
                <span className="need-delta">−{e.ruledOut}</span>
              )}
              <span className="badge" data-kind="scope-quiet">
                private
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── Impasse: the ways out, each quantified ──────────────────────────────
   Offers are consequences, never instructions (COPY.md deltas). */

interface WaysOutProps {
  needs: ActiveNeed[];
  participants: ParticipantSummary[];
  meId: string;
  onRelax(need: ActiveNeed): void;
}

export function WaysOut({ needs, participants, meId, onRelax }: WaysOutProps) {
  const options = needs
    .filter((n) => n.active && n.wouldReturn > 0)
    .sort((a, b) => b.wouldReturn - a.wouldReturn)
    .slice(0, 2);
  if (options.length === 0) return null;

  const nameOf = (id: string) =>
    participants.find((p) => p.participantId === id)?.displayName ?? "someone";

  return (
    <section data-testid="ways-out">
      <div className="section-head">
        <span className="section-title" data-tone="unsure">
          {options.length === 1 ? "One way out" : "Two ways out"}
        </span>
      </div>
      {options.map((n) => {
        const own = n.ownerId === meId;
        return (
          <div
            key={n.id}
            className="card"
            data-tone={own ? "works" : "scope"}
            data-testid={`way-out-${n.id}`}
          >
            <div className="card-head">
              <span className="card-title">
                {own
                  ? `Let “${n.label}” be nice-to-have`
                  : `${nameOf(n.ownerId)} could set “${n.label}” aside`}
              </span>
              <span className="card-delta">+{n.wouldReturn}</span>
            </div>
            <div className="card-body">
              {own
                ? `${n.wouldReturn} place${n.wouldReturn === 1 ? "" : "s"} come${n.wouldReturn === 1 ? "s" : ""} back if this stops ruling places out.`
                : "It is theirs to set aside — you can ask them in the room."}
            </div>
            {own && (
              <div className="card-actions">
                <button
                  className="btn"
                  data-tone="works"
                  data-testid={`relax-${n.id}`}
                  onClick={() => onRelax(n)}
                >
                  Make it optional
                </button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/* ── Late join: a digest, not a feed to scroll ───────────────────────────
   Peers' private moves appear as effects, never as contents (§5). */

/**
 * Bookkeeping the room does not need to read back. The count block already
 * says how many places still work, so a per-revision recount is churn — and
 * its server text speaks in wire vocabulary, which invariant 6 keeps out of
 * the main UI.
 */
const DIGEST_NOISE = new Set([
  "candidates_updated",
  "phase_changed",
  "ready_state_changed",
  "session_created",
  "evaluation_requested",
  "evaluation_recorded",
]);

/**
 * The server composes event text in wire vocabulary for agent surfaces; the
 * room reads a record in its own words (CLAUDE.md §6, §12). Types the room
 * cares about are rephrased here; everything else keeps the server line.
 */
export function recordText(e: ProjectedEvent, meId: string): string {
  const p = (e.payload ?? {}) as { candidateName?: string };
  switch (e.type) {
    case "agreement_committed":
      return `${e.actorId === meId ? "You" : "The organizer"} settled it${
        p.candidateName ? `: ${p.candidateName}` : ""
      }`;
    case "agreement_staged":
      return `${e.actorId === meId ? "You" : "The organizer"} staged the agreement${
        p.candidateName ? ` on ${p.candidateName}` : ""
      }`;
    case "impasse_detected":
      return "Nothing worked for everyone";
    case "impasse_resolved":
      return "Something works again";
    default:
      return e.text;
  }
}

export function meaningfulEvents(events: ProjectedEvent[]): ProjectedEvent[] {
  return events.filter((e) => !DIGEST_NOISE.has(e.type));
}

interface DigestProps {
  events: ProjectedEvent[];
  privateEffects: PrivateEffect[];
  participants: ParticipantSummary[];
  meId: string;
}

export function Digest({ events, privateEffects, participants, meId }: DigestProps) {
  const rows = meaningfulEvents(events);
  if (rows.length === 0) return null;

  return (
    <section data-testid="digest">
      <div className="section-head">
        <span className="section-title">While you were away</span>
      </div>
      <div className="record-list">
        {rows.slice(0, 6).map((e) => {
          // A full-level row names its author (mockup 7d: initials in the
          // person's colour); a move whose content the room may not see
          // carries the `?` chip instead (CLAUDE.md §5); council rows, neither.
          const hidden = e.level !== "full";
          const actorIndex = e.actorId
            ? participants.findIndex((p) => p.participantId === e.actorId)
            : -1;
          const actor = actorIndex >= 0 ? participants[actorIndex] : null;
          return (
            <div
              className="record-row"
              key={`${e.revision}-${e.type}`}
              data-private={hidden || undefined}
            >
              {hidden ? (
                <span className="record-avatar" data-anonymous="true" aria-hidden="true">
                  ?
                </span>
              ) : actor ? (
                <span
                  className="record-avatar"
                  style={{ background: personColor(actorIndex) }}
                  data-testid={`digest-actor-${actor.participantId}`}
                  aria-hidden="true"
                >
                  {initials(actor.displayName)}
                </span>
              ) : (
                <span className="record-spacer" aria-hidden="true" />
              )}
              <span className="record-text">{recordText(e, meId)}</span>
            </div>
          );
        })}
        {privateEffects
          .filter((p) => p.ruledOut > 0)
          .map((p, i) => (
            <div className="record-row" data-private="true" key={`pe-${i}`}>
              <span className="record-avatar" data-anonymous="true" aria-hidden="true">
                ?
              </span>
              <span className="record-text">
                A private condition ruled {p.ruledOut} out
              </span>
              <span className="record-delta">−{p.ruledOut}</span>
            </div>
          ))}
      </div>
    </section>
  );
}

/* ── Agreed: the short record of how it got here ─────────────────────────── */

export function History({ events, meId }: { events: ProjectedEvent[]; meId: string }) {
  const ordered = meaningfulEvents(events).reverse();
  if (ordered.length === 0) return null;
  return (
    <section data-testid="history">
      <div className="section-head">
        <span className="section-title">How it got here</span>
      </div>
      <div className="record-list">
        {ordered.slice(-8).map((e, i) => (
          <div
            className="record-row"
            key={`${e.revision}-${e.type}`}
            data-private={e.level !== "full" || undefined}
          >
            <span className="record-index">{String(i + 1).padStart(2, "0")}</span>
            <span className="record-text">{recordText(e, meId)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Ready toggle ────────────────────────────────────────────────────────
   Small and quiet: the phase machine needs it, the room does not read it.
   It mirrors the roster (server truth) — accepting a place also marks you
   ready, and this is where that shows. */

export function ReadyToggle({
  ready,
  run,
}: {
  ready: boolean;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}) {
  return (
    <div className="brief-foot">
      <button
        className="ready-toggle"
        data-testid="toggle-ready"
        data-ready={ready}
        aria-pressed={ready}
        onClick={() =>
          void run("SetReadyState", { state: ready ? "contributing" : "ready" })
        }
      >
        {ready ? "Done adding" : "I'm done adding"}
      </button>
      {ready && <span className="brief-foot-note">tap to keep adding</span>}
    </div>
  );
}

/* ── Your agent's replies ───────────────────────────────────────────────
   Not a chat pane (SPOKES-UI §9): a card per reply, newest first, dismissed
   by the reader. Act-toned because the agent moved or spoke for you; the
   record row under it names what changed (COPY.md agent phrasing). */

export function AgentReplies({
  replies,
  onDismiss,
  onChoose,
}: {
  replies: AgentReply[];
  onDismiss(id: string): void;
  onChoose(
    replyId: string,
    choice: NonNullable<AgentReply["choices"]>[number],
  ): void;
}) {
  if (replies.length === 0) return null;
  return (
    <section data-testid="agent-replies">
      {replies.map((r) => (
        <div
          className="card"
          data-tone={r.answer ? "dashed" : "acting"}
          data-testid="agent-reply"
          key={r.id}
        >
          <div className="card-kicker" data-tone="act">Your agent</div>
          <div className="card-body" data-testid="agent-reply-text">{r.text}</div>
          {r.choices && r.choices.length > 0 && (
            <div className="reply-choices" data-testid="agent-reply-choices">
              {r.choices.map((choice, index) => (
                <button
                  type="button"
                  className="pill"
                  key={`${choice.label}-${index}`}
                  onClick={() => onChoose(r.id, choice)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          {r.actions.length > 0 && (
            <div className="record-list" data-testid="agent-actions">
              {r.actions.map((a, i) => (
                <div className="record-row" key={`${r.id}-${i}`} data-failed={!a.ok || undefined}>
                  <span className="record-spacer" aria-hidden="true" />
                  <span className="record-text">{actionText(a)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="card-actions">
            <button className="btn-text" data-testid="agent-reply-dismiss" onClick={() => onDismiss(r.id)}>
              Got it
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** A tool's effect in the room's words: never the tool name (CLAUDE.md §6). */
function actionText(a: { tool: string; ok: boolean; effect: string }): string {
  if (!a.ok) return "One move did not go through.";
  const verb: Record<string, string> = {
    submit_requirement: "Stated a need for you",
    withdraw_requirement: "Withdrew a need for you",
    set_requirement_active: "Changed which of your needs count",
    respond_to_proposal: "Took a stance for you",
    propose_destination: "Put a place forward for you",
    set_search_scope: "Changed the area",
    set_ready_state: "Changed whether you're done adding",
    resolve_private_request: "Answered a request for you",
    confirm_agreement: "Staged the agreement",
    plan_arrival: "Recorded how you'll get there",
    evaluate_candidates: "Screened places for you",
  };
  return verb[a.tool] ?? "Made a move for you";
}

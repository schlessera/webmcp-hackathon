import type { ProjectedEvent } from "@webmcp-hackathon/contracts";

/**
 * Per-viewer event projection — NEGOTIATION-PROTOCOL.md §4.1.
 * Server-side redaction is mandatory: at existence/aggregate level the stored
 * payload is never attached; text is a server-composed template string that
 * must not name a private owner or reason (except existence of agent-private
 * declarations, which name the owner per the §4.2 example).
 */

export interface StoredEvent {
  revision: number;
  type: string;
  actorId: string | null;
  visibility: string;
  payload: Record<string, unknown>;
}

export function projectEvent(
  event: StoredEvent,
  viewerId: string,
): ProjectedEvent | null {
  const isActor = event.actorId === viewerId;
  const p = event.payload;
  const actorName = (p.actorName as string) ?? "A participant";

  switch (event.type) {
    case "session_created":
    case "participant_joined":
    case "ready_state_changed":
    case "phase_changed":
      return full(event, `${actorName}: ${describeShared(event)}`);

    case "requirement_submitted":
    case "requirement_updated": {
      if (event.visibility === "shared" || isActor) {
        return full(
          event,
          `${isActor ? "You" : actorName} ${
            event.type === "requirement_updated" ? "updated" : "added"
          } a ${event.visibility === "shared" ? "shared" : "private"} need: ${p.summary ?? ""}`.trim(),
          isActor || event.visibility === "shared",
        );
      }
      // application-private, peer view: aggregate, no owner, no content.
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        text: "A private need was updated.",
      };
    }

    case "private_requirement_declared": {
      if (isActor) {
        return full(
          event,
          `You declared an agent-private requirement (${p.hardness}). Content stays with your agent.`,
        );
      }
      return {
        revision: event.revision,
        type: event.type,
        level: "existence",
        text: `${actorName} added a private need.`,
      };
    }

    case "requirement_toggled": {
      const verb = event.payload.active ? "brought back" : "set aside";
      if (event.visibility === "shared" || isActor) {
        return full(
          event,
          `${isActor ? "You" : actorName} ${verb} a need: ${p.summary ?? ""}`.trim(),
          isActor || event.visibility === "shared",
        );
      }
      // Peer view of a private toggle: that it happened, nothing more — no
      // owner, no content, the same floor requirement_submitted holds to.
      return {
        revision: event.revision,
        type: event.type,
        level: "existence",
        text: `A private need was ${verb}.`,
      };
    }

    case "requirement_withdrawn": {
      if (event.visibility === "shared" || isActor) {
        return full(
          event,
          `${isActor ? "You" : actorName} withdrew a requirement.`,
          isActor || event.visibility === "shared",
        );
      }
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        text: "A private requirement was withdrawn.",
      };
    }

    case "evaluation_requested":
      // Council -> owner only; absent from every peer's delta.
      if (!isActorTarget(event, viewerId)) return null;
      return full(
        event,
        `Screening requested for ${(p.candidateIds as string[])?.length ?? 0} candidates.`,
      );

    case "evaluation_recorded": {
      if (isActor) {
        return full(
          event,
          `You recorded ${p.verdictCount} screening verdicts.`,
        );
      }
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        // Eligibility counts ride in the adjacent candidates_updated event.
        text: "A private screening completed.",
      };
    }

    case "candidates_updated":
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        text: aggregateEligibilityText(p),
      };

    case "stance_submitted": {
      if (event.visibility === "shared" || isActor) {
        const verb =
          p.disposition === "reject"
            ? "vetoed"
            : p.disposition === "accept"
              ? "accepted"
              : `responded (${p.disposition}) to`;
        return full(
          event,
          `${isActor ? "You" : actorName} ${verb} ${p.candidateName ?? p.proposalId}.`,
          isActor || event.visibility === "shared",
        );
      }
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        text: "A private stance was recorded.",
      };
    }

    case "scope_change_proposed":
      return full(event, `${isActor ? "You" : actorName} proposed a search scope change.`, false);

    case "scope_change_applied":
      return full(
        event,
        `Search scope is now ${p.summary ?? "updated"}.`,
      );

    case "proposal_created":
      return full(
        event,
        `${isActor ? "You" : actorName} proposed ${p.candidateName ?? p.candidateId}.`,
      );

    case "impasse_detected":
      // Council event, deliberately neutral for everyone: never announce who
      // is "blocking" (EXPERIENCE-AND-DEMO.md).
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        text: "No option currently satisfies every confirmed requirement. The council is privately checking possible adjustments.",
      };

    case "adjustment_proposed":
      // Council -> addressee only; absent from every peer's delta.
      if (!isActorTarget(event, viewerId)) return null;
      return full(
        event,
        `Private adjustment available: ${describeAdjustment(p)}.`,
      );

    case "adjustment_resolved": {
      if (isActorTarget(event, viewerId)) {
        return full(
          event,
          `You ${p.decision === "granted" ? "granted" : "declined"} the adjustment ${p.adjustmentId}.`,
        );
      }
      const gain = (p.newCandidates as number) ?? 0;
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        text:
          p.decision === "granted" && gain > 0
            ? `Search adjusted. ${gain} new candidate${gain === 1 ? "" : "s"}.`
            : "A private adjustment was resolved.",
      };
    }

    case "requirement_relaxed": {
      if (event.visibility === "shared" || isActor) {
        return full(
          event,
          `${isActor ? "You" : actorName} relaxed a requirement.`,
          isActor || event.visibility === "shared",
        );
      }
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        text: "A requirement was adjusted.",
      };
    }

    case "impasse_resolved": {
      const eligible = (p.eligible as number) ?? 0;
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        text: `The impasse is resolved. ${eligible} candidate${eligible === 1 ? " is" : "s are"} now eligible.`,
      };
    }

    case "agreement_stage_aborted":
      return full(
        event,
        `The staged agreement on ${p.candidateName ?? p.proposalId} was aborted: ${p.blocker ?? "preconditions changed"}. The proposal is open again.`,
      );

    case "proposal_withdrawn": {
      const count = (p.count as number) ?? 1;
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        text: `${count} competing proposal${count === 1 ? " was" : "s were"} retired after the agreement.`,
      };
    }

    case "agreement_staged":
      return full(
        event,
        `${isActor ? "You" : actorName} staged the agreement on ${p.candidateName ?? p.proposalId}. The organizer confirms on the page.`,
      );

    case "agreement_committed":
      return full(
        event,
        `Agreement committed: ${p.candidateName ?? p.proposalId}. Time to plan arrivals.`,
      );

    case "arrival_plan_updated":
      return full(
        event,
        `${isActor ? "You" : actorName} plan${isActor ? "" : "s"} to arrive by ${p.mode}.`,
      );

    default:
      // Unknown-to-projection types are omitted rather than leaked.
      return null;
  }
}

function describeAdjustment(p: Record<string, unknown>): string {
  const change = p.change as { dimension?: string; from?: unknown; to?: unknown } | undefined;
  const gain = (p.projectedGain as { newCandidates?: number })?.newCandidates ?? 0;
  const gainText = `adds ${gain} candidate${gain === 1 ? "" : "s"}`;
  if (change?.dimension === "radius_m") {
    return `widen the search area from ${change.from} m to ${change.to} m (${gainText})`;
  }
  if (change?.dimension === "per_person_eur") {
    return `raise the budget from ${change.from} to ${change.to} EUR per person (${gainText})`;
  }
  if (change?.dimension === "exclusion") {
    return `drop an exclusion (${gainText})`;
  }
  return gainText;
}

function isActorTarget(event: StoredEvent, viewerId: string): boolean {
  return (
    event.actorId === viewerId || event.payload.targetParticipantId === viewerId
  );
}

function aggregateEligibilityText(p: Record<string, unknown>): string {
  const excluded = (p.newlyExcluded as number) ?? 0;
  const eligible = (p.eligible as number) ?? 0;
  if (excluded > 0) {
    return `${excluded} candidate${excluded === 1 ? " is" : "s are"} no longer eligible. ${eligible} remain eligible.`;
  }
  return `Candidate eligibility updated. ${eligible} eligible.`;
}

function describeShared(event: StoredEvent): string {
  const p = event.payload;
  switch (event.type) {
    case "session_created":
      return `session created — "${p.goal ?? "shared planning"}"`;
    case "ready_state_changed":
      return `ready state is now "${p.state}"`;
    case "participant_joined":
      return "joined the session";
    case "phase_changed":
      return `phase is now "${p.phase}"`;
    default:
      return event.type;
  }
}

function full(
  event: StoredEvent,
  text: string,
  includePayload = true,
): ProjectedEvent {
  return {
    revision: event.revision,
    type: event.type,
    level: "full",
    text,
    ...(includePayload ? { payload: redactedFullPayload(event) } : {}),
  };
}

/** Even at full level, never re-emit server bookkeeping fields. */
function redactedFullPayload(event: StoredEvent): unknown {
  const { actorName, targetParticipantId, ...rest } = event.payload;
  void actorName;
  void targetParticipantId;
  return rest;
}

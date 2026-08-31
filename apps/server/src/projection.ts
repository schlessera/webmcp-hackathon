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
          } a ${event.visibility} requirement: ${p.summary ?? ""}`.trim(),
          isActor || event.visibility === "shared",
        );
      }
      // application-private, peer view: aggregate, no owner, no content.
      return {
        revision: event.revision,
        type: event.type,
        level: "aggregate",
        text: "A private requirement was updated.",
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
        text: `${actorName} added a private requirement.`,
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

    default:
      // Unknown-to-projection types are omitted rather than leaked.
      return null;
  }
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

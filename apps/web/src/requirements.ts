import type { ProjectedEvent } from "@webmcp-hackathon/contracts";

/**
 * Reconstruct the viewer-visible requirement list from projected events.
 * The server is the privacy authority: full-level events carry payloads the
 * viewer is allowed to see; existence/aggregate lines stay redacted text.
 * (Reconstruction is bounded by the delta cap — a participant who joins late
 * sees the recent tail, which is the demo-honest behavior, not a bug.)
 */

export interface KnownRequirement {
  key: string;
  requirementId: string | null;
  text: string;
  visibility: string | null;
  hardness: string | null;
  withdrawn: boolean;
}

const REQUIREMENT_TYPES = new Set([
  "requirement_submitted",
  "requirement_updated",
  "private_requirement_declared",
  "requirement_relaxed",
]);

export function requirementsFromFeed(feed: ProjectedEvent[]): KnownRequirement[] {
  const byId = new Map<string, KnownRequirement>();
  const anonymous: KnownRequirement[] = [];
  // Feed is newest-first; walk oldest-first so later events win.
  for (const event of [...feed].reverse()) {
    const payload = (event.payload ?? {}) as {
      requirementId?: string;
      visibility?: string;
      hardness?: string;
    };
    if (REQUIREMENT_TYPES.has(event.type)) {
      const entry: KnownRequirement = {
        key: payload.requirementId ?? `rev-${event.revision}`,
        requirementId: payload.requirementId ?? null,
        text: event.text,
        visibility: payload.visibility ?? null,
        hardness: payload.hardness ?? null,
        withdrawn: false,
      };
      if (payload.requirementId) byId.set(payload.requirementId, entry);
      else if (event.level === "full") anonymous.push(entry);
    } else if (event.type === "requirement_withdrawn") {
      const id = payload.requirementId;
      if (id && byId.has(id)) byId.get(id)!.withdrawn = true;
    }
  }
  return [...byId.values(), ...anonymous];
}

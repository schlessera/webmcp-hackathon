import type { ProjectedEvent } from "@webmcp-hackathon/contracts";

export interface FeedLine extends ProjectedEvent {}

function poolAddedCount(event: FeedLine): number | null {
  if (event.type !== "candidates_added" || event.actorId) return null;
  const match = /^(\d+) more places on the map\.$/.exec(event.text);
  return match ? Number(match[1]) : null;
}

/**
 * Newest first, deduplicated by revision (live WS and catch-up can overlap).
 * The background fill writes one row per batch; adjacent fill rows are one
 * reader-facing event so the brief does not become a transport log.
 */
export function mergeFeed(incoming: FeedLine[], prev: FeedLine[]): FeedLine[] {
  const seen = new Set<number>();
  const ordered = [...incoming, ...prev]
    .filter((event) =>
      seen.has(event.revision) ? false : (seen.add(event.revision), true),
    )
    .sort((a, b) => b.revision - a.revision);
  const collapsed: FeedLine[] = [];
  for (const event of ordered) {
    const count = poolAddedCount(event);
    const previous = collapsed.at(-1);
    const previousCount = previous ? poolAddedCount(previous) : null;
    if (count !== null && previous && previousCount !== null) {
      collapsed[collapsed.length - 1] = {
        ...previous,
        text: `${previousCount + count} more places on the map.`,
      };
      continue;
    }
    collapsed.push(event);
  }
  return collapsed.slice(0, 40);
}

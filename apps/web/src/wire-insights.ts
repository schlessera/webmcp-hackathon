import type { WireEvent, WireState } from "./wire-store.ts";

export type RelationKind = "parent" | "correlation" | "revision" | "retry";
export interface WireRelation { source: string; target: string; kind: RelationKind }

/** A revision is supporting context, not proof of causation. Never replace
 * an explicit (but evicted) correlation with an unrelated revision match. */
export function wireRelations(events: WireEvent[]): WireRelation[] {
  const sorted = events.slice().sort((a, b) => a.at - b.at);
  const ids = new Set(events.map((e) => e.id));
  const correlations = new Map(events.filter((e) => e.lane === "http" && e.correlationId)
    .map((e) => [e.correlationId!, e]));
  const mutations = new Map<number, WireEvent>();
  const attempts = new Map<string, WireEvent>();
  const relations: WireRelation[] = [];
  for (const event of sorted) {
    if (event.parentId && ids.has(event.parentId)) relations.push({ source: event.parentId, target: event.id, kind: "parent" });
    if (event.lane === "ws" && event.dir === "in" && event.label.startsWith("event")) {
      const source = event.correlationId ? correlations.get(event.correlationId) :
        event.revision !== undefined ? mutations.get(event.revision) : undefined;
      if (source) relations.push({ source: source.id, target: event.id, kind: event.correlationId ? "correlation" : "revision" });
    }
    if (event.lane === "http" && event.idempotencyKey) {
      const earlier = attempts.get(event.idempotencyKey);
      if (earlier) relations.push({ source: earlier.id, target: event.id, kind: "retry" });
      attempts.set(event.idempotencyKey, event);
      if (event.outcome === "ok" && event.revision !== undefined) mutations.set(event.revision, event);
    }
  }
  return relations;
}

export function connectedIds(relations: WireRelation[], id: string): Set<string> {
  const edges = new Map<string, string[]>();
  for (const { source, target } of relations) {
    if (!edges.has(source)) edges.set(source, []);
    if (!edges.has(target)) edges.set(target, []);
    edges.get(source)!.push(target); edges.get(target)!.push(source);
  }
  const ids = new Set([id]);
  const queue = [id];
  while (queue.length) for (const next of edges.get(queue.pop()!) ?? []) {
    if (!ids.has(next)) { ids.add(next); queue.push(next); }
  }
  return ids;
}

export function elapsed(event: WireEvent, now = Date.now()): number {
  return Math.max(0, event.durationMs ?? ((event.endAt ?? now) - event.at));
}
export function attention(event: WireEvent): boolean {
  return event.outcome === "error" || event.outcome === "blocked" || event.truncated === true ||
    (event.serverTrace?.omitted ?? 0) > 0 || event.serverTrace?.spans.some((s) => s.outcome === "error") === true;
}

export function summarizeWire(events: WireEvent[], now: number) {
  const http = events.filter((e) => e.lane === "http");
  const times = http.filter((e) => e.endAt !== undefined).map((e) => elapsed(e, now)).sort((a, b) => a - b);
  const model = http.flatMap((e) => e.serverTrace?.spans.filter((s) => s.kind === "model") ?? []);
  return {
    total: events.length, running: events.filter((e) => e.endAt === undefined).length,
    attention: events.filter(attention).length,
    slow: http.filter((e) => elapsed(e, now) >= 2000).length,
    httpBytes: http.reduce((n, e) => n + (e.bytes ?? 0), 0),
    p95: times.length ? times[Math.ceil(times.length * .95) - 1] : null,
    modelCalls: model.length,
    usageCalls: model.filter((s) => s.inputTokens !== undefined && s.outputTokens !== undefined).length,
    tokens: model.reduce((n, s) => n + (s.inputTokens ?? 0) + (s.outputTokens ?? 0), 0),
    costUsd: model.reduce((n, s) => n + (s.costUsd ?? 0), 0),
  };
}

export function eventMatches(event: WireEvent, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = [event.id, event.lane, event.label, event.note, event.outcome, event.status,
    event.correlationId, event.idempotencyKey, event.revision, ...Object.values(event.detail ?? {}),
    ...(event.serverTrace?.spans.map((s) => s.label) ?? [])].join(" ").toLocaleLowerCase();
  return query.toLocaleLowerCase().trim().split(/\s+/).every((word) => haystack.includes(word));
}

/** Export only what this page recorded. Explicit projection keeps future
 * additions (especially payloads) out of downloadable diagnostics by default. */
export function wireExport(state: WireState, events = state.events) {
  return { version: 1, exportedAt: new Date().toISOString(), startedAt: state.startedAt,
    dropped: state.dropped ?? 0, omittedPings: state.omittedPings ?? 0, coverage: "This page only; server spans end at response headers; metadata only",
    events: events.map(({ id, lane, label, note, at, endAt, durationMs, headersMs, bodyMs, parseMs, status,
      failureKind, outcome, dir, parentId, correlationId, idempotencyKey, revision, fromRevision, serverMs,
      bytes, budget, truncated, replayed, steps, serverTrace }) => ({ id, lane, label, note, at, endAt,
      durationMs, headersMs, bodyMs, parseMs, status, failureKind, outcome, dir, parentId, correlationId,
      idempotencyKey, revision, fromRevision, serverMs, bytes, budget, truncated, replayed, steps, serverTrace })),
  };
}

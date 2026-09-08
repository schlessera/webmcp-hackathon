import type { WireEvent, WireLane } from "./wire-store.ts";
import type { WireRelation } from "./wire-insights.ts";

export const WIRE_ROW_H = 44;
export const GRAPH_LANES: WireLane[] = ["page", "agent", "tool", "http", "ws"];
export const graphX = (lane: WireLane, wide = false) => 12 + GRAPH_LANES.indexOf(lane) * (wide ? 32 : 20);
export const graphWidth = (wide = false) => wide ? 156 : 108;

export function indexWireGraph(events: WireEvent[], shown: WireEvent[], relations: WireRelation[]) {
  const byId = new Map(events.map((event) => [event.id, event]));
  const rows = new Map(shown.map((event, index) => [event.id, index]));
  const counts = new Map<string, number>();
  const edges = relations.flatMap((relation) => {
    const source = byId.get(relation.source), target = byId.get(relation.target);
    if (!source || !target) return [];
    counts.set(source.id, (counts.get(source.id) ?? 0) + 1);
    counts.set(target.id, (counts.get(target.id) ?? 0) + 1);
    return [{ ...relation, source, target, from: rows.get(source.id), to: rows.get(target.id) }];
  });
  return { edges, counts, rows };
}

/** Clip geometry, never the history. Offscreen runs with identical geometry
 * are bundled, so a 5,000-child fan-out has viewport-sized SVG output. */
export function wireGraphWindow(graph: ReturnType<typeof indexWireGraph>, top: number, height: number,
  wide = false, related = new Set<string>()) {
  const paths = new Map<string, { d: string; kind: WireRelation["kind"]; count: number; related: boolean; filtered: boolean; boundaryY?: number }>();
  const above = new Map<string, number>(), below = new Map<string, number>(), filtered = new Set<string>();
  const visible = (row: number | undefined) => row !== undefined && row * WIRE_ROW_H + WIRE_ROW_H / 2 >= top && row * WIRE_ROW_H + WIRE_ROW_H / 2 <= top + height;
  const y = (row: number) => row * WIRE_ROW_H + WIRE_ROW_H / 2 - top;
  const clip = (value: number) => Math.max(0, Math.min(height, value));
  for (const edge of graph.edges) {
    const { from, to, source, target } = edge;
    if (from === undefined && to === undefined) continue;
    const hidden = from === undefined || to === undefined;
    if (hidden && !visible(from ?? to)) continue;
    if (!hidden && (Math.max(y(from!), y(to!)) < 0 || Math.min(y(from!), y(to!)) > height)) continue;
    for (const [event, row] of [[source, from], [target, to]] as const) {
      if (row === undefined) filtered.add(event.id);
      else if (y(row) < 0) above.set(event.id, row);
      else if (y(row) > height) below.set(event.id, row);
    }
    const fx = graphX(source.lane, wide), tx = graphX(target.lane, wide);
    let d: string;
    if (hidden) {
      // An open end at the gutter edge means a retained endpoint is filtered.
      const at = y((from ?? to)!);
      const x = from === undefined ? tx : fx;
      d = from === undefined ? `M${graphWidth(wide) - 2} ${at} H${x + 8}` : `M${x + 8} ${at} H${graphWidth(wide) - 2}`;
    } else {
      const sy = y(from!), ty = y(to!), direction = ty >= sy ? 1 : -1;
      const start = clip(sy + direction * 8), end = clip(ty - direction * 8);
      if (fx === tx) {
        const bend = fx + 8;
        d = `M${sy < 0 || sy > height ? bend : fx} ${start} L${bend} ${clip(sy + direction * 16)} V${clip(ty - direction * 16)} L${ty < 0 || ty > height ? bend : tx} ${end}`;
      } else if (ty < 0 || ty > height) {
        d = `M${fx} ${start} V${end}`;
      } else {
        const turn = Math.sign(tx - fx);
        d = `M${fx} ${start} V${clip(ty - direction * 10)} Q${fx} ${ty} ${fx + turn * 10} ${ty} H${tx - turn * 8}`;
      }
    }
    const hot = related.has(source.id) && related.has(target.id);
    const key = `${edge.kind}:${d}:${hot}:${hidden}`;
    const prior = paths.get(key);
    if (prior) prior.count++;
    else paths.set(key, { d, kind: edge.kind, count: 1, related: hot, filtered: hidden, ...(hidden ? { boundaryY: y((from ?? to)!) } : {}) });
  }
  const nearest = (items: Map<string, number>, descending: boolean) =>
    [...items].sort((a, b) => descending ? b[1] - a[1] : a[1] - b[1])[0]?.[0];
  return { paths: [...paths.values()], above: above.size, below: below.size, filtered: filtered.size,
    aboveId: nearest(above, true), belowId: nearest(below, false) };
}

import type { WireEvent } from "../wire-store.ts";
import type { WireRelation } from "../wire-insights.ts";
import { formatMs } from "../wire-timeline.ts";
const LANES = ["page", "agent", "tool", "http", "ws"] as const;

/** A bounded, inspectable sequence diagram. Edges use actual event IDs;
 * columns are kinds, vertical position is event order, not elapsed time. */
export function WireFlow({ events, relations, selectedId, onSelect }: {
  events: WireEvent[]; relations: WireRelation[]; selectedId: string | null; onSelect(id: string): void;
}) {
  const shown = events.slice(-50);
  const rows = new Map(shown.map((event, i) => [event.id, { event, y: 50 + i * 44 }]));
  const x = (event: WireEvent) => 24 + LANES.indexOf(event.lane) * 42;
  const height = Math.max(100, shown.length * 44 + 42);
  return <div className="wire-flow">
    <p className="wire-help">{events.length > 50 ? `Latest 50 of ${events.length} shown. Narrow the search or focus a trace. ` : ""}Solid: parent or request ID. Dashed: inferred revision. Dotted: retry. Rows show event order.</p>
    <div className="wire-flow-scroll">
      <svg viewBox={`0 0 580 ${height}`} width="580" height={height} role="group" aria-label="Causal flow diagram">
        {LANES.map((lane, i) => <g key={lane}><text x={24 + i * 42} y="16" textAnchor="middle" className="wire-flow-lane">{lane}</text>
          <line x1={24 + i * 42} x2={24 + i * 42} y1="24" y2={height} className="wire-flow-guide" /></g>)}
        {relations.map((relation) => {
          const from = rows.get(relation.source), to = rows.get(relation.target);
          if (!from || !to) return null;
          const fx = x(from.event), tx = x(to.event);
          return <g key={`${relation.source}-${relation.target}-${relation.kind}`} className="wire-flow-link" data-kind={relation.kind}>
            <path d={fx === tx ? `M${fx} ${from.y + 6} C${fx + 18} ${from.y + 18},${fx + 18} ${to.y - 18},${tx} ${to.y - 6}` :
              `M${fx} ${from.y + 6} V${to.y - 12} Q${fx} ${to.y} ${fx + Math.sign(tx - fx) * 12} ${to.y} H${tx - Math.sign(tx - fx) * 8}`} />
          </g>;
        })}
        {shown.map((event, i) => <g key={event.id} role="button" tabIndex={0} aria-label={`Inspect ${event.label}`} aria-pressed={event.id === selectedId}
          className="wire-flow-node" data-selected={event.id === selectedId || undefined} onClick={() => onSelect(event.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(event.id); } }}>
          <title>{event.label} · {event.note ?? event.outcome ?? (event.endAt === undefined ? "running" : "received")}</title>
          <rect x="0" y={28 + i * 44} width="580" height="44" className="wire-flow-hit" />
          <circle cx={x(event)} cy={50 + i * 44} r="5" className="wire-flow-dot" data-open={event.endAt === undefined || undefined} />
          <text x="226" y={47 + i * 44}>{event.label.slice(0, 36)}{event.label.length > 36 ? "…" : ""}</text>
          <text x="226" y={63 + i * 44} className="wire-flow-note">{(event.note ?? event.outcome ?? (event.endAt === undefined ? "running" : "received")).slice(0, 45)}</text>
          <text x="574" y={47 + i * 44} textAnchor="end" className="wire-flow-note">+{formatMs(event.at - (shown[0]?.at ?? event.at))}</text>
        </g>)}
      </svg>
    </div>
  </div>;
}

import { useId } from "react";
import type { wireGraphWindow } from "../wire-graph.ts";
import { GRAPH_LANES, GRAPH_WIDTH, graphX } from "../wire-graph.ts";

const titles = { page: "Page", agent: "Agent", tool: "Tool", http: "HTTP", ws: "Socket" };
const initials = { page: "P", agent: "A", tool: "T", http: "H", ws: "S" };

export function WireGraphHeader() {
  return <div className="wire-graph-heading" style={{ width: GRAPH_WIDTH }} aria-label="Graph lanes: Page, Agent, Tool, HTTP, Socket">
    {GRAPH_LANES.map((lane) => <span key={lane} title={titles[lane]} style={{ left: graphX(lane) }}>{initials[lane]}</span>)}
  </div>;
}

export function WireGraph({ window, top, height }: {
  window: ReturnType<typeof wireGraphWindow>; top: number; height: number;
}) {
  const arrow = useId();
  return <svg className="wire-causal-graph" data-testid="wire-graph" style={{ top }} width={GRAPH_WIDTH} height={height}
    viewBox={`0 0 ${GRAPH_WIDTH} ${height}`} aria-hidden="true">
    <defs><marker id={arrow} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 6 3 0 6Z" fill="currentColor" /></marker></defs>
    {GRAPH_LANES.map((lane) => <line key={lane} x1={graphX(lane)} x2={graphX(lane)} y1={0} y2={height} className="wire-flow-guide" />)}
    {window.paths.map((path, i) => <g key={i} className="wire-flow-link" data-kind={path.kind} data-related={path.related || undefined} data-filtered={path.filtered || undefined} data-count={path.count}>
      <path d={path.d} markerEnd={path.filtered ? undefined : `url(#${arrow})`} />
      {path.boundaryY !== undefined && <circle cx={GRAPH_WIDTH - 2} cy={path.boundaryY} r="2" className="wire-filtered-end" />}
    </g>)}
  </svg>;
}

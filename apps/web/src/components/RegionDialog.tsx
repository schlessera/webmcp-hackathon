import { useEffect, useRef } from "react";
import type { AreaSummary } from "../api.ts";
import { COPY, asOf } from "../ui/copy.ts";

/**
 * The one screen that is not the product.
 *
 * Spokes is built to work anywhere; venue data that covers everywhere is a
 * cost and licensing problem a hackathon does not solve. So the demo is
 * bounded to two prepared regions, and this dialog says exactly that, in the
 * product's own voice, before asking which one.
 *
 * It is drawn plainer than everything around it on purpose — the same move
 * the `{ }` drawer makes. A person should be able to tell at a glance that
 * this is scaffolding, not a feature they will meet again.
 *
 * Every number comes from `GET /api/areas`, measured from each region's own
 * extract. Counts are absolute, never percentages (CLAUDE.md §10), and the
 * classes counted are the ones this plan actually needs — which is what
 * makes the choice mean something rather than being a coin toss.
 */

interface Props {
  areas: AreaSummary[] | null;
  /** The plan's steps, so each region can be counted for what it must find. */
  steps: Array<{ placeClass: string }>;
  busy: boolean;
  onPick(areaId: string): void;
  onClose(): void;
}

/** What this region holds for each class the plan needs, in plan order. */
function countsFor(area: AreaSummary, steps: Array<{ placeClass: string }>) {
  const byKey = new Map((area.classes ?? []).map((item) => [item.key, item]));
  return steps.map((step) => {
    const found = byKey.get(step.placeClass);
    return {
      key: step.placeClass,
      label: found?.label ?? step.placeClass,
      count: found?.count ?? 0,
      known: found !== undefined,
    };
  });
}

export function RegionDialog({ areas, steps, busy, onPick, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const available = (areas ?? []).filter((area) => area.available);

  return (
    <div className="demo-scrim" data-testid="region-dialog">
      <div
        className="demo-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="region-title"
        ref={dialogRef}
      >
        <p className="demo-tag">demo limit</p>
        <h2 className="demo-title" id="region-title">{COPY.regionTitle}</h2>
        <p className="demo-lede">{COPY.regionLede}</p>

        <p className="demo-ask">{COPY.regionPick}</p>

        {available.length === 0 ? (
          <p className="demo-empty">No region data is loaded right now.</p>
        ) : (
          <ul className="region-list">
            {available.map((area, index) => {
              const pool = area.coverage?.pool;
              const known = pool?.decisive ?? 0;
              const slots = pool?.slots ?? 0;
              return (
                <li key={area.id}>
                  <button
                    type="button"
                    ref={index === 0 ? firstRef : undefined}
                    className="region-card"
                    data-testid={`region-${area.id}`}
                    disabled={busy}
                    onClick={() => onPick(area.id)}
                  >
                    <span className="region-name">{area.label}</span>
                    <span className="region-counts">
                      {countsFor(area, steps).map((row) => (
                        <span className="region-count" key={row.key}>
                          <span className="region-count-n">{row.count}</span>
                          <span className="region-count-label">{row.label}</span>
                        </span>
                      ))}
                    </span>
                    {slots > 0 && (
                      <span className="region-facts">
                        <span className="mark" aria-hidden="true" />
                        {COPY.regionFactsKnown(known, slots)}
                      </span>
                    )}
                    {area.dataAsOf && (
                      <span className="region-asof">
                        {area.source}, as of {asOf(area.dataAsOf)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="demo-actions">
          <button type="button" className="demo-cancel" disabled={busy} onClick={onClose}>
            Back
          </button>
          {busy && <span className="demo-busy">{COPY.regionOpening}</span>}
        </div>
      </div>
    </div>
  );
}

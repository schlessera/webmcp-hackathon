import { useEffect, useState } from "react";
import { spatialNavigationRaw } from "../api.ts";
import type { CommandEnvelope, NavigationLinks } from "../spatial-types.ts";

/**
 * Once the room agrees, the composer is replaced by arrival: the room stops
 * being a negotiation and becomes a meeting point (mockup 7c). The installed
 * map app is the execution surface; links come from coordinates the session
 * already holds — no provider call at handoff time.
 */

interface Props {
  destinationName: string;
  arrival: { mode?: string; pickupNote?: string } | undefined;
  walkMin: number | undefined;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

const MODES = [
  { value: "walk", label: "Walk" },
  { value: "bike", label: "Bike" },
  { value: "car", label: "Drive" },
] as const;

export function ArrivalBar({ destinationName, arrival, walkMin, run }: Props) {
  const [links, setLinks] = useState<NavigationLinks | null>(null);
  const mode = arrival?.mode ?? "walk";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = (await spatialNavigationRaw({})) as NavigationLinks & {
        ok?: boolean;
      };
      if (!cancelled && result.ok !== false && result.links) setLinks(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [destinationName]);

  return (
    <div className="arrival-bar" data-testid="arrival-banner">
      <div className="arrival-head">
        <div className="arrival-copy">
          <div className="arrival-title">{destinationName}</div>
          <div className="arrival-sub">
            Agreed{walkMin !== undefined ? ` · ${walkMin} min from you` : ""}
          </div>
        </div>
        <div className="seg" role="group" aria-label="How are you getting there?">
          {MODES.map((m) => (
            <button
              key={m.value}
              aria-pressed={mode === m.value}
              onClick={() => void run("PlanArrival", { mode: m.value })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {links && (
        <>
          <a
            className="arrival-go"
            data-testid="navigate-link"
            href={links.links.googleMaps}
            target="_blank"
            rel="noopener noreferrer"
          >
            Take me there
          </a>
          <span className="arrival-alt">
            or open in your <a href={links.links.geo}>map app</a> ·{" "}
            <a href={links.links.appleMaps} target="_blank" rel="noopener noreferrer">
              Apple Maps
            </a>
          </span>
        </>
      )}
    </div>
  );
}

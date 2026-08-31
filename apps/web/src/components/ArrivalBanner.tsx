import { useEffect, useState } from "react";
import { spatialNavigationRaw } from "../api.ts";
import type { CommandEnvelope, NavigationLinks } from "../spatial-types.ts";

/**
 * Arrival mode: the room stays the coordination surface; the installed map
 * app is the execution surface. Links come from coordinates the session
 * already holds — no provider API call at handoff time.
 */

interface Props {
  destinationName: string;
  arrival: { mode?: string; pickupNote?: string } | undefined;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
}

export function ArrivalBanner({ destinationName, arrival, run }: Props) {
  const [links, setLinks] = useState<NavigationLinks | null>(null);
  const [pickupNote, setPickupNote] = useState(arrival?.pickupNote ?? "");
  const mode = arrival?.mode ?? "walk";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = (await spatialNavigationRaw({})) as NavigationLinks & { ok?: boolean };
      if (!cancelled && result.ok !== false && result.links) setLinks(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [destinationName]);

  const setMode = (m: string) =>
    void run("PlanArrival", { mode: m, ...(pickupNote ? { pickupNote } : {}) });

  return (
    <div className="arrival-banner" data-testid="arrival-banner">
      <div>
        <div className="arrival-dest">★ {destinationName}</div>
        <div className="arrival-sub">Agreed. See you there.</div>
      </div>
      <div className="seg" role="group" aria-label="How are you getting there?">
        {(["walk", "bike", "car"] as const).map((m) => (
          <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m === "walk" ? "Walk" : m === "bike" ? "Bike" : "Drive"}
          </button>
        ))}
      </div>
      <input
        type="text"
        placeholder="Pickup note (optional)"
        maxLength={200}
        value={pickupNote}
        onChange={(e) => setPickupNote(e.target.value)}
        onBlur={() => pickupNote !== (arrival?.pickupNote ?? "") && setMode(mode)}
        style={{ width: 170 }}
      />
      {links && (
        <>
          <a
            className="btn btn-primary"
            style={{ textDecoration: "none" }}
            data-testid="navigate-link"
            href={links.links.googleMaps}
            target="_blank"
            rel="noopener noreferrer"
          >
            Navigate ↗
          </a>
          <span className="arrival-alt">
            or <a href={links.links.geo}>geo:</a> ·{" "}
            <a href={links.links.appleMaps} target="_blank" rel="noopener noreferrer">
              Apple Maps
            </a>
          </span>
        </>
      )}
    </div>
  );
}

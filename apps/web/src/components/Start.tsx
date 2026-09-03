import { useEffect, useState } from "react";
import { createRoom, fetchAreas, type AreaSummary, type CreatedRoom } from "../api.ts";
import { COPY, asOf } from "../ui/copy.ts";
import { Wordmark } from "./Wordmark.tsx";

/**
 * The only screen before a room: pick an area, say who is coming, open it.
 *
 * Every number on an area card was measured from that area's OpenStreetMap
 * extract by the snapshot builder (docs/DATA-QUALITY.md) and arrives from
 * the server — nothing here is typed into the component. Counts are
 * absolute, never percentages (CLAUDE.md §10); the meter is a drawing of the
 * same two numbers, with the unknown share hollow (§4).
 *
 * Nothing here names a domain: the area label is server data, the places are
 * "places", the facts are "facts".
 */

interface Props {
  onOpen(inviteSecret: string): void;
  /** Present when the picker was reached from the landing page. */
  onBack?(): void;
}

function inviteUrl(inviteSecret: string): string {
  return `${window.location.origin}/#invite=${inviteSecret}`;
}

function AreaCard({
  area,
  checked,
  onPick,
}: {
  area: AreaSummary;
  checked: boolean;
  onPick(): void;
}) {
  const c = area.coverage;
  const pool = c?.pool;
  const known = pool?.decisive ?? 0;
  const slots = pool?.slots ?? 0;
  const hours = pool?.tagCounts.opening_hours ?? 0;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="area-card card"
      data-checked={checked || undefined}
      data-testid={`area-${area.id}`}
      disabled={!area.available}
      onClick={onPick}
    >
      <span className="area-name">{area.label}</span>
      {c ? (
        <>
          <span className="area-line">
            {c.focus.venues} places within {c.focus.venues && area.radii.wide / 1000} km ·{" "}
            {c.city.venues.toLocaleString()} across {area.city}
          </span>
          <span className="area-line">A room starts with the {pool!.venues} nearest.</span>
          <span className="area-meter" aria-hidden="true">
            <span
              className="area-meter-known"
              style={{ width: `${slots ? (known / slots) * 100 : 0}%` }}
            />
          </span>
          <span className="area-line area-facts">
            <span className="mark" aria-hidden="true" /> {known} of {slots} facts on record
            <span className="mark" data-mark="unknown" aria-hidden="true" /> {slots - known} unknown
          </span>
          <span className="area-line">
            {hours} of {pool!.venues} list opening hours
          </span>
          <span className="area-asof">
            {area.source}, as of {asOf(area.dataAsOf)}
          </span>
        </>
      ) : (
        <span className="area-line">
          {area.available
            ? `${area.source}, as of ${asOf(area.dataAsOf)}. Coverage not measured.`
            : "No place data here yet."}
        </span>
      )}
    </button>
  );
}

export function Start({ onOpen, onBack }: Props) {
  const [areas, setAreas] = useState<AreaSummary[] | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [you, setYou] = useState("Alex");
  const [others, setOthers] = useState(["Sarah", "Joe"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<CreatedRoom | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAreas()
      .then((list) => {
        if (cancelled) return;
        setAreas(list);
        setAreaId(list.find((a) => a.available)?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the areas. Reload to try again.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = async () => {
    if (!areaId) return;
    setBusy(true);
    setError(null);
    const result = await createRoom({
      areaId,
      organizerName: you,
      memberNames: others.map((n) => n.trim()).filter(Boolean),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRoom(result.room);
  };

  const copy = async (secret: string, id: string) => {
    try {
      await navigator.clipboard.writeText(inviteUrl(secret));
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      setCopied(null);
    }
  };

  if (room) {
    const organizer = room.invites.find((i) => i.role === "organizer")!;
    return (
      <div className="start" data-testid="start-links">
        <Wordmark />
        <h1 className="start-title">Your room is open</h1>
        <p className="start-lede">
          Each link is one person's way in. Send the others theirs; keep yours.
        </p>
        <ul className="invite-list">
          {room.invites.map((i) => (
            <li key={i.participantId} className="invite-row card">
              <span className="invite-name">
                {i.displayName}
                {i.role === "organizer" && <span className="invite-role"> · you</span>}
              </span>
              <button
                type="button"
                className="invite-copy"
                onClick={() => void copy(i.inviteSecret, i.participantId)}
                data-testid={`copy-${i.participantId}`}
              >
                {copied === i.participantId ? "Copied" : "Copy link"}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="start-button"
          data-testid="enter-room"
          onClick={() => onOpen(organizer.inviteSecret)}
        >
          Open the room as {organizer.displayName}
        </button>
      </div>
    );
  }

  return (
    <div className="start" data-testid="start">
      <div className="start-top">
        <span className="start-brand">
          <Wordmark />
        </span>
        {onBack && (
          <button type="button" className="btn start-back" data-testid="start-back" onClick={onBack}>
            Back
          </button>
        )}
      </div>
      <h1 className="start-title">Open a room</h1>
      <p className="start-lede">{COPY.startLede}</p>

      {error && (
        <p role="alert" className="start-error">
          {error}
        </p>
      )}

      <div className="area-list" role="radiogroup" aria-label="Area">
        {areas === null && !error && <span className="start-quiet">Loading the areas…</span>}
        {areas?.map((a) => (
          <AreaCard key={a.id} area={a} checked={areaId === a.id} onPick={() => setAreaId(a.id)} />
        ))}
      </div>
      <p className="start-note">{COPY.startUnknown}</p>

      <div className="start-names">
        <label className="start-field">
          <span>You</span>
          <input value={you} maxLength={40} onChange={(e) => setYou(e.target.value)} data-testid="name-you" />
        </label>
        {others.map((name, i) => (
          <label className="start-field" key={i}>
            <span>{i === 0 ? "Who else" : ""}</span>
            <input
              value={name}
              maxLength={40}
              onChange={(e) =>
                setOthers((prev) => prev.map((n, j) => (j === i ? e.target.value : n)))
              }
              data-testid={`name-other-${i}`}
            />
          </label>
        ))}
        {others.length < 5 && (
          <button
            type="button"
            className="start-add"
            onClick={() => setOthers((prev) => [...prev, ""])}
          >
            One more
          </button>
        )}
      </div>

      <button
        type="button"
        className="start-button"
        disabled={busy || !areaId || you.trim().length === 0}
        onClick={() => void open()}
        data-testid="open-room"
      >
        {busy ? "Opening…" : "Open the room"}
      </button>
    </div>
  );
}

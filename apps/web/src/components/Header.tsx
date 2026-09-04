import { useEffect, useRef, useState } from "react";
import type { ParticipantSummary } from "../spatial-types.ts";
import { avatarTilt, initials, personColor } from "../ui/copy.ts";
import { Wordmark } from "./Wordmark.tsx";

/**
 * Header — flows straight out of the top of the screen. No containing card,
 * no divider, no nav (CLAUDE.md §11, SPOKES-UI §2).
 *
 * The subtitle is STATE, not metadata: it is the cheapest signal the room has
 * for "where are we". It never names a domain and never hardcodes a name.
 */

export interface HeaderSubtitle {
  text: string;
  tone: "quiet" | "unsure" | "works";
}

interface Props {
  /** The committed place once the room agrees; the brand otherwise. */
  title: string | null;
  subtitle: HeaderSubtitle;
  participants: ParticipantSummary[];
  meId: string;
  originEditing: boolean;
  onOriginEditingChange(enabled: boolean): void;
  onSetOrigin(
    position: { lat: number; lng: number },
    source: "device" | "stated",
    label?: string,
  ): Promise<boolean>;
  sharedPositionIds: ReadonlySet<string>;
  onSetOriginSharing(shared: boolean): Promise<boolean>;
  onOpenDrawer(): void;
}

/** "here now" / "arrived" / "not arrived yet" — presence in words. */
function presenceWord(p: ParticipantSummary): string {
  return p.present ? "here now" : p.arrived ? "arrived" : "not arrived yet";
}

export function Header({
  title,
  subtitle,
  participants,
  meId,
  originEditing,
  onOriginEditingChange,
  onSetOrigin,
  sharedPositionIds,
  onSetOriginSharing,
  onOpenDrawer,
}: Props) {
  /* The avatar row opens a roster card on tap (W12): names and presence are
     reachable on touch, not only on hover. A disclosure, not navigation —
     it closes on Escape, on an outside tap, or on the row again. */
  const [rosterOpen, setRosterOpen] = useState(false);
  const rosterRef = useRef<HTMLDivElement>(null);
  const avatarsRef = useRef<HTMLButtonElement>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [sharingChanging, setSharingChanging] = useState(false);
  const geolocationAvailable =
    typeof navigator !== "undefined" && "geolocation" in navigator;

  const useDeviceLocation = () => {
    if (!geolocationAvailable || locating) return;
    setLocating(true);
    setLocationError("");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void onSetOrigin(
          { lat: position.coords.latitude, lng: position.coords.longitude },
          "device",
          "your location",
        ).then((ok) => {
          setLocating(false);
          if (ok) onOriginEditingChange(false);
        });
      },
      () => {
        setLocating(false);
        setLocationError("Your location was not available.");
      },
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 10_000 },
    );
  };
  useEffect(() => {
    if (!rosterOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRosterOpen(false);
        avatarsRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!rosterRef.current?.contains(e.target as Node)) setRosterOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [rosterOpen]);

  return (
    <header className="header">
      <div className="header-titles">
        {/* The wordmark stays: a room's name is added after it, not in place
            of it, so the app never loses its own identity to its content. */}
        <div className="header-title">
          <Wordmark />
          {title && (
            <span className="header-title-sep" aria-hidden="true">·</span>
          )}
          <span className="header-title-name" data-testid="room-title">
            {title ?? ""}
          </span>
        </div>
        <div
          className="header-subtitle"
          data-tone={subtitle.tone}
          data-testid="room-subtitle"
        >
          {subtitle.text}
        </div>
      </div>

      <div className="roster" ref={rosterRef}>
        <button
          className="avatars"
          data-testid="avatars"
          ref={avatarsRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={rosterOpen}
          aria-label={`${participants.length} in the room`}
          onClick={() => setRosterOpen((v) => !v)}
        >
          {/* Invited but not yet arrived draws idle (mockup 7a); a person
              looking right now carries a small mark, so presence is never
              colour alone. Person colours are identity, never semantic. */}
          {participants.map((p, i) => {
            const state = p.present ? "here now" : p.arrived ? "" : "not arrived yet";
            const sharing = sharedPositionIds.has(p.participantId);
            return (
              <span
                key={p.participantId}
                className="avatar"
                style={{
                  background: p.arrived ? personColor(i) : undefined,
                  transform: `rotate(${avatarTilt(i)}deg)`,
                }}
                title={state ? `${p.displayName} · ${state}` : p.displayName}
                data-idle={p.arrived ? undefined : "true"}
                data-present={p.present || undefined}
                data-sharing={sharing || undefined}
                data-testid={`avatar-${p.participantId}`}
              >
                <span aria-hidden="true">{initials(p.displayName)}</span>
                <span className="sr-only">
                  {p.displayName}
                  {state ? `, ${state}` : ""}
                  {sharing ? ", showing where they are" : ""}
                </span>
                {p.present && <i className="avatar-here" aria-hidden="true" />}
                {sharing && <i className="avatar-sharing" aria-hidden="true" />}
              </span>
            );
          })}
        </button>
        {rosterOpen && (
          <div className="roster-card" role="dialog" aria-label="Who is in the room" data-testid="roster-card">
            {participants.map((p, i) => (
              <div className="roster-person" key={p.participantId}>
              <div className="roster-row" data-testid={`roster-${p.participantId}`}>
                <span
                  className="avatar"
                  style={{ background: p.arrived ? personColor(i) : undefined }}
                  data-idle={p.arrived ? undefined : "true"}
                  aria-hidden="true"
                >
                  {initials(p.displayName)}
                </span>
                <span className="roster-name">
                  {p.displayName}
                  {p.role === "organizer" && <span className="roster-role"> · organizer</span>}
                </span>
                <span className="roster-state" data-present={p.present || undefined}>
                  {p.present && <i className="avatar-here roster-here" aria-hidden="true" />}
                  {sharedPositionIds.has(p.participantId) && (
                    <i className="avatar-sharing roster-sharing" aria-hidden="true" />
                  )}
                  {presenceWord(p)}
                  {sharedPositionIds.has(p.participantId) && <span className="sr-only">, showing where they are</span>}
                </span>
              </div>
              {p.participantId === meId && (
                <div className="origin-controls">
                  {p.origin && (
                    <div className="origin-label" data-testid="origin-label">
                      Starting from {p.origin.label}
                    </div>
                  )}
                  {p.origin && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={sharedPositionIds.has(p.participantId)}
                      className="origin-sharing"
                      disabled={sharingChanging}
                      data-testid="origin-sharing"
                      onClick={() => {
                        setSharingChanging(true);
                        void onSetOriginSharing(!sharedPositionIds.has(p.participantId))
                          .finally(() => setSharingChanging(false));
                      }}
                    >
                      <span className="origin-sharing-box" aria-hidden="true" />
                      Show where you are to the room
                    </button>
                  )}
                  <div className="origin-privacy">
                    Off: only you and the room’s server know your position. On: everyone in the room sees it on the map while you are here.
                  </div>
                  <div className="origin-actions">
                    <button
                      type="button"
                      className="origin-action"
                      aria-pressed={originEditing}
                      data-testid="set-origin"
                      onClick={() => onOriginEditingChange(!originEditing)}
                    >
                      {originEditing ? "Finish setting where you start" : "Set where you start"}
                    </button>
                    {geolocationAvailable && (
                      <button
                        type="button"
                        className="origin-action"
                        disabled={locating}
                        data-testid="use-location"
                        onClick={useDeviceLocation}
                      >
                        {locating ? "Getting your location" : "Use my location"}
                      </button>
                    )}
                  </div>
                  {originEditing && (
                    <div className="origin-help">Drag your mark on the map, or use its arrow keys.</div>
                  )}
                  {locationError && <div className="origin-error" role="status">{locationError}</div>}
                </div>
              )}
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        className="drawer-open tap-44"
        data-testid="open-drawer"
        aria-label="Under the hood"
        onClick={onOpenDrawer}
      >
        {"{ }"}
      </button>
    </header>
  );
}

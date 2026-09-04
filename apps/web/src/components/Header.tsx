import { useEffect, useRef, useState } from "react";
import type { ParticipantSummary, RoomStep } from "../spatial-types.ts";
import { COPY, avatarTilt, initials, personColor } from "../ui/copy.ts";
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
  /** The room's plan, when it has one. Absent for a room with a single
   * destination, which is every room that predates plans. */
  steps?: RoomStep[];
  activeStepId?: string | null;
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
  /** Hand someone a way in. Absent where adding people is not offered. */
  onAddParticipant?(): void;
}

/** "here now" / "arrived" / "not arrived yet" — presence in words. */
function presenceWord(p: ParticipantSummary): string {
  return p.present ? "here now" : p.arrived ? "arrived" : "not arrived yet";
}

export function Header({
  title,
  subtitle,
  participants,
  steps,
  activeStepId,
  meId,
  originEditing,
  onOriginEditingChange,
  onSetOrigin,
  sharedPositionIds,
  onSetOriginSharing,
  onOpenDrawer,
  onAddParticipant,
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
        {/* A room on a plan says where it is in it. Each step carries its own
            mark, so the sequence survives greyscale and reads without
            colour (CLAUDE.md §13). */}
        {steps && steps.length > 1 && (
          <ol className="header-steps" data-testid="header-steps">
            {steps.map((step) => {
              const active = step.stepId === activeStepId;
              return (
                <li
                  key={step.stepId}
                  className="header-step"
                  data-state={step.status}
                  data-active={active || undefined}
                  data-testid={`header-step-${step.stepId}`}
                >
                  <span
                    className="mark"
                    data-mark={
                      // The map's own vocabulary: a settled step is a filled
                      // dot because it is decided, the one being worked on is
                      // the hollow "not yet" ring, and the ones still ahead
                      // are the small grey out mark. Three shapes, so the row
                      // survives greyscale.
                      step.status === "settled"
                        ? undefined
                        : active
                          ? "unknown"
                          : "out"
                    }
                    aria-hidden="true"
                  />
                  <span className="header-step-label">
                    {step.settled ? step.settled.name : step.placeClass.label}
                  </span>
                  {active && <span className="header-step-now">{COPY.stepNow}</span>}
                </li>
              );
            })}
          </ol>
        )}
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
        {/* Adding someone is an action, so it draws in --spoke-act; the
            avatars beside it are identity and never do (CLAUDE.md §2). The
            glyph is small and the tap target is not: the padding reaches
            44px without the drawn mark growing (§13). */}
        {onAddParticipant && (
          <button
            type="button"
            className="add-person"
            data-testid="add-person"
            aria-label={COPY.addPerson}
            title={COPY.addPerson}
            onClick={onAddParticipant}
          >
            <span aria-hidden="true">+</span>
          </button>
        )}
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

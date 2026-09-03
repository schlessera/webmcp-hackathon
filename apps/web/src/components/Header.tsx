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
  onOpenDrawer(): void;
}

/** "here now" / "arrived" / "not arrived yet" — presence in words. */
function presenceWord(p: ParticipantSummary): string {
  return p.present ? "here now" : p.arrived ? "arrived" : "not arrived yet";
}

export function Header({ title, subtitle, participants, onOpenDrawer }: Props) {
  /* The avatar row opens a roster card on tap (W12): names and presence are
     reachable on touch, not only on hover. A disclosure, not navigation —
     it closes on Escape, on an outside tap, or on the row again. */
  const [rosterOpen, setRosterOpen] = useState(false);
  const rosterRef = useRef<HTMLDivElement>(null);
  const avatarsRef = useRef<HTMLButtonElement>(null);
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
        <div className="header-title" data-testid="room-title">
          {title ? title : <Wordmark />}
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
                data-testid={`avatar-${p.participantId}`}
              >
                <span aria-hidden="true">{initials(p.displayName)}</span>
                <span className="sr-only">
                  {p.displayName}
                  {state ? `, ${state}` : ""}
                </span>
                {p.present && <i className="avatar-here" aria-hidden="true" />}
              </span>
            );
          })}
        </button>
        {rosterOpen && (
          <div className="roster-card" role="dialog" aria-label="Who is in the room" data-testid="roster-card">
            {participants.map((p, i) => (
              <div className="roster-row" key={p.participantId} data-testid={`roster-${p.participantId}`}>
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
                  {presenceWord(p)}
                </span>
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

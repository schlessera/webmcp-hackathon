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

export function Header({ title, subtitle, participants, onOpenDrawer }: Props) {
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

      <div className="avatars" data-testid="avatars">
        {/* No presence signal exists on the wire yet, so every roster member
            draws in their own colour; --spoke-person-idle is reserved for the
            "invited, not yet arrived" state a future presence channel adds. */}
        {participants.map((p, i) => {
          return (
            <span
              key={p.participantId}
              className="avatar"
              style={{
                background: personColor(i),
                transform: `rotate(${avatarTilt(i)}deg)`,
              }}
              title={p.displayName}
              data-testid={`avatar-${p.participantId}`}
            >
              <span aria-hidden="true">{initials(p.displayName)}</span>
              <span className="sr-only">{p.displayName}</span>
            </span>
          );
        })}
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

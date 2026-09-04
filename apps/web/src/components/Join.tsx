import { useEffect, useState } from "react";
import { claimInvite, fetchInviteContext, type InviteContext } from "../invite-api.ts";
import { adoptSession, deviceId } from "../session.ts";
import { COPY } from "../ui/copy.ts";
import { Wordmark } from "./Wordmark.tsx";

/**
 * Someone else's link, before it is yours.
 *
 * A person arriving here has a URL and nothing else. What they get told is
 * what the room is for and who started it — enough to know whether they
 * meant to click this — and never who else is in it. A roster is the room's
 * business, and a link is not a member of the room.
 *
 * Accounts are the one thing this screen offers and cannot give: the demo
 * has none, so the control is present, disabled, and says why rather than
 * pretending the choice does not exist.
 */

interface Props {
  joinSecret: string;
  /** The claim worked: this page is now a participant of that room. */
  onJoined(room: { roomId: string }): void;
}

type Failure = "in_use" | "expired" | "unknown" | "invalid" | "network";

const FAILURE_COPY: Record<Failure, string> = {
  in_use: COPY.joinInUse,
  expired: COPY.joinExpired,
  unknown: COPY.joinUnknown,
  invalid: COPY.joinFailed,
  network: COPY.joinFailed,
};

export function Join({ joinSecret, onJoined }: Props) {
  const [context, setContext] = useState<InviteContext | null | "missing">(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInviteContext(joinSecret).then((found) => {
      if (!cancelled) setContext(found ?? "missing");
    });
    return () => {
      cancelled = true;
    };
  }, [joinSecret]);

  const join = async () => {
    const displayName = name.trim();
    if (!displayName || busy) return;
    setBusy(true);
    setFailure(null);
    const claimed = await claimInvite(joinSecret, displayName, deviceId());
    if (!claimed.ok) {
      setBusy(false);
      setFailure(claimed.reason);
      return;
    }
    adoptSession(
      {
        participantId: claimed.participantId,
        displayName: claimed.displayName,
        role: claimed.role,
        roomId: claimed.roomId,
      },
      claimed.participantToken,
    );
    onJoined({ roomId: claimed.roomId });
  };

  if (context === null) {
    return (
      <div className="connect-screen">
        <Wordmark />
        <span>Reading the invitation…</span>
      </div>
    );
  }

  if (context === "missing") {
    return (
      <div className="start" data-testid="join-unknown">
        <Wordmark />
        <p className="start-error" role="alert">{COPY.joinUnknown}</p>
      </div>
    );
  }

  return (
    <div className="start" data-testid="join">
      <Wordmark />

      <p className="join-lede">{COPY.joinLede(context.organizer.displayName)}</p>
      <p className="join-goal" data-testid="join-goal">{context.goal}</p>

      {context.steps.length > 0 && (
        <ol className="join-steps">
          {context.steps.map((step, index) => (
            <li key={`${index}:${step.title}`} className="join-step">
              <span className="mark" aria-hidden="true" />
              <span className="join-step-title">{step.title}</span>
              <span className="join-step-class">{step.placeClass.label}</span>
            </li>
          ))}
        </ol>
      )}

      <p className="join-meta">
        {COPY.joinCount(context.participantCount)}
        {context.area && ` ${context.area.label}.`}
      </p>

      {failure && (
        <p className="start-error" role="alert" data-testid="join-error">
          {FAILURE_COPY[failure]}
        </p>
      )}

      {context.claimable && !failure && (
        <form
          className="join-form"
          onSubmit={(event) => {
            event.preventDefault();
            void join();
          }}
        >
          <button type="button" className="join-account" disabled data-testid="join-account">
            {COPY.joinAccount}
          </button>
          <p className="join-account-note">{COPY.joinAccountOff}</p>

          <label className="ask-field">
            <span>{COPY.joinNameLabel}</span>
            <input
              value={name}
              data-testid="join-name"
              autoComplete="given-name"
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <button
            type="submit"
            className="ask-go"
            data-testid="join-go"
            disabled={busy || name.trim().length === 0}
          >
            {busy ? COPY.joinJoining : COPY.joinGo}
          </button>
        </form>
      )}

      {!context.claimable && !failure && (
        <p className="start-error" role="alert">{COPY.joinExpired}</p>
      )}
    </div>
  );
}

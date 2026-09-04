import { useCallback, useEffect, useRef, useState } from "react";
import {
  listInvites,
  mintInvite,
  type InviteRow,
  type MintedInvite,
} from "../invite-api.ts";
import { COPY } from "../ui/copy.ts";
import { Qr } from "../ui/qr.tsx";

/**
 * Handing someone a way in.
 *
 * A link and the same link as a code, because the two ways this actually
 * happens are sending a message and holding a phone up across a table. The
 * list below them is what makes single-use links comprehensible: without it,
 * "why did the link I sent stop working" has no answer on screen.
 *
 * Nothing here is protocol-shaped (CLAUDE.md §6): no ids, no expiry
 * timestamps, no status codes. "not used yet", "Sarah joined", "expired".
 */

interface Props {
  onClose(): void;
}

function joinUrl(secret: string): string {
  return `${window.location.origin}/#join=${secret}`;
}

function stateWord(row: InviteRow): string {
  if (row.state === "claimed") return COPY.invitesClaimed(row.claimedBy ?? "Someone");
  return row.state === "expired" ? COPY.invitesExpired : COPY.invitesUnused;
}

export function InviteDialog({ onClose }: Props) {
  const [current, setCurrent] = useState<MintedInvite | null>(null);
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [copied, setCopied] = useState(false);
  const [minting, setMinting] = useState(false);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    setRows(await listInvites());
  }, []);

  const mint = useCallback(async () => {
    setMinting(true);
    setCopied(false);
    const minted = await mintInvite();
    setMinting(false);
    if (!minted) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setCurrent(minted);
    void refresh();
  }, [refresh]);

  // Opening the dialog IS asking for a link: the person clicked "add
  // someone", and making them click again to get the thing they asked for
  // would be a step that exists only because the code has two calls.
  useEffect(() => {
    void mint();
  }, [mint]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const url = current ? joinUrl(current.inviteSecret) : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const share = async () => {
    try {
      await navigator.share({ text: url });
    } catch {
      /* dismissed, or unavailable: the link and the code are still here */
    }
  };

  return (
    <div className="invite-scrim" data-testid="invite-dialog">
      <div className="invite-dialog card" role="dialog" aria-modal="true" aria-labelledby="invite-title">
        <header className="invite-head">
          <h2 className="invite-title" id="invite-title">{COPY.invitesTitle}</h2>
          <button
            type="button"
            className="invite-close"
            ref={closeRef}
            data-testid="invite-close"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        <p className="invite-lede">{COPY.invitesLede}</p>

        {failed && <p className="start-error" role="alert">Could not make a link. Try again.</p>}

        {current && (
          <>
            <div className="invite-qr-wrap">
              <Qr value={url} label={`Join link for ${COPY.invitesTitle.toLowerCase()}`} />
            </div>

            <p className="invite-url" data-testid="invite-url">{url}</p>

            <div className="invite-actions">
              <button type="button" className="invite-copy" data-testid="invite-copy" onClick={() => void copy()}>
                {copied ? COPY.invitesCopied : COPY.invitesCopy}
              </button>
              {typeof navigator !== "undefined" && "share" in navigator && (
                <button type="button" className="invite-share" onClick={() => void share()}>
                  {COPY.invitesShare}
                </button>
              )}
              <button
                type="button"
                className="invite-new"
                data-testid="invite-new"
                disabled={minting}
                onClick={() => void mint()}
              >
                {COPY.invitesNew}
              </button>
            </div>
          </>
        )}

        <p className="invite-rule">{COPY.invitesOne}</p>
        <p className="invite-rule">{COPY.invitesExpiry}</p>

        <ul className="invite-rows" data-testid="invite-rows">
          {rows.length === 0 && <li className="invite-empty">{COPY.invitesNone}</li>}
          {rows.map((row) => (
            <li key={row.inviteId} className="invite-row" data-state={row.state}>
              <span
                className="mark"
                data-mark={row.state === "claimed" ? undefined : row.state === "expired" ? "out" : "unknown"}
                aria-hidden="true"
              />
              <span className="invite-row-state">{stateWord(row)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

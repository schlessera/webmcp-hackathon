/**
 * Tab-scoped identity (Gate 3): the invite secret rides in the URL fragment
 * (never sent to the server in a request line), is exchanged for a participant
 * token held in sessionStorage, and every API call sends it as a bearer token.
 * Reloads preserve identity; the fragment stays in the URL as a re-exchange
 * fallback for surfaces where sessionStorage does not survive reload.
 */

import { wire } from "./wire-store.ts";

const TOKEN_KEY = "participantToken";
const IDENTITY_KEY = "participantIdentity";

// In-memory fallback: some embedded/privacy-restricted surfaces reject
// sessionStorage writes; identity then still works for this page's lifetime.
let memoryToken: string | null = null;

export interface SessionIdentity {
  participantId: string;
  displayName: string;
  role: "organizer" | "member";
  roomId: string;
}

export interface SessionState {
  token: string | null;
  identity: SessionIdentity | null;
  error: string | null;
}

function storedToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storedIdentity(): SessionIdentity | null {
  try {
    const raw = sessionStorage.getItem(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as SessionIdentity) : null;
  } catch {
    return null;
  }
}

export function inviteSecretFromFragment(): string | null {
  const match = /[#&]invite=([a-f0-9]+)/.exec(window.location.hash);
  return match ? match[1] : null;
}

export async function establishSession(): Promise<SessionState> {
  const token = storedToken();
  const identity = storedIdentity();
  if (token && identity) return { token, identity, error: null };

  const inviteSecret = inviteSecretFromFragment();
  if (!inviteSecret) {
    return {
      token: null,
      identity: null,
      error: "No invite in the URL and no stored session. Open an invite link.",
    };
  }
  // On the timeline as a request with a status; the secret and the token it
  // buys never leave this function.
  const span = wire.begin({ lane: "http", label: "POST /api/session/exchange" });
  let response: Response;
  try {
    response = await fetch("/api/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteSecret }),
    });
  } catch (err) {
    wire.end(span, { outcome: "error", note: "network" });
    throw err;
  }
  const serverMs = Number(response.headers.get("x-server-ms"));
  wire.end(span, {
    outcome: response.ok ? "ok" : "error",
    note: String(response.status),
    serverMs: Number.isFinite(serverMs) && response.headers.has("x-server-ms") ? serverMs : undefined,
  });
  if (!response.ok) {
    return {
      token: null,
      identity: null,
      error: `Invite exchange failed (${response.status}).`,
    };
  }
  const body = await response.json();
  const fresh: SessionIdentity = {
    participantId: body.participantId,
    displayName: body.displayName,
    role: body.role,
    roomId: body.roomId,
  };
  memoryToken = body.participantToken;
  try {
    sessionStorage.setItem(TOKEN_KEY, body.participantToken);
    sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(fresh));
  } catch {
    // sessionStorage unavailable: memoryToken carries this page's identity.
  }
  return { token: body.participantToken, identity: fresh, error: null };
}

export function currentToken(): string | null {
  return memoryToken ?? storedToken();
}

/**
 * Drop a dead session (e.g. tokens wiped by `make demo-reset`) so
 * establishSession() re-exchanges from the invite fragment still in the URL.
 */
export function clearSession(): void {
  memoryToken = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* nothing stored */
  }
}

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

/** A shared link someone has not taken yet. `#invite=` is already somebody's. */
export function joinSecretFromFragment(): string | null {
  const match = /[#&]join=([a-f0-9]+)/.exec(window.location.hash);
  return match ? match[1] : null;
}

const DEVICE_KEY = "spokesDevice";

/**
 * This browser, as far as an invite link is concerned.
 *
 * Not an identity and never shown: it is what lets a single-use link stay
 * usable by the person who took it, on a demo with no accounts. It lives in
 * localStorage rather than sessionStorage because closing the tab must not
 * lose someone their way back into a room. Where storage is refused, a
 * per-page value still works for this page's life, which is the same
 * bargain the token above makes.
 */
let memoryDevice: string | null = null;
export function deviceId(): string {
  if (memoryDevice) return memoryDevice;
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored) {
      memoryDevice = stored;
      return stored;
    }
  } catch {
    /* storage refused: fall through to a value for this page */
  }
  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  memoryDevice = fresh;
  try {
    localStorage.setItem(DEVICE_KEY, fresh);
  } catch {
    /* nothing stored; memoryDevice carries this page */
  }
  return fresh;
}

/**
 * Exchange a secret this page was handed rather than one in its own URL.
 *
 * The onboarding tool needs it: it has just created a room and holds the
 * organizer's secret in memory, and it must be able to act as them (to mint
 * a join link) before the page has navigated anywhere.
 */
export async function exchangeInvite(inviteSecret: string): Promise<SessionIdentity | null> {
  try {
    const response = await fetch("/api/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteSecret }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const identity: SessionIdentity = {
      participantId: body.participantId,
      displayName: body.displayName,
      role: body.role,
      roomId: body.roomId,
    };
    adoptSession(identity, body.participantToken);
    return identity;
  } catch {
    return null;
  }
}

/** Adopt the identity a claimed invite just minted, as an exchange would. */
export function adoptSession(identity: SessionIdentity, token: string): void {
  memoryToken = token;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    /* sessionStorage unavailable: memoryToken carries this page's identity */
  }
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

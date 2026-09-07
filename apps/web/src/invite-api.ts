import { currentToken } from "./session.ts";
import { wire } from "./wire-store.ts";

/**
 * Invite links: how someone joins a room that already exists.
 *
 * Half of these calls carry a token and half deliberately do not. Minting
 * and listing happen from inside the room; reading what a link is for, and
 * taking it, happen from outside — before the person has any identity at
 * all. That split is the feature, so it is drawn here rather than hidden
 * behind one helper.
 */

export interface MintedInvite {
  inviteId: string;
  /** The raw secret. Arrives once and is never stored anywhere but the URL. */
  inviteSecret: string;
  expiresAt: string;
}

export interface InviteRow {
  inviteId: string;
  state: "unused" | "claimed" | "expired";
  createdAt: string;
  expiresAt: string;
  claimedBy: string | null;
}

/** What a room shows someone who has not joined it yet. */
export interface InviteContext {
  goal: string;
  organizer: { displayName: string };
  participantCount: number;
  area: { id: string; label: string } | null;
  steps: Array<{ title: string; placeClass: { label: string } }>;
  claimable: boolean;
  reason: "expired" | "in_use" | null;
}

function serverMs(response: Response): number | undefined {
  const value = Number(response.headers.get("x-server-ms"));
  return response.headers.has("x-server-ms") && Number.isFinite(value) ? value : undefined;
}

export async function mintInvite(): Promise<MintedInvite | null> {
  const token = currentToken();
  if (!token) return null;
  const span = wire.begin({ lane: "http", label: "POST invites" });
  try {
    const response = await fetch("/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    });
    wire.end(span, {
      outcome: response.ok ? "ok" : "error",
      note: response.ok ? "ok" : `http ${response.status}`,
      serverMs: serverMs(response),
    });
    if (!response.ok) return null;
    return (await response.json()) as MintedInvite;
  } catch {
    wire.end(span, { outcome: "error", note: "network" });
    return null;
  }
}

export async function listInvites(): Promise<InviteRow[]> {
  const token = currentToken();
  if (!token) return [];
  try {
    const response = await fetch("/api/invites", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    return ((await response.json()) as { invites: InviteRow[] }).invites;
  } catch {
    return [];
  }
}

export async function fetchInviteContext(secret: string): Promise<InviteContext | null> {
  try {
    const response = await fetch(`/api/invites/${encodeURIComponent(secret)}/context`);
    if (!response.ok) return null;
    return (await response.json()) as InviteContext;
  } catch {
    return null;
  }
}

export type ClaimOutcome =
  | {
      ok: true;
      participantToken: string;
      participantId: string;
      displayName: string;
      role: "organizer" | "member";
      roomId: string;
    }
  | { ok: false; reason: "in_use" | "full" | "expired" | "unknown" | "invalid" | "network" };

/**
 * Take a link, or come back through one this device already took.
 *
 * The refusals are the half worth reading: a link someone else is using says
 * only that and names nobody. Who is in a room is the room's business, not
 * something a URL hands to whoever tries it.
 */
export async function claimInvite(
  secret: string,
  displayName: string,
  deviceId: string,
): Promise<ClaimOutcome> {
  try {
    const response = await fetch(`/api/invites/${encodeURIComponent(secret)}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName, deviceId }),
    });
    if (response.ok) {
      const body = (await response.json()) as {
        participantToken: string;
        participantId: string;
        displayName: string;
        role: "organizer" | "member";
        roomId: string;
      };
      return { ok: true, ...body };
    }
    if (response.status === 409) {
      const body = await response.json() as { error?: string };
      return { ok: false, reason: body.error === "room_full" ? "full" : "in_use" };
    }
    if (response.status === 410) return { ok: false, reason: "expired" };
    if (response.status === 404) return { ok: false, reason: "unknown" };
    return { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "network" };
  }
}

import type pg from "pg";
import type { Delta, ProjectedEvent } from "@webmcp-hackathon/contracts";
import { projectEvent, type StoredEvent } from "./projection.ts";

// X1: sync may lower this normal page cap before encoding when the complete
// envelope would exceed its allowance. Larger histories continue through the
// existing opaque cursor; events are never deleted from an already-built page.
export const DELTA_CAP = 10;
// R1: normal reconnects page completely, but an unbounded replay must not hold
// a room share lock or allocate without limit. Crossing this cap is explicit:
// the caller replaces its projections from a full sync instead of skipping.
export const DELTA_BACKLOG_CAP = 1_000;

interface CursorState {
  version: 1;
  roomId: string;
  viewerId: string;
  fromRevision: number;
  afterRevision: number;
  targetRevision: number;
}

export class InvalidDeltaCursor extends Error {}

function encodeCursor(state: CursorState): string {
  return `d1.${Buffer.from(JSON.stringify(state)).toString("base64url")}`;
}

function decodeCursor(cursor: string, roomId: string, viewerId: string): CursorState {
  try {
    if (!cursor.startsWith("d1.")) throw new Error("version");
    const parsed = JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8")) as CursorState;
    if (
      parsed.version !== 1 ||
      parsed.roomId !== roomId ||
      parsed.viewerId !== viewerId ||
      !Number.isSafeInteger(parsed.fromRevision) ||
      !Number.isSafeInteger(parsed.afterRevision) ||
      !Number.isSafeInteger(parsed.targetRevision) ||
      parsed.fromRevision < 0 ||
      parsed.afterRevision < parsed.fromRevision ||
      parsed.targetRevision < parsed.afterRevision
    ) {
      throw new Error("binding");
    }
    return parsed;
  } catch {
    throw new InvalidDeltaCursor("Invalid or expired delta cursor.");
  }
}

export async function buildDelta(
  q: pg.PoolClient | pg.Pool,
  roomId: string,
  viewerId: string,
  sinceRevision: number | undefined,
  cursor?: string,
  currentRevision?: number,
  projectedEventCap = DELTA_CAP,
): Promise<Delta> {
  const continuation = cursor ? decodeCursor(cursor, roomId, viewerId) : null;
  if (!continuation && sinceRevision === undefined) {
    throw new InvalidDeltaCursor("sinceRevision is required without a cursor.");
  }
  const fromRevision = continuation?.fromRevision ?? sinceRevision!;
  const afterRevision = continuation?.afterRevision ?? sinceRevision!;
  let roomRevision = currentRevision;
  if (roomRevision === undefined) {
    const row = (await q.query("SELECT revision FROM rooms WHERE id = $1", [roomId])).rows[0];
    if (!row) throw new InvalidDeltaCursor("Session not found.");
    roomRevision = Number(row.revision);
  }
  const requestedTargetRevision = continuation?.targetRevision ?? roomRevision;
  if (afterRevision > roomRevision) {
    // X6: cursor and non-cursor paths enforce the same room-head boundary.
    throw new InvalidDeltaCursor(
      `Delta cursor revision ${afterRevision} is ahead of room revision ${roomRevision}.`,
    );
  }
  // X6: the cursor is opaque but not signed. Binding prevents cross-viewer
  // reads; clamping prevents a forged target from advancing this viewer's
  // last-synced stamp beyond the actual room head.
  const targetRevision = Math.min(requestedTargetRevision, roomRevision);

  const remaining = Number(
    (
      await q.query(
        `SELECT count(*)::int AS count FROM events
          WHERE room_id = $1 AND revision > $2 AND revision <= $3`,
        [roomId, afterRevision, targetRevision],
      )
    ).rows[0]?.count ?? 0,
  );
  if (!continuation && remaining > DELTA_BACKLOG_CAP) {
    return {
      fromRevision,
      events: [],
      truncated: false,
      throughRevision: afterRevision,
      resyncRequired: "backlog_too_large",
    };
  }

  const rows = (
    await q.query(
      `SELECT revision, type, actor_id, visibility, payload
         FROM events
        WHERE room_id = $1 AND revision > $2 AND revision <= $3
        ORDER BY revision ASC`,
      [roomId, afterRevision, targetRevision],
    )
  ).rows;
  const projected: ProjectedEvent[] = [];
  let throughRevision = afterRevision;
  for (const row of rows) {
    const event: StoredEvent = {
      revision: row.revision,
      type: row.type,
      actorId: row.actor_id,
      visibility: row.visibility,
      payload: row.payload,
    };
    const view = projectEvent(event, viewerId);
    if (view) projected.push(view);
    // R1: advance over omitted private events too; otherwise a page containing
    // only peer-private history could never complete.
    throughRevision = Number(row.revision);
    if (projected.length === projectedEventCap) break;
  }
  const truncated = throughRevision < targetRevision;
  return {
    fromRevision: afterRevision,
    events: projected,
    truncated,
    throughRevision: truncated ? throughRevision : targetRevision,
    ...(truncated
      ? {
          cursor: encodeCursor({
            version: 1,
            roomId,
            viewerId,
            fromRevision,
            afterRevision: throughRevision,
            targetRevision,
          }),
        }
      : {}),
  };
}

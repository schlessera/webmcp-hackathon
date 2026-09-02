import type pg from "pg";
import { graded, isVerified as isVerifiedStatus } from "@webmcp-hackathon/contracts";

/**
 * Attestations (SPATIAL-PROTOCOL.md §8, amendment of 2026-09-02): what a
 * participant found out about a place that the map data did not know.
 *
 * Precedence, applied at read time and never written into the dossier:
 *
 *   1. A verified OpenStreetMap or curated fact wins. An attestation that
 *      agrees leaves it as it is; one that contradicts it makes the fact
 *      `unverified` with source `disputed:` — the room can see both sides in
 *      the ledger and the engine treats the place as unsure.
 *   2. Over an unknown or unverified fact, an attestation is decisive: the
 *      fact takes the attested status with source `agent:<participantId>`.
 *      Two participants who disagree make it `unverified` / `disputed:`.
 *   3. Attestations are per room. They never cross rooms, and a room's
 *      candidates.attributes rows are never modified.
 *
 * The status vocabulary stays verified_true / verified_false / unverified /
 * unknown: "disputed" is a source prefix, not a fifth status.
 */

export interface AttestationRow {
  candidate_id: string;
  key: string;
  participant_id: string;
  status: "verified_true" | "verified_false";
  confidence: number;
  note: string;
  source_url: string | null;
  at_revision: number;
}

export interface MergedAttribute {
  key: string;
  status: string;
  value?: string | number;
  source?: string;
  observedAt?: string;
  confidence?: number;
  /** Set when an attestation decided (or disputed) this fact. */
  attestedBy?: string;
  note?: string;
  sourceUrl?: string;
}

export async function loadAttestations(
  q: pg.PoolClient | pg.Pool,
  roomId: string,
): Promise<AttestationRow[]> {
  return (
    await q.query(
      `SELECT candidate_id, key, participant_id, status, confidence, note, source_url, at_revision
         FROM attestations WHERE room_id = $1 ORDER BY at_revision, participant_id`,
      [roomId],
    )
  ).rows as AttestationRow[];
}

const isVerified = (s: string) => isVerifiedStatus(s);
/** An attestation's own status: verified when the attester is sure enough (§8.2). */
const statusOf = (r: AttestationRow) => graded(r.status === "verified_true", r.confidence);

/** The dossier attributes of one candidate with its attestations applied. */
export function applyAttestations<T extends MergedAttribute>(
  candidateId: string,
  attributes: T[],
  attestations: AttestationRow[],
): T[] {
  const mine = attestations.filter((a) => a.candidate_id === candidateId);
  if (mine.length === 0) return attributes;
  const byKey = new Map<string, AttestationRow[]>();
  for (const a of mine) {
    const list = byKey.get(a.key) ?? [];
    list.push(a);
    byKey.set(a.key, list);
  }
  const out = attributes.map((attr) => {
    const rows = byKey.get(attr.key);
    if (!rows) return attr;
    byKey.delete(attr.key);
    return merge(attr, rows);
  });
  // A fact the dossier had no row for at all: the attestation creates it.
  for (const [key, rows] of byKey) {
    out.push(merge({ key, status: "unknown" } as T, rows));
  }
  return out;
}

function merge<T extends MergedAttribute>(attr: T, rows: AttestationRow[]): T {
  const statuses = new Set(rows.map((r) => r.status));
  const latest = rows[rows.length - 1];
  const agentSource = `agent:${latest.participant_id}`;
  if (isVerified(attr.status)) {
    // Source data is verified: an agreeing attestation changes nothing; a
    // contradicting one disputes it. Disputed reads as unknown with both
    // sides on record (§8.2: the vocabulary has no fifth "disputed" status).
    if (statuses.size === 1 && statuses.has(attr.status as AttestationRow["status"])) {
      return attr;
    }
    const contradicting = rows.find((r) => r.status !== attr.status)!;
    return {
      ...attr,
      status: "unknown",
      confidence: 0,
      source: `disputed:${attr.source ?? "record"}|agent:${contradicting.participant_id}`,
      attestedBy: contradicting.participant_id,
      note: contradicting.note,
      ...(contradicting.source_url ? { sourceUrl: contradicting.source_url } : {}),
    };
  }
  if (statuses.size > 1) {
    // Two attesters disagree and the source data cannot arbitrate.
    return {
      ...attr,
      status: "unknown",
      confidence: 0,
      source: `disputed:${rows.map((r) => `agent:${r.participant_id}`).join("|")}`,
      attestedBy: latest.participant_id,
      note: latest.note,
    };
  }
  // Over a gap or a guess, the attester's word stands — graded by how sure they were.
  return {
    ...attr,
    status: statusOf(latest),
    source: agentSource,
    confidence: latest.confidence,
    attestedBy: latest.participant_id,
    note: latest.note,
    ...(latest.source_url ? { sourceUrl: latest.source_url } : {}),
  };
}

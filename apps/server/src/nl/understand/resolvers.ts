import type { Concept, ScopePayloadReferent } from "@webmcp-hackathon/contracts";
import { findLandmarks as indexLandmarks } from "../../landmarks.ts";

export interface LandmarkHit {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  location: { lat: number; lng: number };
  score: number;
}

export type FindLandmarks = (areaId: string, query: string) => LandmarkHit[];
let findLandmarks: FindLandmarks = indexLandmarks;

/** Tests swap the index for a fixture one; nothing else may. */
export function setFindLandmarks(next: FindLandmarks | null): void {
  findLandmarks = next ?? indexLandmarks;
}

export interface ReferentRoom {
  areaId: string;
  candidateNames: Array<{ candidateId: string; name: string }>;
  participantNames: Array<{ participantId: string; name: string }>;
  agreementCandidateId?: string;
  proposalCandidateIds?: string[];
}

export interface ResolvedReferent {
  referent: ScopePayloadReferent | null;
  label: string | null;
  choices?: Array<{ referent: ScopePayloadReferent; label: string }>;
  question?: string;
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, " ").trim();
}

function nameMatches<T extends { name: string }>(rows: T[], query: string): T[] {
  const wanted = normalized(query);
  const exact = rows.filter((row) => normalized(row.name) === wanted);
  if (exact.length) return exact;
  return rows.filter((row) => {
    const name = normalized(row.name);
    return name.startsWith(`${wanted} `) || wanted.startsWith(`${name} `);
  });
}

function roomRelativeKind(name: string): "agreement" | "meeting" | null {
  const value = normalized(name);
  if (/station we meet|where we meet|unser treffpunkt|bahnhof an dem wir uns treffen/.test(value)) return "meeting";
  if (/we picked|we chose|we agreed|we are going|where we re going|where we are going|wir gewahlt|wo wir hingehen/.test(value)) return "agreement";
  return null;
}

/** In-process resolution in the §3.6 order. It never performs network I/O. */
export function resolveConceptReferent(concept: Concept, room: ReferentRoom): ResolvedReferent {
  const source = concept.referent;
  if (!source || source.kind === "self" || source.kind === "here") {
    return { referent: { kind: "self" }, label: null };
  }
  if (source.kind === "scope_center") {
    return { referent: { kind: "scopeCenter" }, label: "the area centre" };
  }
  const name = source.name?.trim() ?? "";
  const relative = roomRelativeKind(name);
  if (relative === "agreement") {
    const ids = room.agreementCandidateId
      ? [room.agreementCandidateId]
      : [...new Set(room.proposalCandidateIds ?? [])];
    const rows = ids.flatMap((candidateId) => {
      const match = room.candidateNames.find((row) => row.candidateId === candidateId);
      return match ? [match] : [];
    });
    if (rows.length === 1) {
      return { referent: { kind: "candidate", candidateId: rows[0].candidateId }, label: rows[0].name };
    }
    if (rows.length > 1) {
      return {
        referent: null,
        label: null,
        question: "Which place in the room?",
        choices: rows.slice(0, 3).map((row) => ({
          referent: { kind: "candidate", candidateId: row.candidateId },
          label: row.name,
        })),
      };
    }
  }
  if (relative === "meeting") {
    return { referent: null, label: null, question: "Which station?" };
  }

  const candidates = nameMatches(room.candidateNames, name);
  if (candidates.length === 1) {
    return {
      referent: { kind: "candidate", candidateId: candidates[0].candidateId },
      label: candidates[0].name,
    };
  }
  if (candidates.length > 1) {
    return {
      referent: null,
      label: null,
      question: `Which ${name}?`.slice(0, 120),
      choices: candidates.slice(0, 3).map((row) => ({
        referent: { kind: "candidate", candidateId: row.candidateId },
        label: row.name,
      })),
    };
  }

  const participantQuery = name.replace(/^(?:where\s+)?/i, "").replace(/\s+starts$/i, "");
  const participants = nameMatches(room.participantNames, participantQuery);
  if (participants.length === 1) {
    return {
      referent: { kind: "participant", participantId: participants[0].participantId },
      label: `where ${participants[0].name} starts`,
    };
  }
  if (participants.length > 1) {
    return {
      referent: null,
      label: null,
      question: `Which ${name}?`.slice(0, 120),
      choices: participants.slice(0, 3).map((row) => ({
        referent: { kind: "participant", participantId: row.participantId },
        label: `where ${row.name} starts`,
      })),
    };
  }

  const landmarks = findLandmarks(room.areaId, name);
  if (landmarks.length === 1) {
    return {
      referent: { kind: "landmark", landmarkId: landmarks[0].id },
      label: landmarks[0].name,
    };
  }
  if (landmarks.length > 1) {
    return {
      referent: null,
      label: null,
      question: `Which ${name}?`.slice(0, 120),
      choices: landmarks.slice(0, 3).map((row) => ({
        referent: { kind: "landmark", landmarkId: row.id },
        label: `${row.name} · ${row.kindLabel}`.slice(0, 60),
      })),
    };
  }
  return {
    referent: null,
    label: null,
    question: `I could not place ${name}`.slice(0, 120),
  };
}

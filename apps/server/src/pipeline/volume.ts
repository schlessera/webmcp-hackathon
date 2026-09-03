import type { PipelineMessage } from "@webmcp-hackathon/contracts";
import type { PipelineItem, PipelineKind } from "./queue.ts";

export type PipelineFamily = "fetch" | "process";
export type VolumeStatus = "outstanding" | "inFlight";

export function familyOf(kind: PipelineKind): PipelineFamily {
  return kind.startsWith("fetch.") ? "fetch" : "process";
}

/** RFC 6298 §2.2/2.3 smoothed mean and deviation. */
export class Rfc6298Estimator {
  ewma?: number;
  dev?: number;
  samples = 0;

  sample(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    if (this.ewma === undefined || this.dev === undefined) {
      this.ewma = value;
      this.dev = value / 2;
    } else {
      this.dev = 0.75 * this.dev + 0.25 * Math.abs(this.ewma - value);
      this.ewma = 0.875 * this.ewma + 0.125 * value;
    }
    this.samples += 1;
  }

  estimate(): number | undefined {
    return this.ewma === undefined || this.dev === undefined
      ? undefined
      : this.ewma + 4 * this.dev;
  }
}

interface TrackedItem {
  item: PipelineItem;
  status: VolumeStatus;
  startedAt?: number;
}

interface RoomVolume {
  items: Map<string, TrackedItem>;
  done: Set<string>;
  paused: "budget" | "idle" | null;
}

export class PipelineVolumeModel {
  private readonly rooms = new Map<string, RoomVolume>();
  readonly latency = {
    fetch: new Rfc6298Estimator(),
    process: new Rfc6298Estimator(),
  };
  private readonly limits: Record<PipelineFamily, number>;

  constructor(limits: Partial<Record<PipelineFamily, number>> = {}) {
    this.limits = { fetch: Math.max(1, limits.fetch ?? 8), process: Math.max(1, limits.process ?? 2) };
  }

  enqueue(item: PipelineItem): void {
    const room = this.state(item.roomId);
    room.done.delete(item.candidateId);
    room.items.set(item.dedupeKey, { item, status: "outstanding" });
    room.paused = null;
  }

  start(item: PipelineItem, now = Date.now()): void {
    const tracked = this.rooms.get(item.roomId)?.items.get(item.dedupeKey);
    if (!tracked) return;
    tracked.status = "inFlight";
    tracked.startedAt = now;
  }

  settle(item: PipelineItem, now = Date.now()): void {
    const room = this.rooms.get(item.roomId);
    const tracked = room?.items.get(item.dedupeKey);
    if (!room || !tracked) return;
    if (tracked.startedAt !== undefined) {
      this.latency[familyOf(item.kind)].sample(Math.max(0, now - tracked.startedAt));
    }
    room.items.delete(item.dedupeKey);
    if (![...room.items.values()].some((entry) => entry.item.candidateId === item.candidateId)) {
      room.done.add(item.candidateId);
    }
  }

  drop(item: PipelineItem): void {
    this.rooms.get(item.roomId)?.items.delete(item.dedupeKey);
  }

  reset(roomId: string): void {
    this.rooms.delete(roomId);
  }

  pause(roomId: string, paused: "budget" | "idle" | null): void {
    this.state(roomId).paused = paused;
  }

  snapshot(roomId: string): Omit<PipelineMessage, "type" | "stages" | "reset" | "reason"> {
    const room = this.rooms.get(roomId);
    const outstanding = { fetch: 0, process: 0 };
    const inFlight = { fetch: 0, process: 0 };
    if (room) {
      for (const tracked of room.items.values()) {
        const family = familyOf(tracked.item.kind);
        if (tracked.status === "outstanding") outstanding[family] += 1;
        else inFlight[family] += 1;
      }
    }
    const activePlaces = new Set(
      room ? [...room.items.values()].map((tracked) => tracked.item.candidateId) : [],
    );
    const done = room?.done.size ?? 0;
    const total = new Set([...(room?.done ?? []), ...activePlaces]).size;
    const estimates = (Object.keys(outstanding) as PipelineFamily[]).flatMap((family) => {
      const perItem = this.latency[family].estimate();
      const remaining = outstanding[family] + inFlight[family];
      return perItem === undefined || remaining === 0
        ? []
        : [perItem * remaining / this.limits[family]];
    });
    return {
      outstanding,
      inFlight,
      done,
      total,
      ...(estimates.length ? { etaMs: Math.ceil(Math.max(...estimates)) } : {}),
      ...(room ? { paused: room.paused } : {}),
    };
  }

  private state(roomId: string): RoomVolume {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { items: new Map(), done: new Set(), paused: null };
      this.rooms.set(roomId, room);
    }
    return room;
  }
}

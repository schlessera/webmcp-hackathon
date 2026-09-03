import type {
  LookupsMessage,
  PipelineMessage,
  PipelineStage,
} from "@webmcp-hackathon/contracts";
import type { PipelineItem } from "./queue.ts";
import type { PipelineVolumeModel } from "./volume.ts";

export const PIPELINE_COALESCE_MS = 250;

type PipelineListener = (roomId: string, message: PipelineMessage) => void;
type LookupsListener = (roomId: string, message: LookupsMessage) => void;
type FrameReason = NonNullable<LookupsMessage["reason"]> & {
  /** Labels are allowed only when every need behind them is shared. */
  visibility?: "shared" | "application-private" | "agent-private";
};

interface StageEntry {
  item: PipelineItem;
  stage: PipelineStage;
  reason?: FrameReason;
}

interface FrameRoom {
  entries: Map<string, StageEntry>;
  sentStages: Map<string, PipelineStage>;
  stalled: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  lastPipeline?: string;
  lastLookups?: string;
  quiet: boolean;
}

export class PipelineFrames {
  private readonly rooms = new Map<string, FrameRoom>();
  private readonly pipelineListeners = new Set<PipelineListener>();
  private readonly lookupsListeners = new Set<LookupsListener>();
  private readonly volume: PipelineVolumeModel;

  constructor(volume: PipelineVolumeModel) {
    this.volume = volume;
  }

  update(item: PipelineItem, stage: PipelineStage | null, reason?: FrameReason): void {
    const room = this.state(item.roomId);
    if (stage === null) room.entries.delete(item.dedupeKey);
    else {
      room.stalled.delete(item.candidateId);
      room.entries.set(item.dedupeKey, { item, stage, reason: this.safeReason(reason) });
    }
    this.schedule(item.roomId, room.quiet);
  }

  /** Remember deadline failures until that candidate is admitted again. */
  stall(item: PipelineItem): void {
    const room = this.state(item.roomId);
    room.stalled.add(item.candidateId);
    this.schedule(item.roomId, room.quiet);
  }

  changed(roomId: string): void {
    const room = this.state(roomId);
    this.schedule(roomId, room.quiet);
  }

  currentPipeline(roomId: string): PipelineMessage {
    const room = this.rooms.get(roomId);
    const stages = this.stageSnapshot(room);
    const reason = this.reasonFor(room);
    return {
      type: "pipeline",
      ...this.volume.snapshot(roomId),
      stalled: [...(room?.stalled ?? [])].sort(),
      stages: [...stages].map(([candidateId, stage]) => ({ candidateId, stage })),
      reset: true,
      ...(stages.size && reason ? { reason } : {}),
    };
  }

  currentLookups(roomId: string): LookupsMessage {
    const room = this.rooms.get(roomId);
    const stages = [...this.stageSnapshot(room)].map(
      ([candidateId, stage]) => ({ candidateId, stage }),
    );
    const reason = this.reasonFor(room);
    return {
      type: "lookups",
      pending: stages.map((entry) => entry.candidateId),
      stages,
      ...(stages.length && reason ? { reason } : {}),
    };
  }

  onPipeline(listener: PipelineListener): () => void {
    this.pipelineListeners.add(listener);
    return () => this.pipelineListeners.delete(listener);
  }

  onLookups(listener: LookupsListener): () => void {
    this.lookupsListeners.add(listener);
    return () => this.lookupsListeners.delete(listener);
  }

  reset(): void {
    for (const room of this.rooms.values()) if (room.timer) clearTimeout(room.timer);
    this.rooms.clear();
  }

  private state(roomId: string): FrameRoom {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { entries: new Map(), sentStages: new Map(), stalled: new Set(), quiet: true };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private schedule(roomId: string, immediate: boolean): void {
    const room = this.state(roomId);
    if (room.timer) return;
    if (immediate) this.emit(roomId, room);
    room.timer = setTimeout(() => {
      room.timer = undefined;
      this.emit(roomId, room);
    }, PIPELINE_COALESCE_MS);
    room.timer.unref?.();
  }

  private emit(roomId: string, room: FrameRoom): void {
    const stages = this.stageSnapshot(room);
    const changedIds = new Set([...room.sentStages.keys(), ...stages.keys()]);
    const delta = [...changedIds]
      .filter((candidateId) => room.sentStages.get(candidateId) !== stages.get(candidateId))
      .sort()
      .map((candidateId) => ({ candidateId, stage: stages.get(candidateId) ?? null }));
    room.sentStages = stages;
    const reason = this.reasonFor(room);
    const pipeline: PipelineMessage = {
      type: "pipeline",
      ...this.volume.snapshot(roomId),
      stalled: [...room.stalled].sort(),
      stages: delta,
      reset: false,
      ...(stages.size && reason ? { reason } : {}),
    };
    const lookups = this.currentLookups(roomId);
    const pipelineJson = JSON.stringify(pipeline);
    const lookupsJson = JSON.stringify(lookups);
    if (pipelineJson !== room.lastPipeline) {
      room.lastPipeline = pipelineJson;
      for (const listener of this.pipelineListeners) listener(roomId, pipeline);
    }
    if (lookupsJson !== room.lastLookups) {
      room.lastLookups = lookupsJson;
      for (const listener of this.lookupsListeners) listener(roomId, lookups);
    }
    room.quiet = lookups.pending.length === 0;
  }

  private safeReason(reason?: FrameReason): FrameReason | undefined {
    if (!reason) return undefined;
    if (reason.label && reason.visibility !== "shared") {
      return { kind: reason.kind, ...(reason.visibility ? { visibility: reason.visibility } : {}) };
    }
    return reason;
  }

  private stripVisibility(reason: FrameReason): NonNullable<LookupsMessage["reason"]> {
    return { kind: reason.kind, ...(reason.label ? { label: reason.label } : {}) };
  }

  private stageSnapshot(room?: FrameRoom): Map<string, PipelineStage> {
    const byCandidate = new Map<string, PipelineStage>();
    const rank: Record<PipelineStage, number> = { queued: 0, fetching: 1, processing: 2 };
    for (const entry of room?.entries.values() ?? []) {
      const existing = byCandidate.get(entry.item.candidateId);
      if (!existing || rank[entry.stage] > rank[existing]) {
        byCandidate.set(entry.item.candidateId, entry.stage);
      }
    }
    return new Map([...byCandidate].sort(([a], [b]) => a.localeCompare(b)));
  }

  private reasonFor(room?: FrameRoom): NonNullable<LookupsMessage["reason"]> | undefined {
    const reasons = [...(room?.entries.values() ?? [])]
      .map((entry) => entry.reason)
      .filter((reason): reason is FrameReason => reason !== undefined);
    const encodedReasons = new Set(reasons.map((reason) => JSON.stringify(reason)));
    return encodedReasons.size === 1 ? this.stripVisibility(reasons[0]) : undefined;
  }
}

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { SpatialContext } from "../../apps/web/src/spatial-types.ts";
import { SpatialStore } from "../../apps/web/src/spatial-store.ts";
import { hasRevisionGap, reconnectDelayMs } from "../../apps/web/src/ws-client.ts";
import {
  RoomBroadcastQueue,
  attachSocketErrorHandler,
} from "../../apps/server/src/ws.ts";
import { RevisionWatermarks } from "../../apps/web/src/revision-watermarks.ts";
import { serializeToolOutput } from "../../apps/server/src/nl/tool-output.ts";
import { PipelinePool } from "../../apps/server/src/pipeline/pools.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const contextAt = (revision: number) =>
  ({ ok: true, revision } as unknown as SpatialContext);

describe("projection refresh revision discipline", () => {
  it("does not advance WS catch-up when only HTTP command success is known", () => {
    const revisions = new RevisionWatermarks();
    revisions.reset(11, 11);
    revisions.observeRoom(12); // HTTP success, whose event frame is lost
    expect(revisions.knownRoomRevision).toBe(12);
    expect(revisions.projectedThroughRevision).toBe(11);

    // Welcome at the HTTP-known room head must therefore catch up from 11.
    const reconnectCatchUpFrom = revisions.projectedThroughRevision;
    expect(reconnectCatchUpFrom).toBe(11);
    revisions.consumeProjection(12);
    expect(revisions.projectedThroughRevision).toBe(12);
  });

  it("keeps a targeted refetch pending through an older in-flight response", async () => {
    const old = deferred<SpatialContext>();
    const fresh = deferred<SpatialContext>();
    let calls = 0;
    const store = new SpatialStore(() => (++calls === 1 ? old.promise : fresh.promise));

    const preCommand = store.refetch();
    const postCommand = store.refetch(2);
    let settled = false;
    void postCommand.then(() => (settled = true));

    old.resolve(contextAt(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(calls).toBe(2);

    fresh.resolve(contextAt(2));
    await Promise.all([preCommand, postCommand]);
    expect(settled).toBe(true);
    expect(store.state.context?.revision).toBe(2);
  });

  it("does not let an older sync overwrite newer outstanding decisions", () => {
    const store = new SpatialStore();
    const newer = [{ type: "stance_needed", proposalId: "prop_new" }] as const;
    const older = [{ type: "stance_needed", proposalId: "prop_old" }] as const;
    store.setOutstanding([...newer], 8);
    store.setOutstanding([...older], 7);
    expect(store.state.outstanding).toEqual(newer);
  });
});

describe("ordered realtime delivery", () => {
  it("does not defer fact commits through a dynamic engine import", () => {
    const source = readFileSync(
      new URL("../../apps/server/src/enrich/index.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain('await import("../engine.ts")');
  });

  it("serializes a second room delivery behind a delayed first delivery", async () => {
    const releaseFirst = deferred<void>();
    const started: number[] = [];
    const finished: number[] = [];
    const queue = new RoomBroadcastQueue<{ roomId: string; revision: number }>(
      async (item) => {
        started.push(item.revision);
        if (item.revision === 1) await releaseFirst.promise;
        finished.push(item.revision);
      },
    );

    const first = queue.enqueue({ roomId: "room_a", revision: 1 });
    const second = queue.enqueue({ roomId: "room_a", revision: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([1]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(finished).toEqual([1, 2]);
  });

  it("detects gaps and reordered frames from additive fromRevision", () => {
    expect(hasRevisionGap(4, 4)).toBe(false);
    expect(hasRevisionGap(4, 5)).toBe(true);
    expect(hasRevisionGap(4, 3)).toBe(true);
    expect(hasRevisionGap(4, undefined)).toBe(false);
  });
});

describe("bounded enrichment scheduling", () => {
  it("reserves a released pipeline slot for queued waiters", async () => {
    const pipelinePool = new PipelinePool("direct", 1);
    const release = deferred<void>();
    const order: string[] = [];
    const first = pipelinePool.submit(async () => {
      order.push("first");
      await release.promise;
    });
    const second = pipelinePool.submit(async () => {
      order.push("second");
    });
    const third = pipelinePool.submit(async () => {
      order.push("third");
    });
    expect(order).toEqual(["first"]);
    release.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
  });
});

describe("realtime reconnect backoff", () => {
  it("handles transport error events instead of throwing from EventEmitter", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const socket = new EventEmitter();
    attachSocketErrorHandler(socket);
    expect(() => socket.emit("error", new Error("transport reset"))).not.toThrow();
    expect(warning).toHaveBeenCalledWith("websocket transport error:", "transport reset");
    warning.mockRestore();
  });

  it("uses bounded jitter over an exponential delay", () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(500);
    expect(reconnectDelayMs(0, () => 1)).toBe(1000);
    expect(reconnectDelayMs(3, () => 1)).toBe(8000);
    expect(reconnectDelayMs(8, () => 0)).toBe(7500);
    expect(reconnectDelayMs(8, () => 1)).toBe(15000);
  });
});

describe("NL tool-result compaction", () => {
  it("stays valid JSON and reports structural omission within the byte budget", () => {
    const oversized = {
      ok: true,
      candidates: Array.from({ length: 80 }, (_, index) => ({
        candidateId: `place_${index}`,
        name: `Place ${index}`,
        description: "quoted \\\"provider text\\\" ".repeat(80),
        attributes: Array.from({ length: 20 }, (_unused, attribute) => ({
          key: `attribute-${attribute}`,
          status: "unknown",
        })),
      })),
    };
    const encoded = serializeToolOutput(oversized, 1200);
    const decoded = JSON.parse(encoded) as {
      truncated?: boolean;
      omitted?: { bytes?: number };
    };
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(1200);
    expect(decoded.truncated).toBe(true);
    expect(decoded.omitted?.bytes).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import type { SpatialContext } from "../../apps/web/src/spatial-types.ts";
import { SpatialStore } from "../../apps/web/src/spatial-store.ts";
import { hasRevisionGap } from "../../apps/web/src/ws-client.ts";
import { RoomBroadcastQueue } from "../../apps/server/src/ws.ts";
import { RevisionWatermarks } from "../../apps/web/src/revision-watermarks.ts";

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

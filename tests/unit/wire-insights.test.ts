import { describe, expect, it, vi } from "vitest";
import { RequestTrace } from "../../apps/server/src/wire-trace.ts";
import { currentWork, withWork, bindWork } from "../../apps/server/src/work-context.ts";
import { WireStore, WIRE_RING, parseServerTrace, type WireEvent } from "../../apps/web/src/wire-store.ts";
import { attention, elapsed, summarizeWire, wireRelations, wireExport } from "../../apps/web/src/wire-insights.ts";
import { readJson } from "../../apps/web/src/api.ts";

describe("bounded request traces", () => {
  it("preserves isolation across concurrent requests and a queued callback", async () => {
    const a = new RequestTrace(), b = new RequestTrace();
    await Promise.all([a, b].map((trace, i) => withWork({ trace }, async () => {
      await Promise.resolve();
      expect(currentWork().trace).toBe(trace);
      currentWork().trace!.begin("model", `model-${i}`)({ outcome: "ok", inputTokens: i + 1 });
    })));
    const queued = withWork({ trace: a }, () => bindWork(() => currentWork().trace));
    expect(withWork({ trace: b }, queued)).toBe(a);
    expect(a.finish().spans.map((s) => s.label)).toEqual(["model-0"]);
    expect(b.finish().spans.map((s) => s.label)).toEqual(["model-1"]);
  });
  it("caps headers and seals incomplete work at response time", () => {
    const trace = new RequestTrace();
    const finish = trace.begin("outbound", "accessibility");
    for (let i = 0; i < 25; i++) trace.begin("model", "a".repeat(200))({ inputTokens: Infinity, costUsd: NaN });
    const snapshot = trace.finish();
    expect(snapshot.spans).toHaveLength(16);
    expect(snapshot.omitted).toBe(10);
    finish({ outcome: "error" });
    trace.begin("model", "late")();
    expect(snapshot.spans[0].outcome).toBe("running");
    expect(JSON.stringify(snapshot).length).toBeLessThan(6000);
    expect(snapshot.spans[1]).not.toHaveProperty("inputTokens");
  });
  it("copies only valid bounded fields from an untrusted header", () => {
    expect(parseServerTrace("not json")).toBeUndefined();
    expect(parseServerTrace("x".repeat(8000))).toBeUndefined();
    expect(parseServerTrace('{"version":2,"spans":[]}')).toBeUndefined();
    const parsed = parseServerTrace(JSON.stringify({version:1,durationMs:30,omitted:0,spans:[
      {kind:"model",label:"fixture",offsetMs:1,outcome:"ok",durationMs:20,inputTokens:12,prompt:"private",body:"secret"},
      {kind:"invented",label:"bad",outcome:"ok"},
    ]}));
    expect(parsed?.spans).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toMatch(/private|secret/);
  });
});

describe("Wire recording and analysis", () => {
  it("keeps open work through rollover, reports dropped history and resets explicitly", () => {
    const store = new WireStore();
    const open = store.begin({lane:"http",label:"slow"});
    for (let i=0;i<WIRE_RING+2;i++) store.mark({lane:"page",label:`moment ${i}`});
    expect(store.state.events).toHaveLength(WIRE_RING);
    expect(store.state.events.some((e)=>e.id===open)).toBe(true);
    expect(store.state.dropped).toBe(3);
    store.clear();
    expect(store.state.events).toEqual([]);
    expect(store.state.dropped).toBe(0);
  });
  it("uses monotonic durations when the wall clock moves backwards", () => {
    const store = new WireStore();
    const clock = vi.spyOn(Date,"now").mockReturnValue(2000);
    try {
      const id = store.begin({lane:"http",label:"test"});
      clock.mockReturnValue(1000);
      store.end(id,{outcome:"ok"});
      expect(elapsed(store.state.events[0])).toBeGreaterThanOrEqual(0);
      expect(elapsed(store.state.events[0])).toBeLessThan(1000);
    } finally { clock.mockRestore(); }
  });
  it("bounds text and drops sensitive detail keys; exports omit free-form details", () => {
    const store = new WireStore();
    store.mark({lane:"page",label:"x".repeat(1000),detail:{prompt:"secret",confirmationNonce:"nonce",reason:"a".repeat(2000)}});
    expect(store.state.events[0].label).toHaveLength(256);
    expect(store.state.events[0].detail).toEqual({reason:"a".repeat(256)});
    expect(JSON.stringify(wireExport(store.state))).not.toContain("reason");
  });
  it("does not substitute a revision guess when an explicit request has left the recording", () => {
    const events: WireEvent[] = [
      {id:"http",lane:"http",label:"POST commands",at:0,endAt:4,outcome:"ok",revision:4,idempotencyKey:"operation"},
      {id:"ws",lane:"ws",label:"event",dir:"in",at:5,endAt:5,revision:4,correlationId:"evicted"},
    ];
    expect(wireRelations(events)).toEqual([]);
    delete events[1].correlationId;
    expect(wireRelations(events)[0].kind).toBe("revision");
  });
  it("does not double-count tool result bytes as HTTP payloads", () => {
    const events: WireEvent[] = [
      {id:"a",lane:"http",label:"POST x",at:0,endAt:100,bytes:120,status:200,outcome:"ok"},
      {id:"b",lane:"tool",label:"x",at:0,endAt:200,bytes:120,outcome:"ok"},
      {id:"c",lane:"http",label:"GET x",at:300,endAt:400,bytes:42,status:502,outcome:"error"},
    ];
    expect(summarizeWire(events,500)).toMatchObject({httpBytes:162,p95:100,attention:1,running:0});
    expect(attention(events[2])).toBe(true);
  });
  it("retains status and timing when response decoding fails", async () => {
    const {wire} = await import("../../apps/web/src/wire-store.ts");
    const id = wire.begin({lane:"http",label:"bad gateway"});
    await expect(readJson(new Response("<html>private body</html>",{status:502,headers:{"x-server-ms":"3"}}),id)).rejects.toThrow();
    const event = wire.state.events.find((e)=>e.id===id)!;
    expect(event).toMatchObject({status:502,serverMs:3,failureKind:"decode",bytes:25});
    expect(JSON.stringify(event)).not.toContain("private body");
    wire.end(id,{outcome:"error"});
  });
  it("records invite decoding failures without retaining credentials", async () => {
    const {exchangeInvite, clearSession} = await import("../../apps/web/src/session.ts");
    const {wire} = await import("../../apps/web/src/wire-store.ts");
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("not JSON",{status:200}))
        .mockResolvedValueOnce(Response.json({roomId:"room",participantId:"person",displayName:"Tester",role:"member",participantToken:"do-not-record-this"})));
      expect(await exchangeInvite("private-invite")).toBeNull();
      expect(wire.state.events.at(-1)).toMatchObject({status:200,outcome:"error",failureKind:"decode",note:"invalid JSON"});
      expect(await exchangeInvite("private-invite")).toMatchObject({roomId:"room"});
      expect(wire.state.events.at(-1)).toMatchObject({status:200,outcome:"ok",bytes:expect.any(Number)});
      expect(JSON.stringify(wire.state)).not.toMatch(/do-not-record-this|private-invite/);
    } finally { clearSession(); vi.unstubAllGlobals(); }
  });
});

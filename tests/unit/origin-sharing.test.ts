import { describe, expect, it } from "vitest";
import {
  positionDistanceMetres,
  shouldSendSharedPosition,
} from "../../apps/web/src/origin-sharing.ts";

describe("live origin sharing throttle", () => {
  const start = { lat: 52.52, lng: 13.4, sentAt: 1_000 };
  const twentyMetresNorth = { lat: 52.52018, lng: 13.4 };

  it("requires five seconds even after enough movement", () => {
    expect(positionDistanceMetres(start, twentyMetresNorth)).toBeGreaterThan(15);
    expect(shouldSendSharedPosition(start, twentyMetresNorth, 5_999)).toBe(false);
    expect(shouldSendSharedPosition(start, twentyMetresNorth, 6_000)).toBe(true);
  });

  it("requires fifteen metres even after enough time", () => {
    const fourteenMetresNorth = { lat: 52.520125, lng: 13.4 };
    expect(positionDistanceMetres(start, fourteenMetresNorth)).toBeLessThan(15);
    expect(shouldSendSharedPosition(start, fourteenMetresNorth, 7_000)).toBe(false);
  });

  it("allows the first sample when there is no durable baseline", () => {
    expect(shouldSendSharedPosition(null, twentyMetresNorth, 0)).toBe(true);
  });
});

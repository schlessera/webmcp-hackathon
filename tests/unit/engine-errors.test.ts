import { describe, expect, it, vi } from "vitest";

const transactionFailure = vi.hoisted(() =>
  vi.fn(async () => { throw new Error("injected database failure"); }),
);

vi.mock("../../apps/server/src/db.ts", () => ({
  pool: { query: vi.fn() },
  withTransaction: transactionFailure,
}));

import { submitCommand } from "../../apps/server/src/engine.ts";

describe("unexpected command failures", () => {
  it("returns the shared retryable envelope instead of rejecting", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await submitCommand(
      {
        id: "p_test",
        roomId: "room_test",
        displayName: "Test",
        role: "member",
      },
      "SetReadyState",
      { baseRevision: 0, state: "ready" },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "temporarily_unavailable",
        message: "The command could not be completed.",
        recovery: "Sync the room to check the outcome before deciding whether to try again.",
      },
    });
    expect(logged).toHaveBeenCalledWith("command engine failed:", expect.any(Error));
    logged.mockRestore();
  });
});

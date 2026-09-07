import { describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns";
import { isPublicAddress, publicLookup } from "../../apps/server/src/net/outbound.ts";

vi.mock("node:dns", () => ({ lookup: vi.fn() }));

describe("socket-time DNS validation", () => {
  it("rejects a rebinding response at connection time, regardless of earlier validation", async () => {
    vi.mocked(lookup).mockImplementation(((_host: unknown, _options: unknown, callback: Function) => {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    }) as typeof lookup);
    const result = await new Promise((resolve) => publicLookup("previously-public.example", {}, (error, address) => resolve({ error, address })));
    expect(result).toMatchObject({ error: expect.any(Error), address: [] });
  });
  it("passes only validated addresses to the socket, including all-address lookup mode", async () => {
    const addresses = [{ address: "93.184.216.34", family: 4 }];
    vi.mocked(lookup).mockImplementation(((_host: unknown, _options: unknown, callback: Function) => callback(null, addresses)) as typeof lookup);
    await new Promise<void>((resolve) => publicLookup("example.org", { all: true }, (error, resolved) => {
      expect(error).toBeNull(); expect(resolved).toEqual(addresses); resolve();
    }));
  });
  it("rejects internal, mapped and transition addresses", () => {
    for (const address of ["::1", "fc00::1", "fe80::1", "64:ff9b::a00:1", "2002:7f00:1::", "::ffff:127.0.0.1", "::ffff:7f00:1", "169.254.169.254"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_TTL_MS,
  consumeConfirmation,
  mintConfirmation,
  reissueConfirmation,
} from "../../apps/server/src/confirmation.ts";

/**
 * Lane 1: the confirmation nonce that backs the applying commands
 * (INTERACTION-AND-BINDING.md §5.4). Time is injected so the TTL is asserted
 * rather than waited out.
 */

const ROOM = "room_x";
const ME = "p_me";
const SUBJECT = { kind: "agreement", subjectId: "prop_1" } as const;

describe("confirmation nonces", () => {
  it("verifies a freshly minted nonce for its own subject", () => {
    const grant = mintConfirmation(ROOM, ME, SUBJECT);
    expect(grant.expiresInMs).toBe(CONFIRMATION_TTL_MS);
    expect(grant.nonce).toMatch(/^[0-9a-f]{48}$/);
    expect(consumeConfirmation(ROOM, ME, SUBJECT, grant.nonce)).toBe(true);
  });

  it("is single-use: a second presentation of the same nonce fails", () => {
    const { nonce } = mintConfirmation(ROOM, ME, SUBJECT);
    expect(consumeConfirmation(ROOM, ME, SUBJECT, nonce)).toBe(true);
    expect(consumeConfirmation(ROOM, ME, SUBJECT, nonce)).toBe(false);
  });

  it("expires after the TTL", () => {
    const now = 1_000_000;
    const { nonce } = mintConfirmation(ROOM, ME, SUBJECT, now);
    expect(
      consumeConfirmation(ROOM, ME, SUBJECT, nonce, now + CONFIRMATION_TTL_MS - 1),
    ).toBe(true);

    const later = mintConfirmation(ROOM, ME, SUBJECT, now);
    expect(
      consumeConfirmation(ROOM, ME, SUBJECT, later.nonce, now + CONFIRMATION_TTL_MS),
    ).toBe(false);
  });

  it("is bound to room, participant, kind, and subject", () => {
    const cases: Array<[string, () => boolean]> = [
      ["another room", () => {
        const { nonce } = mintConfirmation(ROOM, ME, SUBJECT);
        return consumeConfirmation("room_other", ME, SUBJECT, nonce);
      }],
      ["another participant", () => {
        const { nonce } = mintConfirmation(ROOM, ME, SUBJECT);
        return consumeConfirmation(ROOM, "p_other", SUBJECT, nonce);
      }],
      ["another kind", () => {
        const { nonce } = mintConfirmation(ROOM, ME, SUBJECT);
        return consumeConfirmation(
          ROOM, ME, { kind: "private_request", subjectId: SUBJECT.subjectId }, nonce,
        );
      }],
      ["another subject", () => {
        const { nonce } = mintConfirmation(ROOM, ME, SUBJECT);
        return consumeConfirmation(
          ROOM, ME, { kind: "agreement", subjectId: "prop_2" }, nonce,
        );
      }],
    ];
    for (const [label, attempt] of cases) {
      expect(attempt(), `nonce accepted for ${label}`).toBe(false);
    }
  });

  it("spends a mismatched nonce, so one value cannot be tried against several subjects", () => {
    const { nonce } = mintConfirmation(ROOM, ME, SUBJECT);
    expect(
      consumeConfirmation(ROOM, ME, { kind: "agreement", subjectId: "prop_2" }, nonce),
    ).toBe(false);
    expect(consumeConfirmation(ROOM, ME, SUBJECT, nonce)).toBe(false);
  });

  it("rejects absent, empty, and unminted values", () => {
    for (const value of [undefined, null, "", "not-a-nonce", 42]) {
      expect(consumeConfirmation(ROOM, ME, SUBJECT, value)).toBe(false);
    }
  });

  it("mints unique nonces", () => {
    const nonces = new Set(
      Array.from({ length: 50 }, () => mintConfirmation(ROOM, ME, SUBJECT).nonce),
    );
    expect(nonces.size).toBe(50);
  });

  it("restaging one subject invalidates its earlier nonce", () => {
    const first = mintConfirmation(ROOM, ME, SUBJECT);
    const second = mintConfirmation(ROOM, ME, SUBJECT);
    expect(consumeConfirmation(ROOM, ME, SUBJECT, first.nonce)).toBe(false);
    expect(consumeConfirmation(ROOM, ME, SUBJECT, second.nonce)).toBe(true);
  });

  it("reissues the same live nonce when another tab authenticates", () => {
    const now = 2_000_000;
    const first = mintConfirmation(ROOM, ME, SUBJECT, now);
    const secondTab = reissueConfirmation(ROOM, ME, SUBJECT, now + 100);
    expect(secondTab.nonce).toBe(first.nonce);
    expect(secondTab.expiresInMs).toBe(CONFIRMATION_TTL_MS - 100);
    expect(consumeConfirmation(ROOM, ME, SUBJECT, first.nonce, now + 200)).toBe(true);
  });
});

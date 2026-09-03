import { describe, expect, it } from "vitest";
import {
  LOOKUP_HINT_MS,
  lookupHintHolds,
  panelLookingUp,
  panelWorking,
} from "../../apps/web/src/ui/panel-work.ts";

const READ_AT = 1_000_000;

describe("the place panel's busy face", () => {
  it("keeps the dossier's pending flag while a lookups frame could still be in flight", () => {
    expect(lookupHintHolds({
      lookupPending: true,
      readAt: READ_AT,
      now: READ_AT + 200,
    })).toBe(true);
  });

  it("lets the pending flag lapse, so a lookup that ends after the last read settles", () => {
    // The regression: after an open's terminal frame nothing re-reads the
    // dossier, so a `lookupPending: true` caught by that last read used to
    // hold the panel busy for as long as the panel stayed open.
    expect(lookupHintHolds({
      lookupPending: true,
      readAt: READ_AT,
      now: READ_AT + LOOKUP_HINT_MS,
    })).toBe(false);
    expect(panelLookingUp({
      busy: false,
      lookupPending: true,
      readAt: READ_AT,
      now: READ_AT + 45_000,
    })).toBe(false);
    expect(panelWorking({
      lookingUp: false,
      openStage: null,
      lookupAsked: false,
      hasDossier: true,
    })).toBe(false);
  });

  it("stays busy on the live set however old the read is", () => {
    expect(panelLookingUp({
      busy: true,
      lookupPending: false,
      readAt: READ_AT,
      now: READ_AT + 45_000,
    })).toBe(true);
  });

  it("ignores a pending flag from a dossier that never arrived", () => {
    expect(lookupHintHolds({ lookupPending: true, readAt: null, now: READ_AT })).toBe(false);
    expect(lookupHintHolds({ lookupPending: false, readAt: READ_AT, now: READ_AT })).toBe(false);
  });

  it("is working before the first dossier, while a step is running, and while a read is asked", () => {
    expect(panelWorking({
      lookingUp: false, openStage: null, lookupAsked: false, hasDossier: false,
    })).toBe(true);
    expect(panelWorking({
      lookingUp: false, openStage: "site", lookupAsked: false, hasDossier: true,
    })).toBe(true);
    expect(panelWorking({
      lookingUp: false, openStage: null, lookupAsked: true, hasDossier: true,
    })).toBe(true);
  });
});

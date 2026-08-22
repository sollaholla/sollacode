import { describe, expect, it } from "vite-plus/test";

import {
  decideReconnect,
  isConnectionLostState,
  isConnectionUnstableState,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAYS_MS,
} from "./reconnect";

describe("decideReconnect", () => {
  it("retries a first drop almost immediately", () => {
    // Most drops are an access-point handover and are over inside a second;
    // reconnecting inside that window means the user barely notices.
    expect(decideReconnect({ attemptsMade: 0, wanted: true })).toEqual({
      kind: "retry",
      delayMs: RECONNECT_DELAYS_MS[0],
      attempt: 1,
    });
  });

  it("backs off across successive attempts", () => {
    const delays = [0, 1, 2, 3].map((attemptsMade) => {
      const decision = decideReconnect({ attemptsMade, wanted: true });
      return decision.kind === "retry" ? decision.delayMs : -1;
    });
    expect(delays).toEqual([...RECONNECT_DELAYS_MS]);
    // Strictly increasing, so a real outage is not hammered.
    expect([...delays].sort((left, right) => left - right)).toEqual(delays);
  });

  it("gives up rather than holding a microphone open against a dead network", () => {
    expect(decideReconnect({ attemptsMade: MAX_RECONNECT_ATTEMPTS, wanted: true })).toEqual({
      kind: "give-up",
      reason: "attempts-exhausted",
    });
  });

  it("never reconnects a session the user stopped", () => {
    expect(decideReconnect({ attemptsMade: 0, wanted: false })).toEqual({
      kind: "give-up",
      reason: "stopped-by-user",
    });
  });
});

describe("isConnectionLostState", () => {
  it("treats only the terminal states as lost", () => {
    expect(isConnectionLostState("failed")).toBe(true);
    expect(isConnectionLostState("closed")).toBe(true);
  });

  it("does not treat a disconnect as death", () => {
    // This used to return true, and it broke starting a session outright: ICE
    // reports `disconnected` whenever connectivity checks lapse, which on a
    // phone happens routinely on a connection that is about to succeed.
    expect(isConnectionLostState("disconnected")).toBe(false);
    expect(isConnectionUnstableState("disconnected")).toBe(true);
  });

  it("leaves healthy states alone", () => {
    for (const state of ["connected", "connecting", "new"]) {
      expect(isConnectionLostState(state), state).toBe(false);
      expect(isConnectionUnstableState(state), state).toBe(false);
    }
  });
});

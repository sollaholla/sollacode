import { describe, expect, it } from "vite-plus/test";

import { resolveUserInputDeferral } from "./Manager.ts";

/**
 * The regression this exists for: an agent click or keystroke landing while the
 * user was mid-sentence moved their caret out of the chat composer and into a
 * web page — their words went to the site, and the agent's text arrived in
 * their message box. Automation now queues behind the user instead of
 * competing with them, and never gives up and takes the caret anyway.
 */
describe("resolveUserInputDeferral", () => {
  const nowMs = 1_000_000;

  it("proceeds when the user has never typed", () => {
    expect(resolveUserInputDeferral({ lastUserInputAtMs: 0, nowMs })).toBe("proceed");
  });

  it("waits while the user is still typing", () => {
    expect(resolveUserInputDeferral({ lastUserInputAtMs: nowMs - 100, nowMs })).toBe("wait");
  });

  it("keeps waiting for as long as the user keeps typing", () => {
    // Someone leaning on a key holds the caret indefinitely, and that is the
    // point: the user wins outright rather than being pre-empted by a timeout.
    expect(resolveUserInputDeferral({ lastUserInputAtMs: nowMs, nowMs: nowMs + 30_000 })).toBe(
      "proceed",
    );
    expect(
      resolveUserInputDeferral({ lastUserInputAtMs: nowMs + 30_000, nowMs: nowMs + 30_000 }),
    ).toBe("wait");
  });

  it("proceeds once the user has gone idle for the full cooldown", () => {
    expect(resolveUserInputDeferral({ lastUserInputAtMs: nowMs, nowMs: nowMs + 1_999 })).toBe(
      "wait",
    );
    expect(resolveUserInputDeferral({ lastUserInputAtMs: nowMs, nowMs: nowMs + 2_000 })).toBe(
      "proceed",
    );
  });
});

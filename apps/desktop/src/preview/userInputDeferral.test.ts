import { describe, expect, it } from "vite-plus/test";

import {
  isDeliberateUserInputEvent,
  resolveUserInputDeferral,
  shouldReclaimGuestKeyForApp,
} from "./Manager.ts";

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

  it("never takes focus while push-to-talk is physically held", () => {
    for (const heldForMs of [2_000, 10_000, 120_000]) {
      expect(
        resolveUserInputDeferral({
          lastUserInputAtMs: nowMs,
          nowMs: nowMs + heldForMs,
          pushToTalkActive: true,
          waitingSinceMs: nowMs,
        }),
      ).toBe("wait");
    }
  });

  it("waits the full cooldown after a long push-to-talk hold is released", () => {
    const releasedAtMs = nowMs + 120_000;
    expect(
      resolveUserInputDeferral({
        lastUserInputAtMs: releasedAtMs,
        nowMs: releasedAtMs + 1_999,
        waitingSinceMs: releasedAtMs,
      }),
    ).toBe("wait");
    expect(
      resolveUserInputDeferral({
        lastUserInputAtMs: releasedAtMs,
        nowMs: releasedAtMs + 2_000,
        waitingSinceMs: releasedAtMs,
      }),
    ).toBe("proceed");
  });

  it("delivers the action late rather than losing it when typing never stops", () => {
    // The MCP preview tools give up at 15s, so an unbounded wait did not queue
    // the action, it discarded it — the reported "dead click". Ten seconds of
    // continuous typing yields, and the action still runs.
    const waitingSinceMs = nowMs;
    expect(
      resolveUserInputDeferral({
        lastUserInputAtMs: nowMs + 9_000,
        nowMs: nowMs + 9_000,
        waitingSinceMs,
      }),
    ).toBe("wait");
    expect(
      resolveUserInputDeferral({
        lastUserInputAtMs: nowMs + 10_000,
        nowMs: nowMs + 10_000,
        waitingSinceMs,
      }),
    ).toBe("proceed");
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

/**
 * The keyboard half of the gate is blind to the mouse. Clicking into the
 * composer and pausing to think left automation free to take the caret from
 * someone who had just placed it, which is how input kept getting stolen even
 * with the cooldown in place.
 */
describe("isDeliberateUserInputEvent", () => {
  it("counts presses, scrolls and taps as the user working", () => {
    for (const type of [
      "mouseDown",
      "mouseUp",
      "mouseWheel",
      "contextMenu",
      "touchStart",
      "pointerDown",
      "gestureTap",
    ]) {
      expect(isDeliberateUserInputEvent(type)).toBe(true);
    }
  });

  it("ignores mere pointer movement, which would starve every agent", () => {
    // A pointer resting over the window emits these continuously; treating
    // them as activity would hold the cooldown open forever.
    for (const type of [
      "mouseMove",
      "mouseEnter",
      "mouseLeave",
      "pointerMove",
      "pointerRawUpdate",
      undefined,
    ]) {
      expect(isDeliberateUserInputEvent(type)).toBe(false);
    }
  });

  it("leaves keyboard events to the before-input-event path", () => {
    for (const type of ["keyDown", "keyUp", "char", "rawKeyDown"]) {
      expect(isDeliberateUserInputEvent(type)).toBe(false);
    }
  });
});

/**
 * An agent click leaves the caret in a web page. The user, who last clicked in
 * the composer, keeps typing — and their words went to the site. The last
 * deliberate click decides who owns the keyboard.
 */
describe("shouldReclaimGuestKeyForApp", () => {
  const base = {
    focusIntent: "app" as const,
    automationInFlight: false,
    inputType: "keyDown",
    key: "a",
  };

  it("hands the key back when the user's focus belongs to the app", () => {
    expect(shouldReclaimGuestKeyForApp(base)).toBe(true);
  });

  it("leaves the user alone in a page they clicked into themselves", () => {
    expect(shouldReclaimGuestKeyForApp({ ...base, focusIntent: "guest" })).toBe(false);
  });

  it("never redirects an agent's own keystrokes into the user's chat", () => {
    // The interlock for the original bug: agent text appearing in the composer.
    expect(shouldReclaimGuestKeyForApp({ ...base, automationInFlight: true })).toBe(false);
  });

  it("acts on the key-down only, so the page keeps a matching key-up", () => {
    expect(shouldReclaimGuestKeyForApp({ ...base, inputType: "keyUp" })).toBe(false);
  });

  it("ignores a bare modifier tap, which states no intent to type", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      expect(shouldReclaimGuestKeyForApp({ ...base, key })).toBe(false);
    }
  });
});

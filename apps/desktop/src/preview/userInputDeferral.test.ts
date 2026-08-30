import { describe, expect, it } from "vite-plus/test";

import {
  isDeliberateUserInputEvent,
  resolveUserInputDeferral,
  shouldReclaimGuestKeyForApp,
  USER_INPUT_DEFERRAL_MS,
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
        }),
      ).toBe("wait");
    }
  });

  it("waits the full cooldown after a long push-to-talk hold is released", () => {
    const releasedAtMs = nowMs + 120_000;
    expect(
      resolveUserInputDeferral({
        lastUserInputAtMs: releasedAtMs,
        nowMs: releasedAtMs + USER_INPUT_DEFERRAL_MS - 1,
      }),
    ).toBe("wait");
    expect(
      resolveUserInputDeferral({
        lastUserInputAtMs: releasedAtMs,
        nowMs: releasedAtMs + USER_INPUT_DEFERRAL_MS,
      }),
    ).toBe("proceed");
  });

  it("keeps waiting for as long as the user keeps typing", () => {
    // Even after the old ten-second escape hatch, a fresh keystroke keeps the
    // user's caret. The action resumes only after a full idle cooldown.
    for (const elapsedMs of [10_000, 30_000, 120_000]) {
      expect(
        resolveUserInputDeferral({
          lastUserInputAtMs: nowMs + elapsedMs,
          nowMs: nowMs + elapsedMs,
        }),
      ).toBe("wait");
    }
  });

  it("proceeds once the user has gone idle for the full cooldown", () => {
    expect(
      resolveUserInputDeferral({
        lastUserInputAtMs: nowMs,
        nowMs: nowMs + USER_INPUT_DEFERRAL_MS - 1,
      }),
    ).toBe("wait");
    expect(
      resolveUserInputDeferral({
        lastUserInputAtMs: nowMs,
        nowMs: nowMs + USER_INPUT_DEFERRAL_MS,
      }),
    ).toBe("proceed");
  });
});

/**
 * The keyboard half of the gate is blind to the mouse. Clicking into the
 * composer and pausing to think left automation free to take the caret from
 * someone who had just placed it, which is how input kept getting stolen even
 * with the cooldown in place.
 */
describe("isDeliberateUserInputEvent", () => {
  it("counts physical presses and taps as the user working", () => {
    for (const type of ["mouseDown", "contextMenu", "touchStart", "pointerDown", "gestureTap"]) {
      expect(isDeliberateUserInputEvent(type)).toBe(true);
    }
  });

  it("ignores movement, release and scroll packets, which would starve every agent", () => {
    // A pointer resting over the window emits these continuously; treating
    // them as activity would hold the cooldown open forever.
    for (const type of [
      "mouseMove",
      "mouseEnter",
      "mouseLeave",
      "pointerMove",
      "pointerRawUpdate",
      "mouseUp",
      "pointerUp",
      "touchEnd",
      "mouseWheel",
      "gestureScrollBegin",
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
    focusIntent: { kind: "app" } as const,
    currentTabId: "preview-b",
    expectedAgentInput: false,
    inputType: "keyDown",
    key: "a",
  };

  it("hands the key back when the user's focus belongs to the app", () => {
    expect(shouldReclaimGuestKeyForApp(base)).toBe(true);
  });

  it("leaves the user alone in a page they clicked into themselves", () => {
    expect(
      shouldReclaimGuestKeyForApp({
        ...base,
        focusIntent: { kind: "guest", tabId: "preview-b" },
      }),
    ).toBe(false);
  });

  it("returns a key that lands in a different Preview tab than the one the user clicked", () => {
    expect(
      shouldReclaimGuestKeyForApp({
        ...base,
        focusIntent: { kind: "guest", tabId: "preview-a" },
      }),
    ).toBe(true);
  });

  it("never redirects the exact agent key packet into the user's chat", () => {
    expect(shouldReclaimGuestKeyForApp({ ...base, expectedAgentInput: true })).toBe(false);
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

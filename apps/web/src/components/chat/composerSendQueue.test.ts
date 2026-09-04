import { describe, expect, it } from "vite-plus/test";

import {
  holdComposerSend,
  releaseComposerSendHold,
  shouldHoldComposerSend,
  shouldReleaseHeldComposerSend,
} from "./composerSendQueue";

describe("composer send hold", () => {
  it("holds a send that would stop running background tasks", () => {
    expect(
      shouldHoldComposerSend({
        backgroundTasksRunning: true,
        hasSendableContent: true,
        sendNow: false,
      }),
    ).toBe(true);
  });

  it("sends straight through when no background work is at risk", () => {
    expect(
      shouldHoldComposerSend({
        backgroundTasksRunning: false,
        hasSendableContent: true,
        sendNow: false,
      }),
    ).toBe(false);
  });

  it("honours send-anyway", () => {
    // The override behind the warned control: the user has accepted the cost.
    expect(
      shouldHoldComposerSend({
        backgroundTasksRunning: true,
        hasSendableContent: true,
        sendNow: true,
      }),
    ).toBe(false);
  });

  it("never holds an empty composer", () => {
    // An empty send is not a follow-up; holding one would show "waiting to
    // send" over a message that does not exist, and the same press also drives
    // unrelated composer actions.
    expect(
      shouldHoldComposerSend({
        backgroundTasksRunning: true,
        hasSendableContent: false,
        sendNow: false,
      }),
    ).toBe(false);
  });

  it("releases once the background tasks finish", () => {
    expect(
      shouldReleaseHeldComposerSend({
        heldThreadKeys: new Set(["env:thread"]),
        activeThreadKey: "env:thread",
        backgroundTasksRunning: false,
      }),
    ).toBe(true);
  });

  it("keeps holding while the tasks are still running", () => {
    expect(
      shouldReleaseHeldComposerSend({
        heldThreadKeys: new Set(["env:thread"]),
        activeThreadKey: "env:thread",
        backgroundTasksRunning: true,
      }),
    ).toBe(false);
  });

  it("never releases one thread's hold into another thread", () => {
    // The held draft belongs to the thread it was typed in. Reading the
    // on-screen thread's task state and sending anyway would post a follow-up
    // into whatever conversation the user navigated to.
    expect(
      shouldReleaseHeldComposerSend({
        heldThreadKeys: new Set(["env:other"]),
        activeThreadKey: "env:thread",
        backgroundTasksRunning: false,
      }),
    ).toBe(false);
  });

  it("releases nothing when no thread is active", () => {
    expect(
      shouldReleaseHeldComposerSend({
        heldThreadKeys: new Set(["env:thread"]),
        activeThreadKey: null,
        backgroundTasksRunning: false,
      }),
    ).toBe(false);
  });

  it("holds each thread independently", () => {
    const held = holdComposerSend(holdComposerSend(new Set<string>(), "a"), "b");
    expect([...held].sort()).toEqual(["a", "b"]);
    expect([...releaseComposerSendHold(held, "a")]).toEqual(["b"]);
  });

  it("returns the same set when nothing changes", () => {
    // The release effect watches this set; a fresh set on every render would
    // re-run it continuously.
    const held = holdComposerSend(new Set<string>(), "a");
    expect(holdComposerSend(held, "a")).toBe(held);
    expect(releaseComposerSendHold(held, "b")).toBe(held);
  });
});

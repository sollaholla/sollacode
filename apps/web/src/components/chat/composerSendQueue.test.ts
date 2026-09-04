import { describe, expect, it } from "vite-plus/test";

import {
  holdComposerSend,
  releaseComposerSendHold,
  sendWouldStopBackgroundWork,
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

describe("sendWouldStopBackgroundWork", () => {
  it("is destructive only while a turn is running over background tasks", () => {
    expect(
      sendWouldStopBackgroundWork({
        hasRunningBackgroundTask: true,
        turnRunning: true,
        providerDriver: "claudeAgent",
      }),
    ).toBe(true);
  });

  it("destroys nothing on an idle thread", () => {
    // A backgrounded task outliving its turn is the point of backgrounding it,
    // and there is no turn to interrupt. Treating tasks alone as destructive
    // stopped work every send had no reason to touch, and let a task whose
    // completion never arrived hold messages until the panel aged it out.
    expect(
      sendWouldStopBackgroundWork({
        hasRunningBackgroundTask: true,
        turnRunning: false,
        providerDriver: "claudeAgent",
      }),
    ).toBe(false);
  });

  it("destroys nothing when no background task is running", () => {
    expect(
      sendWouldStopBackgroundWork({
        hasRunningBackgroundTask: false,
        turnRunning: true,
        providerDriver: "claudeAgent",
      }),
    ).toBe(false);
  });

  it("exempts a running Grok session", () => {
    // Grok queues the message itself and keeps its tasks.
    expect(
      sendWouldStopBackgroundWork({
        hasRunningBackgroundTask: true,
        turnRunning: true,
        providerDriver: "grok",
      }),
    ).toBe(false);
  });

  it("treats an unknown driver as destructive", () => {
    // The exemption is a claim about a specific runtime; anything unrecognised
    // gets the warning rather than a silent assumption it survives.
    expect(
      sendWouldStopBackgroundWork({
        hasRunningBackgroundTask: true,
        turnRunning: true,
        providerDriver: null,
      }),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { sendWouldStopBackgroundWork, shouldHoldComposerSend } from "./composerSendQueue";

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
});

describe("sendWouldStopBackgroundWork", () => {
  it("is destructive only while a turn is running over background tasks", () => {
    // Antigravity's headless transport refuses a live steer, so the send has
    // to interrupt the turn -- and take its tasks with it.
    expect(
      sendWouldStopBackgroundWork({
        hasRunningBackgroundTask: true,
        turnRunning: true,
        providerDriver: "antigravity",
      }),
    ).toBe(true);
  });

  it("destroys nothing for a provider that steers the live turn", () => {
    // The message joins the running turn instead of interrupting it, so every
    // background task under that turn survives. Naming only Grok here offered
    // to kill tasks on every Claude, Codex, Cursor and OpenCode send.
    for (const providerDriver of ["claudeAgent", "codex", "cursor", "grok", "opencode"]) {
      expect(
        sendWouldStopBackgroundWork({
          hasRunningBackgroundTask: true,
          turnRunning: true,
          providerDriver,
        }),
      ).toBe(false);
    }
  });

  it("treats an unrecognised driver as unable to steer", () => {
    // Fail closed: a driver this build does not ship must never silently lose
    // someone's background work.
    expect(
      sendWouldStopBackgroundWork({
        hasRunningBackgroundTask: true,
        turnRunning: true,
        providerDriver: "nimbus-quill",
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

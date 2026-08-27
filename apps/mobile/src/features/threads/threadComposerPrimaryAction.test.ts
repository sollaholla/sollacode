import { describe, expect, it } from "@effect/vitest";

import { resolveThreadComposerPrimaryAction } from "./threadComposerPrimaryAction";

describe("mobile thread composer primary action", () => {
  it("replaces Stop with a second-submit action when Grok has queued messages", () => {
    expect(
      resolveThreadComposerPrimaryAction({
        activeThreadBusy: true,
        connectionConnected: true,
        hasContent: false,
        hasQueuedSendNow: true,
        queueCount: 3,
      }),
    ).toEqual({
      canSend: true,
      sendLabel: "Send all queued messages now",
      showStopAction: false,
    });
  });

  it("keeps Stop for ordinary active work without a queued follow-up", () => {
    expect(
      resolveThreadComposerPrimaryAction({
        activeThreadBusy: true,
        connectionConnected: true,
        hasContent: false,
        hasQueuedSendNow: false,
        queueCount: 0,
      }),
    ).toEqual({ canSend: false, sendLabel: "Queue", showStopAction: true });
  });
});

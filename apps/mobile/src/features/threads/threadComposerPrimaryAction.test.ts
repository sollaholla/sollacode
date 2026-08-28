import { describe, expect, it } from "@effect/vitest";

import {
  resolveThreadComposerPrimaryAction,
  resolveThreadComposerSubmitAction,
} from "./threadComposerPrimaryAction";

describe("mobile thread composer primary action", () => {
  it("keeps Stop distinct from queued promotion and disables the empty send arrow", () => {
    expect(
      resolveThreadComposerPrimaryAction({
        activeThreadBusy: true,
        connectionConnected: true,
        hasContent: false,
        hasQueuedSendNow: true,
        isPromotingQueued: false,
        queueCount: 3,
      }),
    ).toEqual({
      canSend: false,
      canPromoteQueued: true,
      queuedPromotionLabel: "Send queued now",
      sendLabel: "Queue",
      showQueuedPromotionAction: true,
      showStopAction: true,
    });
  });

  it("keeps queued promotion disabled through the projection gap", () => {
    expect(
      resolveThreadComposerPrimaryAction({
        activeThreadBusy: true,
        connectionConnected: true,
        hasContent: false,
        hasQueuedSendNow: true,
        isPromotingQueued: true,
        queueCount: 2,
      }),
    ).toEqual({
      canSend: false,
      canPromoteQueued: false,
      queuedPromotionLabel: "Sending queued messages",
      sendLabel: "Queue",
      showQueuedPromotionAction: true,
      showStopAction: true,
    });
  });

  it("keeps Stop for ordinary active work without a queued follow-up", () => {
    expect(
      resolveThreadComposerPrimaryAction({
        activeThreadBusy: true,
        connectionConnected: true,
        hasContent: false,
        hasQueuedSendNow: false,
        isPromotingQueued: false,
        queueCount: 0,
      }),
    ).toEqual({
      canSend: false,
      canPromoteQueued: false,
      queuedPromotionLabel: "Send queued now",
      sendLabel: "Queue",
      showQueuedPromotionAction: false,
      showStopAction: true,
    });
  });

  it("promotes all queued messages when Enter submits an empty composer", () => {
    expect(resolveThreadComposerSubmitAction({ hasContent: false, hasQueuedSendNow: true })).toBe(
      "promote-queued",
    );
  });

  it("keeps a new draft distinct from queued promotion", () => {
    expect(resolveThreadComposerSubmitAction({ hasContent: true, hasQueuedSendNow: true })).toBe(
      "send-draft",
    );
  });

  it("does nothing when Enter submits an empty composer without queued work", () => {
    expect(resolveThreadComposerSubmitAction({ hasContent: false, hasQueuedSendNow: false })).toBe(
      null,
    );
  });
});

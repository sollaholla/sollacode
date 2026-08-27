import { describe, expect, it, vi } from "vite-plus/test";

import {
  beginWaitingOnYouFollowUp,
  beginWaitingOnYouFollowUpWhenReady,
  type AgentAttentionComposer,
  type WaitingOnYouFollowUpScheduler,
} from "./agentAttentionFollowUp";

function makeComposer(value: string) {
  const insertTextAtEnd = vi.fn(() => true);
  const focusAtEnd = vi.fn();
  const composer: AgentAttentionComposer = {
    readSnapshot: () => ({ value }),
    insertTextAtEnd,
    focusAtEnd,
  };
  return { composer, focusAtEnd, insertTextAtEnd };
}

describe("beginWaitingOnYouFollowUp", () => {
  it("references the blocker, preserves the draft boundary, and focuses the composer", () => {
    const harness = makeComposer("One detail is wrong");

    beginWaitingOnYouFollowUp(harness.composer, "Sign in to X for Grok");

    expect(harness.insertTextAtEnd).toHaveBeenCalledWith("Follow-up on “Sign in to X for Grok”: ", {
      ensureLeadingBoundary: true,
    });
    expect(harness.focusAtEnd).toHaveBeenCalledOnce();
  });

  it("does not duplicate a blocker reference already in the draft", () => {
    const harness = makeComposer("Follow-up on “Sign in to X for Grok”: use the other account");

    beginWaitingOnYouFollowUp(harness.composer, "Sign in to X for Grok");

    expect(harness.insertTextAtEnd).not.toHaveBeenCalled();
    expect(harness.focusAtEnd).toHaveBeenCalledOnce();
  });

  it("keeps the follow-up alive while a mobile composer remounts", () => {
    const harness = makeComposer("");
    const callbacks: Array<() => void> = [];
    const scheduler: WaitingOnYouFollowUpScheduler = {
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancel: vi.fn(),
    };
    let reads = 0;

    beginWaitingOnYouFollowUpWhenReady(
      () => (++reads < 3 ? null : harness.composer),
      "Sign in to X for Grok",
      { scheduler },
    );

    expect(harness.insertTextAtEnd).not.toHaveBeenCalled();
    callbacks.shift()?.();
    expect(harness.insertTextAtEnd).not.toHaveBeenCalled();
    callbacks.shift()?.();
    expect(harness.insertTextAtEnd).toHaveBeenCalledWith("Follow-up on “Sign in to X for Grok”: ", {
      ensureLeadingBoundary: true,
    });
    expect(harness.focusAtEnd).toHaveBeenCalledOnce();
  });

  it("stops retrying when the handoff is cancelled", () => {
    const callbacks: Array<() => void> = [];
    const cancel = vi.fn();
    const scheduler: WaitingOnYouFollowUpScheduler = {
      schedule: (callback) => {
        callbacks.push(callback);
        return 41;
      },
      cancel,
    };
    const readComposer = vi.fn(() => null);

    const stop = beginWaitingOnYouFollowUpWhenReady(readComposer, "Blocked", { scheduler });
    stop();
    callbacks.shift()?.();

    expect(cancel).toHaveBeenCalledWith(41);
    expect(readComposer).toHaveBeenCalledOnce();
  });
});

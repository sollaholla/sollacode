import { describe, expect, it, vi } from "vite-plus/test";

import {
  focusComposerWhenReady,
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

describe("focusComposerWhenReady", () => {
  it("focuses without typing on the user's behalf", () => {
    // What the follow-up is about is carried by the tag attached to the
    // composer, so nothing is written into their draft.
    const harness = makeComposer("One detail is wrong");

    focusComposerWhenReady(() => harness.composer);

    expect(harness.focusAtEnd).toHaveBeenCalledOnce();
    expect(harness.insertTextAtEnd).not.toHaveBeenCalled();
  });

  it("keeps the intent alive while a mobile composer remounts", () => {
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

    focusComposerWhenReady(() => (++reads < 3 ? null : harness.composer), { scheduler });

    expect(harness.focusAtEnd).not.toHaveBeenCalled();
    callbacks.shift()?.();
    expect(harness.focusAtEnd).not.toHaveBeenCalled();
    callbacks.shift()?.();
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

    const stop = focusComposerWhenReady(readComposer, { scheduler });
    stop();
    callbacks.shift()?.();

    expect(cancel).toHaveBeenCalledWith(41);
    expect(readComposer).toHaveBeenCalledOnce();
  });
});

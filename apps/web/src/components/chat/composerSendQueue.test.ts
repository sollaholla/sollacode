import { describe, expect, it } from "vite-plus/test";

import {
  releaseQueuedComposerMessages,
  removeQueuedComposerMessage,
  shouldQueueComposerSend,
} from "./composerSendQueue";

describe("composer send queue", () => {
  it("queues a send made while a turn is running", () => {
    expect(shouldQueueComposerSend({ turnRunning: true, sendNow: false })).toBe(true);
  });

  it("sends straight through when the thread is idle", () => {
    expect(shouldQueueComposerSend({ turnRunning: false, sendNow: false })).toBe(false);
  });

  it("honours send-anyway even mid-turn", () => {
    // The override behind the warned control: the user has accepted the cost.
    expect(shouldQueueComposerSend({ turnRunning: true, sendNow: true })).toBe(false);
  });

  it("releases nothing while the turn is still running", () => {
    expect(
      releaseQueuedComposerMessages({
        turnRunning: true,
        queued: [{ id: "a", text: "one" }],
      }),
    ).toEqual([]);
  });

  it("releases every queued message in order once idle", () => {
    // Several follow-ups can pile up during one long turn; draining one per
    // idle would leave the rest stranded behind the turn each one starts.
    const queued = [
      { id: "a", text: "one" },
      { id: "b", text: "two" },
      { id: "c", text: "three" },
    ];
    expect(releaseQueuedComposerMessages({ turnRunning: false, queued })).toEqual(queued);
  });

  it("drops a queued message the user removed", () => {
    expect(
      removeQueuedComposerMessage(
        [
          { id: "a", text: "one" },
          { id: "b", text: "two" },
        ],
        "a",
      ),
    ).toEqual([{ id: "b", text: "two" }]);
  });
});

import type { ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  runPreviewAutomationLifecycleMutation,
  runPreviewAutomationPostCloseRefresh,
} from "./previewAutomationLifecycleQueue";

const ref = (threadId: string): ScopedThreadRef => ({
  environmentId: "env-1" as ScopedThreadRef["environmentId"],
  threadId: threadId as ScopedThreadRef["threadId"],
});

describe("preview automation lifecycle queue", () => {
  it("serializes discovery and mutation for the same thread", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = runPreviewAutomationLifecycleMutation(ref("thread-1"), async () => {
      events.push("first:start");
      markFirstStarted();
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = runPreviewAutomationLifecycleMutation(ref("thread-1"), async () => {
      events.push("second:start");
      return 2;
    });

    await firstStarted;
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not block another thread and continues after a failed mutation", async () => {
    const events: string[] = [];
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const failed = runPreviewAutomationLifecycleMutation(ref("thread-a"), async () => {
      await failureGate;
      throw new Error("expected");
    });
    const other = runPreviewAutomationLifecycleMutation(ref("thread-b"), async () => {
      events.push("other");
    });
    const recovered = runPreviewAutomationLifecycleMutation(ref("thread-a"), async () => {
      events.push("recovered");
    });

    await other;
    expect(events).toEqual(["other"]);
    releaseFailure();
    await expect(failed).rejects.toThrow("expected");
    await recovered;
    expect(events).toEqual(["other", "recovered"]);
  });

  it("does not report an accepted close as failed when reconciliation drops", async () => {
    await expect(
      runPreviewAutomationPostCloseRefresh(async () => {
        throw new Error("connection dropped after close");
      }),
    ).resolves.toBeUndefined();
  });
});

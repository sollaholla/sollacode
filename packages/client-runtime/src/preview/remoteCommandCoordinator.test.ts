import { describe, expect, it } from "vite-plus/test";

import { RemotePreviewCommandCoordinator } from "./remoteCommandCoordinator.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RemotePreviewCommandCoordinator", () => {
  it("delivers inputs in gesture order even when the first relay is slow", async () => {
    const coordinator = new RemotePreviewCommandCoordinator();
    const first = deferred<string>();
    const firstStarted = deferred<void>();
    const order: string[] = [];
    const one = coordinator.queueInput(async () => {
      order.push("first-start");
      firstStarted.resolve();
      const value = await first.promise;
      order.push("first-end");
      return value;
    });
    const two = coordinator.queueInput(async () => {
      order.push("second");
      return "two";
    });

    await firstStarted.promise;
    expect(order).toEqual(["first-start"]);
    first.resolve("one");

    await expect(one).resolves.toEqual({ status: "current", value: "one" });
    await expect(two).resolves.toEqual({ status: "current", value: "two" });
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("allows only the newest capture to replace the visible frame", async () => {
    const coordinator = new RemotePreviewCommandCoordinator();
    const oldCapture = deferred<string>();
    const oldResult = coordinator.latestCapture(() => oldCapture.promise);
    const newResult = coordinator.latestCapture(async () => "new");

    await expect(newResult).resolves.toEqual({ status: "current", value: "new" });
    oldCapture.resolve("old");
    await expect(oldResult).resolves.toEqual({ status: "stale" });
  });

  it("invalidates old work and lets a new tab run without waiting for it", async () => {
    const coordinator = new RemotePreviewCommandCoordinator();
    const old = deferred<string>();
    const oldStarted = deferred<void>();
    const oldInput = coordinator.queueInput(async () => {
      oldStarted.resolve();
      return await old.promise;
    });
    const oldCapture = coordinator.latestCapture(() => old.promise);
    await oldStarted.promise;

    coordinator.reset();
    const newInput = coordinator.queueInput(async () => "new tab");
    await expect(newInput).resolves.toEqual({ status: "current", value: "new tab" });

    old.resolve("old tab");
    await expect(oldInput).resolves.toEqual({ status: "stale" });
    await expect(oldCapture).resolves.toEqual({ status: "stale" });
  });
});

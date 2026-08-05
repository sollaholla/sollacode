import { describe, expect, it } from "vite-plus/test";

import {
  createRemoteControlVideoPublishQueue,
  type RemoteControlVideoProducerPacer,
} from "./remoteControlVideoPublishQueue";

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function pacer() {
  let state = "recording";
  let pauses = 0;
  let resumes = 0;
  const value: RemoteControlVideoProducerPacer = {
    get state() {
      return state;
    },
    pause() {
      state = "paused";
      pauses += 1;
    },
    resume() {
      state = "recording";
      resumes += 1;
    },
  };
  return {
    value,
    counts: () => ({ pauses, resumes }),
  };
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createRemoteControlVideoPublishQueue", () => {
  it("publishes continuous-container chunks sequentially and paces the recorder", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: Array<string> = [];
    let activePublishes = 0;
    let peakPublishes = 0;
    const producer = pacer();
    const errors: Array<unknown> = [];
    const queue = createRemoteControlVideoPublishQueue<{ id: string; bytes: number }>({
      maxPendingBytes: 10,
      pauseAtBytes: 6,
      resumeAtBytes: 2,
      sizeOf: (item) => item.bytes,
      publish: async (item) => {
        const gate = gates[started.length]!;
        started.push(item.id);
        activePublishes += 1;
        peakPublishes = Math.max(peakPublishes, activePublishes);
        await gate.promise;
        activePublishes -= 1;
      },
      onError: (cause) => errors.push(cause),
    });

    expect(queue.enqueue({ id: "init", bytes: 3 }, producer.value)).toBe(true);
    expect(queue.enqueue({ id: "middle", bytes: 3 }, producer.value)).toBe(true);
    expect(queue.enqueue({ id: "tail", bytes: 2 }, producer.value)).toBe(true);
    expect(started).toEqual(["init"]);
    expect(producer.counts()).toEqual({ pauses: 1, resumes: 0 });
    expect(queue.stats()).toEqual({ pendingBytes: 8, pendingItems: 3, closed: false });

    gates[0]!.resolve();
    await nextMicrotask();
    expect(started).toEqual(["init", "middle"]);
    expect(producer.counts()).toEqual({ pauses: 1, resumes: 0 });

    gates[1]!.resolve();
    await nextMicrotask();
    expect(started).toEqual(["init", "middle", "tail"]);
    expect(producer.counts()).toEqual({ pauses: 1, resumes: 1 });

    gates[2]!.resolve();
    await queue.whenIdle();
    expect(peakPublishes).toBe(1);
    expect(queue.stats()).toEqual({ pendingBytes: 0, pendingItems: 0, closed: false });
    expect(errors).toEqual([]);
  });

  it("fails closed instead of dropping or accumulating chunks beyond the byte budget", async () => {
    const firstPublish = deferred();
    const started: Array<string> = [];
    const errors: Array<unknown> = [];
    const producer = pacer();
    const queue = createRemoteControlVideoPublishQueue<{ id: string; bytes: number }>({
      maxPendingBytes: 5,
      pauseAtBytes: 3,
      resumeAtBytes: 1,
      sizeOf: (item) => item.bytes,
      publish: async (item) => {
        started.push(item.id);
        await firstPublish.promise;
      },
      onError: (cause) => errors.push(cause),
    });

    expect(queue.enqueue({ id: "init", bytes: 3 }, producer.value)).toBe(true);
    expect(queue.enqueue({ id: "overflow", bytes: 3 }, producer.value)).toBe(false);
    expect(queue.enqueue({ id: "after-close", bytes: 1 }, producer.value)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("5-byte buffer");
    expect(started).toEqual(["init"]);
    expect(queue.stats()).toEqual({ pendingBytes: 3, pendingItems: 1, closed: true });

    firstPublish.resolve();
    await queue.whenIdle();
    expect(queue.stats()).toEqual({ pendingBytes: 0, pendingItems: 0, closed: true });
    expect(started).toEqual(["init"]);
  });

  it("releases queued chunks and reports a publish failure only once", async () => {
    const failed = deferred();
    const errors: Array<unknown> = [];
    const producer = pacer();
    const queue = createRemoteControlVideoPublishQueue<{ id: string; bytes: number }>({
      maxPendingBytes: 10,
      pauseAtBytes: 8,
      resumeAtBytes: 2,
      sizeOf: (item) => item.bytes,
      publish: async () => failed.promise,
      onError: (cause) => errors.push(cause),
    });

    queue.enqueue({ id: "in-flight", bytes: 2 }, producer.value);
    queue.enqueue({ id: "retained", bytes: 2 }, producer.value);
    failed.reject(new Error("connection closed"));
    await queue.whenIdle();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("connection closed");
    expect(queue.stats()).toEqual({ pendingBytes: 0, pendingItems: 0, closed: true });
  });
});

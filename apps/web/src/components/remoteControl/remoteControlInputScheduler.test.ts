import type { RemoteControlInput } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { createRemoteControlInputScheduler } from "./remoteControlInputScheduler.ts";

const pointer = (x: number, dx?: number): RemoteControlInput => ({
  type: "pointer",
  action: "move",
  x,
  y: 0.5,
  button: "left",
  ...(dx === undefined ? {} : { dx, dy: 0 }),
});

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

it("samples a pointer burst once per frame and sends only its newest destination", () => {
  const sent: RemoteControlInput[] = [];
  const frames: Array<() => void> = [];
  const scheduler = createRemoteControlInputScheduler({
    send: async (input) => {
      sent.push(input);
    },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
  });

  for (let index = 0; index < 100; index += 1) scheduler.enqueue(pointer(index / 100));
  expect(sent).toEqual([]);
  expect(frames).toHaveLength(1);
  frames[0]!();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ x: 0.99 });
});

it("keeps one replaceable motion successor instead of replaying a slow backlog", async () => {
  const sent: RemoteControlInput[] = [];
  const frames: Array<() => void> = [];
  const active = deferred();
  const scheduler = createRemoteControlInputScheduler({
    send: (input) => {
      sent.push(input);
      return sent.length === 1 ? active.promise : Promise.resolve();
    },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
  });

  scheduler.enqueue(pointer(0.1, 10));
  frames.shift()!();
  scheduler.enqueue(pointer(0.2, 20));
  frames.shift()!();
  scheduler.enqueue(pointer(0.3, 30));
  frames.shift()!();
  expect(sent).toHaveLength(1);

  active.resolve();
  await settle();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ x: 0.3, dx: 30 });
});

it("bounds the native-host lane without adding a frame of input latency", async () => {
  const sent: RemoteControlInput[] = [];
  const active = deferred();
  const scheduler = createRemoteControlInputScheduler({
    send: (input) => {
      sent.push(input);
      return sent.length === 1 ? active.promise : Promise.resolve();
    },
  });

  scheduler.enqueue(pointer(0.1));
  for (let index = 2; index <= 100; index += 1) scheduler.enqueue(pointer(index / 100));
  // The first input reaches the helper immediately. While it is in flight,
  // only the newest successor survives.
  expect(sent).toHaveLength(1);
  active.resolve();
  await settle();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ x: 1 });
});

it("drops pending motion at a button boundary and sends the edge immediately", async () => {
  const sent: RemoteControlInput[] = [];
  const frames: Array<() => void> = [];
  const active = deferred();
  const scheduler = createRemoteControlInputScheduler({
    send: (input) => {
      sent.push(input);
      return sent.length === 1 ? active.promise : Promise.resolve();
    },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
  });

  scheduler.enqueue(pointer(0.1));
  frames.shift()!();
  scheduler.enqueue(pointer(0.2));
  frames.shift()!();
  scheduler.enqueue({ type: "pointer", action: "down", x: 0.3, y: 0.5, button: "left" });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ action: "down", x: 0.3 });

  active.resolve();
  await settle();
  expect(sent).toHaveLength(2);
});

it("does not forward browser key-repeat samples", () => {
  const sent: RemoteControlInput[] = [];
  const scheduler = createRemoteControlInputScheduler({
    send: async (input) => {
      sent.push(input);
    },
  });
  scheduler.enqueue({ type: "key", action: "down", code: "KeyW", key: "w", repeat: false });
  scheduler.enqueue({ type: "key", action: "down", code: "KeyW", key: "w", repeat: true });
  scheduler.enqueue({ type: "key", action: "up", code: "KeyW", key: "w", repeat: false });
  expect(sent.map((input) => (input.type === "key" ? input.action : input.type))).toEqual([
    "down",
    "up",
  ]);
});

it("reports a failed send without draining stale pending motion", async () => {
  const frames: Array<() => void> = [];
  const errors: unknown[] = [];
  const active = deferred();
  let sends = 0;
  const scheduler = createRemoteControlInputScheduler({
    send: () => {
      sends += 1;
      return active.promise;
    },
    onError: (cause) => errors.push(cause),
    scheduleFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  scheduler.enqueue(pointer(0.1));
  frames.shift()!();
  scheduler.enqueue(pointer(0.9));
  frames.shift()!();
  active.reject(new Error("offline"));
  await settle();
  expect(sends).toBe(1);
  expect(errors).toHaveLength(1);
});

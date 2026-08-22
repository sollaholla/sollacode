import { describe, expect, it, vi } from "vite-plus/test";

import { createThreadCreationIntentGuard } from "./threadCreationIntentGuard";

const INTENT = {
  environmentId: "environment-1",
  projectId: "project-1",
  title: "Investigate agent flow",
  message: "Investigate notifications, tasks, and artifacts.",
};

describe("createThreadCreationIntentGuard", () => {
  it("shares one in-flight creation across repeated tool calls", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const create = vi.fn(() => pending);
    const guard = createThreadCreationIntentGuard();

    const first = guard.run(INTENT, create);
    const replay = guard.run(INTENT, create);
    await Promise.resolve();

    expect(create).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, replay]);
  });

  it("suppresses a replay that arrives just after creation completes", async () => {
    let now = 1_000;
    const create = vi.fn(async () => undefined);
    const guard = createThreadCreationIntentGuard({ now: () => now, windowMs: 500 });

    await guard.run(INTENT, create);
    now += 89;
    await guard.run(INTENT, create);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("allows the same intent again after the replay window", async () => {
    let now = 1_000;
    const create = vi.fn(async () => undefined);
    const guard = createThreadCreationIntentGuard({ now: () => now, windowMs: 500 });

    await guard.run(INTENT, create);
    now += 501;
    await guard.run(INTENT, create);

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not replay a partially completed creation until the window expires", async () => {
    let now = 1_000;
    const create = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const guard = createThreadCreationIntentGuard({ now: () => now, windowMs: 500 });

    await expect(guard.run(INTENT, create)).rejects.toThrow("offline");
    await expect(guard.run(INTENT, create)).rejects.toThrow("offline");
    expect(create).toHaveBeenCalledTimes(1);

    now += 501;
    await expect(guard.run(INTENT, create)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not merge distinct thread requests", async () => {
    const create = vi.fn(async () => undefined);
    const guard = createThreadCreationIntentGuard();

    await Promise.all([
      guard.run(INTENT, create),
      guard.run({ ...INTENT, message: "A different request." }, create),
    ]);

    expect(create).toHaveBeenCalledTimes(2);
  });
});

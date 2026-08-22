import { describe, expect, it, vi } from "vite-plus/test";

import {
  createScreenWakeLock,
  describeSessionInterruption,
  type WakeLockRequester,
  type WakeLockSentinelLike,
} from "./screenWakeLock";

function sentinel(): WakeLockSentinelLike & { release: ReturnType<typeof vi.fn> } {
  return { release: vi.fn(async () => undefined) };
}

function requester(next: () => Promise<WakeLockSentinelLike>): WakeLockRequester {
  return { request: vi.fn(next) };
}

describe("createScreenWakeLock", () => {
  it("holds one lock while voice is live", async () => {
    const lock = createScreenWakeLock(requester(async () => sentinel()));
    await lock.acquire();
    expect(lock.isHeld()).toBe(true);
  });

  it("does not stack locks when re-acquired", async () => {
    // `acquire` runs on every visibility change; a second sentinel would leak
    // the first, leaving a lock nothing can release.
    const made: Array<ReturnType<typeof sentinel>> = [];
    const lock = createScreenWakeLock(
      requester(async () => {
        const created = sentinel();
        made.push(created);
        return created;
      }),
    );
    await lock.acquire();
    await lock.acquire();
    expect(made).toHaveLength(1);
  });

  it("releases on the way out", async () => {
    const created = sentinel();
    const lock = createScreenWakeLock(requester(async () => created));
    await lock.acquire();
    lock.release();
    expect(created.release).toHaveBeenCalled();
    expect(lock.isHeld()).toBe(false);
  });

  it("survives a platform that refuses the lock", async () => {
    // Denied while hidden, which is exactly when re-acquisition is attempted.
    const lock = createScreenWakeLock(requester(async () => Promise.reject(new Error("denied"))));
    await lock.acquire();
    expect(lock.isHeld()).toBe(false);
    expect(() => lock.release()).not.toThrow();
  });

  it("does nothing at all where there is no wake lock API", async () => {
    const lock = createScreenWakeLock(null);
    await lock.acquire();
    expect(lock.isHeld()).toBe(false);
  });
});

describe("describeSessionInterruption", () => {
  it("explains a session that died while the phone was locked", () => {
    // The reported experience: the mic indicator stays lit, the model stops
    // answering, and coming back shows the chat simply ended.
    expect(describeSessionInterruption({ documentHidden: true, wasLive: true })).toContain(
      "phone locked",
    );
  });

  it("stays quiet when the user stopped it themselves", () => {
    expect(describeSessionInterruption({ documentHidden: false, wasLive: true })).toBeNull();
  });

  it("stays quiet when nothing was running", () => {
    expect(describeSessionInterruption({ documentHidden: true, wasLive: false })).toBeNull();
  });
});

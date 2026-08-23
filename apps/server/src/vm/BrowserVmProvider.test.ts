import * as NodeServices from "@effect/platform-node/NodeServices";
import { VmId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  applyInput,
  browserExecutableAvailable,
  clearStaleProfileLock,
  condenseLaunchFailure,
  enqueue,
  parseSingletonLockTarget,
  shouldClearSingletonLock,
  VmProviderBrowserLive,
  type BrowserVm,
} from "./BrowserVmProvider.ts";
import { VmProvider } from "./VmProvider.ts";

// ── Input sequencing (no browser required) ──────────────────────────────────
//
// Every input event arrives as its own RPC, so its own fiber. `applyInput`
// awaits between `mouse.move` and `mouse.down`/`mouse.up`, so without the queue
// a click is delivered as `move, move, up, down` and the button stays held —
// which turns every later click into a drag for the user *and* the agent.

/** A Page stub that records mouse calls and yields between each, like the real one. */
const stubVm = () => {
  const calls: string[] = [];
  const yieldTick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const page = {
    mouse: {
      move: async (x: number, y: number) => {
        await yieldTick();
        calls.push(`move(${Math.round(x)},${Math.round(y)})`);
      },
      down: async ({ button }: { button: string }) => {
        await yieldTick();
        calls.push(`down(${button})`);
      },
      up: async ({ button }: { button: string }) => {
        await yieldTick();
        calls.push(`up(${button})`);
      },
    },
  };
  const vm = {
    page,
    cursor: { x: 0, y: 0 },
    pressed: new Set<"left" | "right" | "middle">(),
    queue: Promise.resolve(),
  } as unknown as BrowserVm;
  return { vm, calls };
};

const press = (action: "down" | "up") =>
  ({ type: "pointer", action, x: 0.5, y: 0.5, button: "left" }) as const;

it("keeps a concurrently dispatched press and release in order", async () => {
  const { vm, calls } = stubVm();
  // Both edges dispatched without awaiting the first — two racing fibers.
  await Promise.all([
    enqueue(vm, () => applyInput(vm, press("down"))),
    enqueue(vm, () => applyInput(vm, press("up"))),
  ]);
  assert.deepStrictEqual(calls, ["move(640,400)", "down(left)", "move(640,400)", "up(left)"]);
  assert.strictEqual(vm.pressed.size, 0, "the button must not stay held");
});

it("recovers when a press arrives while the button is already held", async () => {
  const { vm, calls } = stubVm();
  await enqueue(vm, () => applyInput(vm, press("down")));
  await enqueue(vm, () => applyInput(vm, press("down")));
  // The second press releases first, so Chromium sees a real click rather than
  // a drag that silently swallows it.
  assert.deepStrictEqual(calls.slice(2), ["move(640,400)", "up(left)", "down(left)"]);
  assert.isTrue(vm.pressed.has("left"));
});

it("drops a stray release when nothing is held", async () => {
  const { vm, calls } = stubVm();
  await enqueue(vm, () => applyInput(vm, press("up")));
  assert.deepStrictEqual(calls, ["move(640,400)"]);
  assert.strictEqual(vm.pressed.size, 0);
});

// This suite drives a real headless Chromium, so it only runs where a
// launchable browser exists (dev machines, and CI images that install one).
// Elsewhere it self-skips instead of failing.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

if (!browserExecutableAvailable()) {
  it("BrowserVmProvider (skipped: no Chrome/Chromium executable on this host)", () => {
    assert.isFalse(browserExecutableAvailable());
  });
} else {
  const providerLayer = it.layer(
    VmProviderBrowserLive.pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-vm-browser-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  providerLayer("BrowserVmProvider", (it) => {
    it.effect(
      "captures a real page screenshot and reflects driven input in the cursor",
      () =>
        Effect.gen(function* () {
          const provider = yield* VmProvider;
          const vmId = VmId.make(`vm-browser-test-${NodeCrypto.randomUUID()}`);

          assert.strictEqual(provider.name, "browser");
          assert.isTrue(yield* provider.isAvailable());

          yield* provider.create({ vmId, agentName: "Tester" });
          const boot = yield* provider.start(vmId);
          // A browser has no guest IP; the manager tolerates null.
          assert.strictEqual(boot.guestIp, null);

          // A genuine screenshot: real PNG bytes at the configured viewport.
          const frame = yield* provider.capture(vmId);
          assert.strictEqual(frame.format, "png");
          assert.strictEqual(frame.width, 1280);
          assert.strictEqual(frame.height, 800);
          const bytes = Buffer.from(frame.data, "base64");
          assert.isTrue(bytes.subarray(0, 4).equals(PNG_SIGNATURE));
          assert.isAtLeast(bytes.length, 1_000);

          // Driving the pointer moves the reported cursor to the denormalized
          // pixel of the frame — proof input reached the real page.
          yield* provider.input(vmId, {
            type: "pointer",
            action: "move",
            x: 0.25,
            y: 0.75,
            button: "left",
          });
          const afterMove = yield* provider.capture(vmId);
          assert.isTrue(afterMove.cursor !== undefined);
          if (afterMove.cursor) {
            assert.isAtMost(Math.abs(afterMove.cursor.x - Math.round(0.25 * 1279)), 1);
            assert.isAtMost(Math.abs(afterMove.cursor.y - Math.round(0.75 * 799)), 1);
          }

          // Real keyboard input must not throw.
          yield* provider.input(vmId, { type: "key", action: "down", key: "a", code: "KeyA" });
          yield* provider.input(vmId, { type: "key", action: "up", key: "a", code: "KeyA" });

          // Stopping closes the browser; capture then fails until restart.
          yield* provider.stop(vmId);
          const stopped = yield* Effect.flip(provider.capture(vmId));
          assert.strictEqual(stopped._tag, "VmProviderError");

          yield* provider.delete(vmId);
        }),
      60_000,
    );
  });
}

// ── Stale profile-lock recovery ─────────────────────────────────────────────
//
// The desktop updater force-kills the server and every agent's child browser,
// so Chromium's SingletonLock can survive pointing at a dead pid. The next
// launch then aborted with "profile is already in use" although nothing was
// using it, and the agent's VM stayed unstartable until the file was deleted
// by hand — observed on this machine immediately after an app update.

it.effect("reads hostname and pid out of a singleton lock target", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(parseSingletonLockTarget("mac-studio-19963"), {
      host: "mac-studio",
      pid: 19_963,
    });
    assert.isNull(parseSingletonLockTarget("no-trailing-pid-"));
    assert.isNull(parseSingletonLockTarget("nodash"));
    assert.isNull(parseSingletonLockTarget("-123"));
    assert.isNull(parseSingletonLockTarget("host-notapid"));
  }),
);

it.effect("clears only locks whose owner is provably dead", () =>
  Effect.sync(() => {
    const alive = (pid: number) => pid === 4_242;
    // Dead pid on this host: stale.
    assert.isTrue(
      shouldClearSingletonLock({
        target: "this-host-999999",
        hostname: "this-host",
        pidAlive: alive,
      }),
    );
    // Live pid: a genuinely concurrent Chromium keeps its lock.
    assert.isFalse(
      shouldClearSingletonLock({
        target: "this-host-4242",
        hostname: "this-host",
        pidAlive: alive,
      }),
    );
    // Another machine's lock cannot be judged from here.
    assert.isFalse(
      shouldClearSingletonLock({
        target: "other-host-999999",
        hostname: "this-host",
        pidAlive: alive,
      }),
    );
    // Something Chromium never wrote is not a live owner's lock.
    assert.isTrue(
      shouldClearSingletonLock({ target: "garbage", hostname: "this-host", pidAlive: alive }),
    );
  }),
);

it.effect("removes a dead owner's lock trio from a real profile directory", () =>
  Effect.promise(async () => {
    const NodeFSP = await import("node:fs/promises");
    const NodeOS = await import("node:os");
    const NodePath = await import("node:path");
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vm-profile-"));
    try {
      // A dangling symlink, exactly as Chromium leaves it. Pid 2^30 is far
      // above any real pid table.
      await NodeFSP.symlink(`${NodeOS.hostname()}-1073741824`, NodePath.join(dir, "SingletonLock"));
      await NodeFSP.symlink("also-dangling", NodePath.join(dir, "SingletonCookie"));

      assert.isTrue(await clearStaleProfileLock(dir));
      const remaining = await NodeFSP.readdir(dir);
      assert.deepStrictEqual(remaining, []);
      // Idempotent: nothing left to clear.
      assert.isFalse(await clearStaleProfileLock(dir));
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  }),
);

it.effect("leaves a live owner's lock in place", () =>
  Effect.promise(async () => {
    const NodeFSP = await import("node:fs/promises");
    const NodeOS = await import("node:os");
    const NodePath = await import("node:path");
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vm-profile-"));
    try {
      // This test's own pid is as alive as a pid gets.
      await NodeFSP.symlink(
        `${NodeOS.hostname()}-${process.pid}`,
        NodePath.join(dir, "SingletonLock"),
      );
      assert.isFalse(await clearStaleProfileLock(dir));
      assert.deepStrictEqual(await NodeFSP.readdir(dir), ["SingletonLock"]);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  }),
);

it.effect("condenses a launch failure to its first line, with a plain-words singleton case", () =>
  Effect.sync(() => {
    const singleton = condenseLaunchFailure(
      "browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory. Call log:\n  - <launching> /Applications/Google Chrome.app ...",
    );
    assert.include(singleton, "Another Chromium instance");
    assert.notInclude(singleton, "Call log");

    const other = condenseLaunchFailure(
      "browserType.launchPersistentContext: Executable doesn't exist at /nope\nCall log:\n  - <launching> ...",
    );
    assert.strictEqual(
      other,
      "browserType.launchPersistentContext: Executable doesn't exist at /nope",
    );
  }),
);

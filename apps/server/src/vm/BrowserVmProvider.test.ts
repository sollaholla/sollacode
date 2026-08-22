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
  enqueue,
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

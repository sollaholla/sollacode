// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const makeRuntime = (env: NodeJS.ProcessEnv, options?: { concurrentPrompts?: boolean }) =>
  AcpSessionRuntime.make({
    spawn: {
      command: process.execPath,
      args: [mockAgentPath],
      env,
    },
    cwd: process.cwd(),
    clientInfo: { name: "t3-test", version: "0.0.0" },
    authMethodId: "test",
    ...(options?.concurrentPrompts !== undefined
      ? { concurrentPrompts: options.concurrentPrompts }
      : {}),
  });

const waitForHangingPromptAnnouncement = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  promptCount: number,
) =>
  runtime.getEvents().pipe(
    Stream.filter(
      (event) => event._tag === "ContentDelta" && event.text === `hanging-prompt-${promptCount}`,
    ),
    Stream.take(1),
    Stream.runDrain,
  );

describe("AcpSessionRuntime concurrent prompts", () => {
  it.effect("sends a second prompt while the first is still in flight", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime(
        {
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_ANNOUNCE_HANGING_PROMPT: "1",
        },
        { concurrentPrompts: true },
      );
      yield* runtime.start();

      const firstPromptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkScoped);
      // The agent announces the hanging prompt over the session stream, so
      // this wait proves the first session/prompt reached it before the
      // second one is issued.
      yield* waitForHangingPromptAnnouncement(runtime, 1);

      const secondPromptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "second" }],
      });
      expect(secondPromptResult.stopReason).toBe("end_turn");

      yield* Fiber.interrupt(firstPromptFiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancel settles every in-flight prompt", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime(
        {
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_ANNOUNCE_HANGING_PROMPT: "1",
        },
        { concurrentPrompts: true },
      );
      yield* runtime.start();

      const firstPromptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkScoped);
      yield* waitForHangingPromptAnnouncement(runtime, 1);
      const secondPromptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "second" }] })
        .pipe(Effect.forkScoped);
      yield* waitForHangingPromptAnnouncement(runtime, 2);

      yield* runtime.cancel;

      const firstPromptResult = yield* Fiber.join(firstPromptFiber);
      const secondPromptResult = yield* Fiber.join(secondPromptFiber);
      expect(firstPromptResult.stopReason).toBe("cancelled");
      expect(secondPromptResult.stopReason).toBe("cancelled");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

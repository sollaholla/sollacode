// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const makeRuntime = (
  env: NodeJS.ProcessEnv,
  options?: {
    concurrentPrompts?: boolean;
    requestLogger?: AcpSessionRuntime.AcpSessionRuntimeOptions["requestLogger"];
  },
) =>
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
    ...(options?.requestLogger ? { requestLogger: options.requestLogger } : {}),
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

describe("descendantProcessGroupsFromPs", () => {
  it("finds detached descendant groups without targeting the host group", () => {
    const psOutput = `
      500 1 500
      100 500 100
      101 100 100
      102 101 102
      103 102 103
      104 101 500
      200 1 200
    `;

    expect(AcpSessionRuntime.descendantProcessGroupsFromPs(100, 500, psOutput)).toEqual([102, 103]);
  });
});

describe("AcpSessionRuntime concurrent prompts", () => {
  it.effect("signals native dispatch only after the exact prompt enters the outgoing queue", () =>
    Effect.gen(function* () {
      const requestLoggerEntered = yield* Deferred.make<void>();
      const releaseRequestLogger = yield* Deferred.make<void>();
      const nativeDispatch = yield* Deferred.make<void>();
      const runtime = yield* makeRuntime(
        {
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_ANNOUNCE_HANGING_PROMPT: "1",
        },
        {
          concurrentPrompts: true,
          requestLogger: (event) =>
            event.method === "session/prompt" && event.status === "started"
              ? Deferred.succeed(requestLoggerEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRequestLogger)),
                )
              : Effect.void,
        },
      );
      yield* runtime.start();

      const promptFiber = yield* runtime
        .prompt(
          {
            messageId: "24494813-596c-4217-a2bd-dab2c3da4bc3",
            prompt: [{ type: "text", text: "hang after native enqueue" }],
          },
          { onNativeDispatch: Deferred.succeed(nativeDispatch, undefined) },
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(requestLoggerEntered);
      expect(yield* Deferred.isDone(nativeDispatch)).toBe(false);

      yield* Deferred.succeed(releaseRequestLogger, undefined);
      yield* Deferred.await(nativeDispatch);
      yield* waitForHangingPromptAnnouncement(runtime, 1);
      expect(promptFiber.pollUnsafe()).toBeUndefined();

      yield* runtime.cancel;
      expect((yield* Fiber.join(promptFiber)).stopReason).toBe("cancelled");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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

      const secondPromptDispatched = yield* Deferred.make<void>();
      const secondPromptResult = yield* runtime.prompt(
        { prompt: [{ type: "text", text: "second" }] },
        { onNativeDispatch: Deferred.succeed(secondPromptDispatched, undefined) },
      );
      expect(yield* Deferred.isDone(secondPromptDispatched)).toBe(true);
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

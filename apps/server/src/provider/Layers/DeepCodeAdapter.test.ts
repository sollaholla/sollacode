// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ProviderInstanceId, ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { makeDeepCodeAdapter } from "./DeepCodeAdapter.ts";
import { deepCodeSessionsIndexPath } from "../deepcodeProtocol.ts";

const threadId = ThreadId.make("deepcode-test-thread");
const instanceId = ProviderInstanceId.make("deepcode-test-instance");
const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

async function fixture(mode = "success") {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-deepcode-test-"));
  const binaryPath = NodePath.join(dir, "deepcode");
  const argsPath = NodePath.join(dir, "args.jsonl");
  await NodeFSP.writeFile(
    binaryPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DEEPCODE_TEST_ARGS, JSON.stringify(args)+'\\n');
const promptIndex = args.indexOf('--prompt');
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';
const resumeIndex = args.indexOf('--resume');
const resume = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
// The real CLI derives this from its own cwd, and hashes it past 64 chars.
// The test hands us the exact path instead: reproducing that derivation here
// would only re-test deepCodeProjectCode, which has its own unit tests, and
// gets it wrong anyway because Node resolves /var to /private/var in a child
// while the adapter hashes the unresolved path it was configured with.
const projectDir = path.dirname(process.env.DEEPCODE_TEST_SESSIONS_INDEX);
fs.mkdirSync(projectDir, { recursive: true });
const id = resume || ${JSON.stringify(SESSION_ID)};
fs.writeFileSync(process.env.DEEPCODE_TEST_SESSIONS_INDEX, JSON.stringify({
  entries: [{ id, updateTime: new Date().toISOString() }]
}));
const mode = process.env.DEEPCODE_TEST_MODE || 'success';
if (mode === 'permission') {
  console.error('Execution requires permission confirmation, which is unavailable in --exec mode.');
  process.exit(1);
}
if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  return;
}
process.stdout.write((resume ? 'resumed:' : 'ok:') + prompt + '\\n');
`,
    { mode: 0o755 },
  );
  return {
    dir,
    binaryPath,
    argsPath,
    environment: {
      ...process.env,
      HOME: dir,
      DEEPCODE_TEST_ARGS: argsPath,
      DEEPCODE_TEST_MODE: mode,
      DEEPCODE_TEST_SESSIONS_INDEX: deepCodeSessionsIndexPath(dir, dir),
    } satisfies NodeJS.ProcessEnv,
    cleanup: () => NodeFSP.rm(dir, { recursive: true, force: true }),
  };
}

function program(binaryPath: string, cwd: string, environment: NodeJS.ProcessEnv) {
  return makeDeepCodeAdapter({ instanceId, binaryPath, cwd, environment });
}

const setup = Effect.fn("DeepCodeTest.setup")(function* (mode = "success") {
  const f = yield* Effect.acquireRelease(
    Effect.promise(() => fixture(mode)),
    (f) => Effect.promise(f.cleanup),
  );
  const adapter = yield* program(f.binaryPath, f.dir, f.environment);
  return { ...f, adapter };
});

const observe = Effect.fn("DeepCodeTest.observe")(function* (
  adapter: Effect.Success<ReturnType<typeof program>>,
) {
  const events: ProviderRuntimeEvent[] = [];
  const first = yield* Deferred.make<void>();
  const second = yield* Deferred.make<void>();
  const delivered = yield* Deferred.make<void>();
  let completions = 0;
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        events.push(decode(event));
        if (event.type === "message.delivered") yield* Deferred.succeed(delivered, undefined);
        if (event.type === "turn.completed")
          yield* Deferred.succeed(++completions === 1 ? first : second, undefined);
      }),
    ),
    Effect.forkScoped,
  );
  return { events, first, second, delivered };
});

describe("Deep Code adapter process lifecycle", () => {
  it.live("delivers the exec reply and resumes the native session on the next turn", () =>
    Effect.gen(function* () {
      const { adapter, argsPath } = yield* setup();
      const { events, first, second } = yield* observe(adapter);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const accepted = yield* adapter.sendTurn({
        threadId,
        input: "one",
        messageId: MessageId.make("one"),
        modelSelection: {
          instanceId,
          model: "deepseek-flash",
          options: [{ id: "effort", value: "high" }],
        },
      });
      expect(accepted.resumeCursor).toEqual({ sessionId: SESSION_ID });
      yield* Deferred.await(first);
      yield* adapter.sendTurn({
        threadId,
        input: "two",
        messageId: MessageId.make("two"),
      });
      yield* Deferred.await(second);
      expect(
        events
          .filter((e) => e.type === "content.delta")
          .map((e) => e.payload.delta)
          .join(""),
      ).toBe("ok:one\nresumed:two\n");
      expect(events.filter((e) => e.type === "message.delivered")).toHaveLength(2);
      expect(events.filter((e) => e.type === "turn.completed").map((e) => e.payload.state)).toEqual(
        ["completed", "completed"],
      );
      const log = yield* Effect.promise(() => NodeFSP.readFile(argsPath, "utf8"));
      const args = log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(args[0]).toEqual(["--exec", "--prompt", "one"]);
      expect(args[1]).toEqual(["--exec", "--prompt", "two", "--resume", SESSION_ID]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails exec when the CLI needs a permission prompt", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup("permission");
      const { events, first } = yield* observe(adapter);
      yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
      const sent = yield* adapter.sendTurn({ threadId, input: "test" }).pipe(Effect.result);
      expect(sent._tag).toBe("Failure");
      yield* Deferred.await(first);
      expect(events.find((e) => e.type === "turn.completed")?.payload).toMatchObject({
        state: "failed",
        errorMessage: expect.stringContaining("permission confirmation"),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "forces an unresponsive owned child to exit and emits one interruption",
    () =>
      Effect.gen(function* () {
        const { adapter } = yield* setup("hang");
        const { events, first, delivered } = yield* observe(adapter);
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const sending = yield* adapter
          .sendTurn({
            threadId,
            input: "wait",
            messageId: MessageId.make("wait"),
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(delivered);
        yield* adapter.interruptTurn(threadId);
        yield* Deferred.await(first);
        yield* Fiber.join(sending);
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
        expect(
          events.filter((e) => e.type === "turn.completed").map((e) => e.payload.state),
        ).toEqual(["interrupted"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );
});

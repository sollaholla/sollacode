// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ProviderInstanceId, ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const threadId = ThreadId.make("agy-test-thread");
const instanceId = ProviderInstanceId.make("agy-test-instance");
const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);

async function fixture(mode = "success") {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-agy-test-"));
  const binaryPath = NodePath.join(dir, "agy");
  await NodeFSP.writeFile(
    binaryPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const emit = (event, payload) => process.stdout.write(JSON.stringify({event, [event]: payload})+'\\n');
fs.appendFileSync(${JSON.stringify(NodePath.join(dir, "args.jsonl"))}, JSON.stringify(process.argv.slice(2))+'\\n');
let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => input+=d);
process.stdin.on('end', () => {
 const message=JSON.parse(input); if(message.event!=='user') process.exit(3);
 const mode=${JSON.stringify(mode)};
 if(mode==='malformed') { process.stdout.write('broken JSON\\n'); return; }
 if(mode==='silent') return;
 process.stdout.write(JSON.stringify({event:'init',conversation_id:'native-conversation',init:{model:'test-model'}})+'\\n');
 emit('step_update',{conversation_id:'native-conversation',step_index:0,state:'DONE',step_type:'user_input'});
 if(mode==='hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); return; }
 emit('step_update',{step_index:1,state:'ACTIVE',step_type:'agent_response',text_delta:'OK'});
 const usage={input_tokens:13713,output_tokens:1,thinking_tokens:0,cache_read_tokens:0,total_tokens:13714};
 emit('step_update',{step_index:1,state:'DONE',step_type:'agent_response',text_delta:'\\n',usage});
 emit('result',{conversation_id:'native-conversation',status:mode==='error'?'ERROR':'SUCCESS',error:mode==='error'?'denied':undefined,response:'OK\\n',usage});
});
`,
    { mode: 0o755 },
  );
  return { dir, binaryPath, cleanup: () => NodeFSP.rm(dir, { recursive: true, force: true }) };
}

function program(binaryPath: string, cwd: string) {
  return makeAntigravityAdapter({ instanceId, binaryPath, cwd, environment: process.env });
}

const setup = Effect.fn("AntigravityTest.setup")(function* (mode = "success") {
  const f = yield* Effect.acquireRelease(
    Effect.promise(() => fixture(mode)),
    (f) => Effect.promise(f.cleanup),
  );
  const adapter = yield* program(f.binaryPath, f.dir);
  return { ...f, adapter };
});

const observe = Effect.fn("AntigravityTest.observe")(function* (
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

describe("Antigravity adapter process lifecycle", () => {
  it.live("delivers, streams DONE text once, and resumes the same native conversation", () =>
    Effect.gen(function* () {
      const { adapter, dir } = yield* setup();
      const { events, first, second } = yield* observe(adapter);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "one", messageId: MessageId.make("one") });
      yield* Deferred.await(first);
      yield* adapter.sendTurn({
        threadId,
        input: "two",
        messageId: MessageId.make("two"),
        interactionMode: "plan",
      });
      yield* Deferred.await(second);
      expect(
        events
          .filter((e) => e.type === "content.delta")
          .map((e) => e.payload.delta)
          .join(""),
      ).toBe("OK\nOK\n");
      expect(events.filter((e) => e.type === "message.delivered")).toHaveLength(2);
      expect(events.filter((e) => e.type === "turn.completed").map((e) => e.payload.state)).toEqual(
        ["completed", "completed"],
      );
      // The context meter needs usage from every driver; agy reports it on the
      // DONE step and again on the result, and the second turn carries the
      // conversation's running total.
      const usage = events.filter((e) => e.type === "thread.token-usage.updated");
      expect(usage.map((e) => e.payload.usage.usedTokens)).toEqual([13714, 13714, 13714, 13714]);
      expect(usage[0]?.payload.usage.totalProcessedTokens).toBeUndefined();
      expect(usage[3]?.payload.usage.totalProcessedTokens).toBe(27428);
      expect(usage.every((e) => e.turnId !== undefined)).toBe(true);
      const log = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(dir, "args.jsonl"), "utf8"),
      );
      const args = log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(args[0]).toContain("-p=");
      expect(args[0]).toContain("--dangerously-skip-permissions");
      expect(args[1]).toContain("native-conversation");
      expect(args[1]).toContain("plan");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.each(["silent", "malformed", "error"])("settles %s output as failure", (mode) =>
    Effect.gen(function* () {
      const { adapter } = yield* setup(mode);
      const { events, first } = yield* observe(adapter);
      yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
      yield* adapter.sendTurn({ threadId, input: "test" }).pipe(Effect.result);
      yield* Deferred.await(first);
      expect(events.find((e) => e.type === "turn.completed")?.payload).toMatchObject({
        state: "failed",
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
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "wait",
          messageId: MessageId.make("wait"),
        });
        yield* Deferred.await(delivered);
        yield* adapter.interruptTurn(threadId, turn.turnId);
        yield* Deferred.await(first);
        yield* adapter.interruptTurn(threadId, turn.turnId);
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
        expect(
          events.filter((e) => e.type === "turn.completed").map((e) => e.payload.state),
        ).toEqual(["interrupted"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live("reports a missing executable and releases the active slot", () =>
    Effect.gen(function* () {
      const adapter = yield* program("/missing/solla/agy", NodeOS.tmpdir());
      const { events, first } = yield* observe(adapter);
      yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
      const sent = yield* adapter.sendTurn({ threadId, input: "test" }).pipe(Effect.result);
      expect(sent._tag).toBe("Failure");
      yield* Deferred.await(first);
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      expect(events.find((e) => e.type === "turn.completed")?.payload).toMatchObject({
        state: "failed",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.live.skipIf(process.env.SOLLA_TEST_LIVE_AGY !== "1")(
  "resumes a real Antigravity conversation across process lifetimes",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-agy-live-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const adapter = yield* program("/opt/homebrew/bin/agy", dir);
      const { events, first, second } = yield* observe(adapter);
      yield* adapter.startSession({
        threadId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "gemini-3.8-flash-low" },
      });
      yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("live-one"),
        input: "Remember the codeword COPPER614. Reply only: remembered. Do not use tools.",
      });
      yield* Deferred.await(first);
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toMatchObject({
        conversationId: expect.any(String),
      });
      yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("live-two"),
        input: "What codeword did I give you? Reply with that codeword only. Do not use tools.",
      });
      yield* Deferred.await(second);
      expect(events.filter((e) => e.type === "turn.completed").map((e) => e.payload.state)).toEqual(
        ["completed", "completed"],
      );
      expect(events.filter((e) => e.type === "message.delivered")).toHaveLength(2);
      expect(
        events
          .filter((e) => e.type === "content.delta")
          .map((e) => e.payload.delta)
          .join(""),
      ).toContain("COPPER614");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

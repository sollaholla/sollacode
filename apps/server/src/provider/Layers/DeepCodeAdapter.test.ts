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
import * as Ref from "effect/Ref";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { makeDeepCodeAdapter } from "./DeepCodeAdapter.ts";
import {
  DEEPCODE_PROGRESS_TIMEOUT_MESSAGE,
  DEEPCODE_STDIN_PROMPT,
  deepCodeSessionsIndexPath,
} from "../deepcodeProtocol.ts";

const threadId = ThreadId.make("deepcode-test-thread");
const instanceId = ProviderInstanceId.make("deepcode-test-instance");
const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const encodeEventsJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(ProviderRuntimeEvent)),
);
const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

async function fixture(mode = "success") {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-deepcode-test-"));
  const binaryPath = NodePath.join(dir, "deepcode");
  const argsPath = NodePath.join(dir, "args.jsonl");
  const promptsPath = NodePath.join(dir, "prompts.jsonl");
  await NodeFSP.writeFile(
    binaryPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
(async () => {
const args = process.argv.slice(2);
if (process.env.DEEPCODE_TEST_CREDENTIALS) fs.appendFileSync(process.env.DEEPCODE_TEST_CREDENTIALS, JSON.stringify({key:process.env.DEEPCODE_API_KEY,url:process.env.DEEPCODE_BASE_URL})+'\\n');
fs.appendFileSync(process.env.DEEPCODE_TEST_ARGS, JSON.stringify(args)+'\\n');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
fs.appendFileSync(process.env.DEEPCODE_TEST_PROMPTS, JSON.stringify(prompt)+'\\n');
const resumeIndex = args.indexOf('--resume');
const resume = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
// The real CLI derives this from its own cwd, and hashes it past 64 chars.
// The test hands us the exact path instead: reproducing that derivation here
// would only re-test deepCodeProjectCode, which has its own unit tests, and
// gets it wrong anyway because Node resolves /var to /private/var in a child
// while the adapter hashes the unresolved path it was configured with.
const projectDir = path.dirname(process.env.DEEPCODE_TEST_SESSIONS_INDEX);
fs.mkdirSync(projectDir, { recursive: true });
const recovery = prompt.includes('previous Deep Code session exceeded');
const id = resume || (recovery ? '223e4567-e89b-12d3-a456-426614174000' : ${JSON.stringify(SESSION_ID)});
fs.writeFileSync(process.env.DEEPCODE_TEST_SESSIONS_INDEX, JSON.stringify({
  entries: [{ id, updateTime: new Date().toISOString() }]
}));
const mode = process.env.DEEPCODE_TEST_MODE || 'success';
if (mode === 'tools') {
  // \`--exec\` prints only the final reply, so the adapter reads tool calls back
  // from the session JSONL. This mirrors that file: one assistant tool_call and
  // its role:'tool' result per turn, appended so a resumed turn grows the file.
  const messagesPath = path.join(projectDir, id + '.jsonl');
  const existing = fs.existsSync(messagesPath) ? fs.readFileSync(messagesPath, 'utf8') : '';
  const callId = resume ? 'call-resume-1' : 'call-new-1';
  // Padded past the activity payload cap so the adapter's input bounding runs.
  const command = (resume ? 'echo resumed' : 'echo first') + ' ' + 'x'.repeat(3000);
  const result = resume ? 'resumed' : 'first';
  const argumentsJson = JSON.stringify({ command, description: 'Run echo' });
  const lines = [
    JSON.stringify({
      id: callId + '-assistant',
      role: 'assistant',
      messageParams: {
        reasoning_content: 'thinking about it',
        tool_calls: [{ id: callId, type: 'function', function: { name: 'bash', arguments: argumentsJson } }]
      }
    }),
    JSON.stringify({
      id: callId + '-result',
      role: 'tool',
      messageParams: { tool_call_id: callId },
      meta: {
        function: { name: 'bash', arguments: argumentsJson },
        paramsMd: command,
        resultMd: result
      },
      content: result
    })
  ];
  fs.writeFileSync(messagesPath, existing + lines.join('\\n') + '\\n');
}
if (mode === 'stream') {
  // Prove the work log is live. Write the thinking and the tool call, then
  // block until the test releases us. A reader that only runs after the
  // process exits cannot see these while we are still here, so a regression
  // to post-hoc publishing makes the test time out rather than pass.
  const messagesPath = path.join(projectDir, id + '.jsonl');
  const callId = 'call-stream-1';
  const argumentsJson = JSON.stringify({ command: 'echo streaming', description: 'Run echo' });
  fs.appendFileSync(messagesPath, JSON.stringify({
    id: 'stream-assistant',
    role: 'assistant',
    messageParams: {
      reasoning_content: 'streaming thought',
      tool_calls: [{ id: callId, type: 'function', function: { name: 'bash', arguments: argumentsJson } }]
    }
  }) + '\\n');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(process.env.DEEPCODE_TEST_RELEASE) && Date.now() < deadline) {
    Atomics.wait(sleeper, 0, 0, 25);
  }
  fs.appendFileSync(messagesPath, JSON.stringify({
    id: 'stream-result',
    role: 'tool',
    messageParams: { tool_call_id: callId },
    meta: { function: { name: 'bash' }, paramsMd: 'echo streaming', resultMd: 'streamed' },
    content: 'streamed'
  }) + '\\n');
}
if (mode === 'overflow' || mode === 'overflow-always') {
  if (!recovery || mode === 'overflow-always') {
    fs.appendFileSync(path.join(projectDir, id + '.jsonl'), JSON.stringify({ id: 'completed-step', role: 'assistant', content: 'Already rotated the first shirt. The second shirt remains.' }) + '\\n');
    console.error("Execution failed: HTTP 400: This model's maximum context length is 1048576 tokens. However, you requested 1287359 tokens");
    process.exit(1);
  }
}
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
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
    { mode: 0o755 },
  );
  return {
    dir,
    binaryPath,
    argsPath,
    promptsPath,
    environment: {
      ...process.env,
      HOME: dir,
      DEEPCODE_TEST_ARGS: argsPath,
      DEEPCODE_TEST_PROMPTS: promptsPath,
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
  it.live("pipes long Unicode requests intact on fresh and resumed turns with bounded argv", () =>
    Effect.gen(function* () {
      const { adapter, argsPath, promptsPath } = yield* setup();
      const { events, first, second } = yield* observe(adapter);
      const prompt = 'Keep these literally: "quoted" & | < > %PATH% !value! ^ \\ 中文 🧭\n'.repeat(
        4_000,
      );
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: prompt });
      yield* Deferred.await(first);
      yield* adapter.sendTurn({ threadId, input: prompt + "Resumed turn." });
      yield* Deferred.await(second);
      const received = (yield* Effect.promise(() => NodeFSP.readFile(promptsPath, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string);
      expect(received).toEqual([prompt, prompt + "Resumed turn."]);
      const args = (yield* Effect.promise(() => NodeFSP.readFile(argsPath, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(args.every((entry) => entry.join(" ").length < 300)).toBe(true);
      expect(args[1]?.slice(-2)).toEqual(["--resume", SESSION_ID]);
      expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(0);
      expect(
        events
          .filter((event) => event.type === "turn.completed")
          .map((event) => event.payload.state),
      ).toEqual(["completed", "completed"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("declares that a mid-turn message cannot join the running exec turn", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      expect(adapter.capabilities.liveSteering).toBe("unsupported");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("hands an image to the agent as an on-disk path instead of rejecting it", () =>
    Effect.gen(function* () {
      // `--exec` takes one text prompt, so an image can never go inline. It
      // must not be silently dropped or fail the turn; the prompt carries the
      // path the server already persisted the attachment under.
      const f = yield* Effect.acquireRelease(
        Effect.promise(() => fixture()),
        (value) => Effect.promise(value.cleanup),
      );
      const attachmentsDir = NodePath.join(f.dir, "attachments");
      yield* Effect.promise(() => NodeFSP.mkdir(attachmentsDir, { recursive: true }));
      const imagePath = NodePath.join(attachmentsDir, "att-1.png");
      yield* Effect.promise(() => NodeFSP.writeFile(imagePath, "png"));
      const adapter = yield* makeDeepCodeAdapter({
        instanceId,
        binaryPath: f.binaryPath,
        cwd: f.dir,
        environment: f.environment,
        attachmentsDir,
      });
      const { first } = yield* observe(adapter);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({
        threadId,
        input: "What is wrong in this screenshot?",
        attachments: [
          {
            type: "image",
            id: "att-1",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      });
      yield* Deferred.await(first);

      const recorded = yield* Effect.promise(() => NodeFSP.readFile(f.promptsPath, "utf8"));
      const prompt = recorded
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string)
        .at(-1);
      expect(prompt).toContain("What is wrong in this screenshot?");
      expect(prompt).toContain(imagePath);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("uses the newly selected key on the next turn without replacing its session", () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(
        Effect.promise(() => fixture()),
        (value) => Effect.promise(value.cleanup),
      );
      const credentialsPath = NodePath.join(f.dir, "credentials.jsonl");
      const environment = { ...f.environment, DEEPCODE_TEST_CREDENTIALS: credentialsPath };
      const selected = yield* Ref.make({
        ...environment,
        DEEPCODE_API_KEY: "fixture-one",
        DEEPCODE_BASE_URL: "https://one.example",
      });
      const adapter = yield* makeDeepCodeAdapter({
        instanceId,
        binaryPath: f.binaryPath,
        cwd: f.dir,
        environment,
        resolveEnvironment: Ref.get(selected),
      });
      const { first, second, events } = yield* observe(adapter);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "one" });
      yield* Deferred.await(first);
      yield* Ref.set(selected, {
        ...environment,
        DEEPCODE_API_KEY: "fixture-two",
        DEEPCODE_BASE_URL: "https://two.example",
      });
      yield* adapter.sendTurn({ threadId, input: "two" });
      yield* Deferred.await(second);
      const credentials = (yield* Effect.promise(() => NodeFSP.readFile(credentialsPath, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(credentials).toEqual([
        { key: "fixture-one", url: "https://one.example" },
        { key: "fixture-two", url: "https://two.example" },
      ]);
      expect(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta)
          .join(""),
      ).toBe("ok:one\nresumed:two\n");
      const encodedEvents = yield* encodeEventsJson(events);
      expect(encodedEvents).not.toContain("fixture-one");
      expect(encodedEvents).not.toContain("fixture-two");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
      expect(args[0]).toEqual(["--exec", "--prompt", DEEPCODE_STDIN_PROMPT]);
      expect(args[1]).toEqual([
        "--exec",
        "--prompt",
        DEEPCODE_STDIN_PROMPT,
        "--resume",
        SESSION_ID,
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("publishes thinking and tool calls while the turn is still running", () =>
    Effect.gen(function* () {
      // The fixture blocks until we touch the release file, so every assertion
      // before that point describes a turn that has not finished. If the
      // adapter went back to reading the session only after the process exits,
      // the first wait here would never resolve.
      const f = yield* Effect.acquireRelease(
        Effect.promise(() => fixture("stream")),
        (value) => Effect.promise(value.cleanup),
      );
      const releasePath = NodePath.join(f.dir, "release");
      const adapter = yield* program(f.binaryPath, f.dir, {
        ...f.environment,
        DEEPCODE_TEST_RELEASE: releasePath,
      });
      const { events, first } = yield* observe(adapter);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* Effect.forkScoped(adapter.sendTurn({ threadId, input: "stream" }));

      const seen = (type: ProviderRuntimeEvent["type"]) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 400; attempt++) {
            if (events.some((event) => event.type === type)) return;
            yield* Effect.sleep("25 millis");
          }
          throw new Error(`no ${type} arrived while the turn was still running`);
        });
      yield* seen("item.updated");
      yield* seen("item.started");

      // Still mid-turn: the process is parked on the release file.
      expect(events.some((event) => event.type === "turn.completed")).toBe(false);
      const thinking = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.updated" }> =>
          event.type === "item.updated",
      );
      expect(thinking?.payload.itemType).toBe("reasoning");
      expect(thinking?.payload.detail).toBe("streaming thought");
      // Untitled on purpose: the client draws an untitled reasoning row as a
      // thought outside the work group. A provider title keeps it inline among
      // the tool calls instead.
      expect((thinking?.payload as { title?: string }).title).toBeUndefined();
      expect(String(thinking?.itemId)).toBe("stream-assistant");

      yield* Effect.promise(() => NodeFSP.writeFile(releasePath, ""));
      yield* Deferred.await(first);

      const completed = events.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed",
      );
      expect(completed.map((event) => String(event.itemId))).toEqual(["call-stream-1"]);
      // The follower already published this call; the post-exit flush shares
      // its cursor, so the turn must not emit a second copy.
      expect(
        events.filter(
          (event) => event.type === "item.started" && String(event.itemId) === "call-stream-1",
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) => event.type === "item.updated" && String(event.itemId) === "stream-assistant",
        ),
      ).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("logs each turn's tool calls from the persisted session", () =>
    Effect.gen(function* () {
      // `--exec` stdout carries only the final reply, so the adapter reads the
      // session JSONL for tool calls. A resumed turn must surface only its own
      // appended calls, not replay the first turn's.
      const { adapter } = yield* setup("tools");
      const { events, first, second } = yield* observe(adapter);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "one" });
      yield* Deferred.await(first);
      yield* adapter.sendTurn({ threadId, input: "two" });
      yield* Deferred.await(second);

      const started = events.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.started" }> =>
          event.type === "item.started",
      );
      const completed = events.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed",
      );

      expect(started.map((event) => String(event.itemId))).toEqual(["call-new-1", "call-resume-1"]);
      expect(started.map((event) => event.payload.itemType)).toEqual([
        "command_execution",
        "command_execution",
      ]);
      expect(started.map((event) => event.payload.title)).toEqual(["Command run", "Command run"]);
      expect(started[0]?.payload.detail).toContain("echo first");
      expect(started[1]?.payload.detail).toContain("echo resumed");

      expect(completed.map((event) => String(event.itemId))).toEqual([
        "call-new-1",
        "call-resume-1",
      ]);
      expect(completed.every((event) => event.payload.status === "completed")).toBe(true);
      expect(completed[0]?.payload.data as Record<string, unknown>).toMatchObject({
        toolName: "bash",
        result: "first",
      });

      // A padded command never rides into an activity payload at full size.
      const startedData = started[0]?.payload.data as
        | { input?: Record<string, unknown> }
        | undefined;
      expect(startedData?.input?.command).toContain("echo first");
      expect(String(startedData?.input?.command).length).toBeLessThanOrEqual(400);

      // The reply itself is unchanged by the tool read-back.
      expect(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta)
          .join(""),
      ).toBe("ok:one\nresumed:two\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("recovers context overflow once without redelivering or failing the turn", () =>
    Effect.gen(function* () {
      const { adapter, argsPath, promptsPath, environment } = yield* setup("overflow");
      const { events, first } = yield* observe(adapter);
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { sessionId: SESSION_ID },
      });
      const result = yield* adapter.sendTurn({
        threadId,
        input: "Rotate the shirts 90 degrees",
        messageId: MessageId.make("follow-up"),
      });
      yield* Deferred.await(first);
      const args = (yield* Effect.promise(() => NodeFSP.readFile(argsPath, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(args).toHaveLength(2);
      expect(args[0]).toContain("--resume");
      expect(args[1]).not.toContain("--resume");
      const prompts = (yield* Effect.promise(() => NodeFSP.readFile(promptsPath, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string);
      expect(prompts[1]).toContain("The second shirt remains");
      expect(prompts[1]).toContain("Rotate the shirts 90 degrees");
      const original = yield* Effect.promise(() =>
        NodeFSP.readFile(
          NodePath.join(
            NodePath.dirname(environment.DEEPCODE_TEST_SESSIONS_INDEX),
            SESSION_ID + ".jsonl",
          ),
          "utf8",
        ),
      );
      expect(original).toContain("Already rotated the first shirt");
      expect(result.resumeCursor).toEqual({ sessionId: "223e4567-e89b-12d3-a456-426614174000" });
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "message.delivered")).toHaveLength(1);
      expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(0);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        state: "completed",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("bounds an oversized saved session before invoking the CLI", () =>
    Effect.gen(function* () {
      const { adapter, argsPath, promptsPath, environment } = yield* setup();
      const originalPath = NodePath.join(
        NodePath.dirname(environment.DEEPCODE_TEST_SESSIONS_INDEX),
        SESSION_ID + ".jsonl",
      );
      const original = [
        { role: "user", content: "Keep the accepted artwork" },
        { role: "tool", content: "x".repeat(800_000) },
        { role: "assistant", content: "Build passed. Runtime check remains." },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(originalPath), { recursive: true });
        await NodeFSP.writeFile(originalPath, original);
      });
      const { events, first } = yield* observe(adapter);
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { sessionId: SESSION_ID },
      });
      yield* adapter.sendTurn({ threadId, input: "Continue the runtime check" });
      yield* Deferred.await(first);
      const args = (yield* Effect.promise(() => NodeFSP.readFile(argsPath, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(args).toHaveLength(1);
      expect(args[0]).not.toContain("--resume");
      const prompts = (yield* Effect.promise(() => NodeFSP.readFile(promptsPath, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string);
      expect(prompts[0]).toContain("Keep the accepted artwork");
      expect(prompts[0]).toContain("Build passed. Runtime check remains.");
      expect(prompts[0]).toContain("Continue the runtime check");
      expect(yield* Effect.promise(() => NodeFSP.readFile(originalPath, "utf8"))).toBe(original);
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        state: "completed",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not loop when the bounded recovery also exceeds context", () =>
    Effect.gen(function* () {
      const { adapter, argsPath } = yield* setup("overflow-always");
      const { first } = yield* observe(adapter);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const result = yield* adapter.sendTurn({ threadId, input: "Continue" }).pipe(Effect.result);
      yield* Deferred.await(first);
      expect(result._tag).toBe("Failure");
      const args = (yield* Effect.promise(() => NodeFSP.readFile(argsPath, "utf8")))
        .trim()
        .split("\n");
      expect(args).toHaveLength(2);
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
        const { adapter, environment } = yield* setup("hang");
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
        // `message.delivered` fires as soon as the child is spawned, which can
        // beat the CLI's own startup. Interrupt a turn that has really begun —
        // otherwise this asserts against a session the CLI never registered.
        yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt++) {
            const written = yield* Effect.promise(() =>
              NodeFSP.readFile(environment.DEEPCODE_TEST_SESSIONS_INDEX as string, "utf8").then(
                (value) => value.includes(SESSION_ID),
                () => false,
              ),
            );
            if (written) return;
            yield* Effect.sleep("25 millis");
          }
          throw new Error("the fixture never registered its session");
        });
        yield* adapter.interruptTurn(threadId);
        yield* Deferred.await(first);
        // A stopped turn is an outcome, not a failed send. The reactor stops a
        // turn on purpose to let a queued message through, and a failure here
        // would have it record an error and re-dispatch the prompt it just
        // stopped — the queued message and the original both running again.
        const outcome = yield* Fiber.join(sending);
        expect(outcome._tag).toBe("Success");
        const [session] = yield* adapter.listSessions();
        expect(session?.status).toBe("ready");
        expect(
          events.filter((e) => e.type === "turn.completed").map((e) => e.payload.state),
        ).toEqual(["interrupted"]);
        // An interrupted turn must still record the native session. Stopping a
        // turn is how a queued message gets in front of a provider that cannot
        // steer, so losing the cursor here would silently start the next turn
        // in a brand-new session and drop everything said so far.
        expect(session?.resumeCursor).toEqual({ sessionId: SESSION_ID });
      }).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "stops a turn whose session file sits silent and reports the stall marker",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(
          Effect.promise(() => fixture("hang")),
          (value) => Effect.promise(value.cleanup),
        );
        const adapter = yield* makeDeepCodeAdapter({
          instanceId,
          binaryPath: f.binaryPath,
          cwd: f.dir,
          environment: f.environment,
          progressStallLimitMs: 2_000,
          progressStallPollMs: 100,
        });
        const { events, first } = yield* observe(adapter);
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const sending = yield* adapter
          .sendTurn({
            threadId,
            input: "wait",
            messageId: MessageId.make("wait-stall"),
          })
          .pipe(Effect.result, Effect.forkChild);
        // The hang fixture traps SIGTERM and never appends a message row: two
        // silent seconds trip the watchdog, and `forceKillAfter` escalates
        // past the trap so the kill actually lands.
        yield* Deferred.await(first);
        const outcome = yield* Fiber.join(sending);
        expect(outcome._tag).toBe("Failure");
        const completed = events.find((event) => event.type === "turn.completed");
        expect(completed?.payload).toMatchObject({
          state: "failed",
          errorMessage: DEEPCODE_PROGRESS_TIMEOUT_MESSAGE,
        });
        const [session] = yield* adapter.listSessions();
        expect(session?.status).toBe("ready");
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );
});

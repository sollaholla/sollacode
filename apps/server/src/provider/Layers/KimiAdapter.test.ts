// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  KimiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { KIMI_EMPTY_TURN_MESSAGE, KIMI_NOT_SIGNED_IN_MESSAGE } from "../acp/KimiAcpSupport.ts";
import type { KimiAdapterShape } from "../Services/KimiAdapter.ts";
import { makeKimiAdapter } from "./KimiAdapter.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

class KimiAdapter extends Context.Service<KimiAdapter, KimiAdapterShape>()(
  "t3/provider/Layers/KimiAdapter.test/KimiAdapter",
) {}

/**
 * A stand-in for `kimi acp`. The `initialize` and `session/new` payloads are
 * the ones Kimi Code 0.28.1 sent to a raw probe, so decoding them here is a
 * check against the real handshake, not an invented one. Permission requests
 * use Kimi's own option ids and kinds (see KimiAcpSupport).
 */
const MOCK_AGENT_SOURCE = String.raw`
import * as fs from "node:fs";
const log = process.env.KIMI_MOCK_LOG;
const record = (entry) => { if (log) fs.appendFileSync(log, JSON.stringify(entry) + "\n"); };
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let nextId = 1000;
const pending = new Map();
const ask = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
});
const sessionId = "session_mock";
const config = { model: "probe/k3", thinking: "on", mode: "default" };
const configOptions = () => [
  { type: "select", id: "model", name: "Model", category: "model", currentValue: config.model,
    options: [{ value: "probe/k3", name: "K3" }, { value: "probe/kimi-for-coding", name: "K2.7 Coding" }] },
  { type: "select", id: "thinking", name: "Thinking", category: "thought_level", currentValue: "on",
    options: [{ value: "on", name: "Thinking On" }] },
  { type: "select", id: "mode", name: "Mode", category: "mode", currentValue: config.mode,
    options: [
      { value: "default", name: "Default", description: "Manual approvals; tools execute normally." },
      { value: "plan", name: "Plan", description: "Read-only planning; no tool execution." },
      { value: "auto", name: "Auto", description: "Fully autonomous — agent decides everything without asking." },
      { value: "yolo", name: "YOLO", description: "Auto-approve tool actions, but the agent may still ask questions." },
    ] },
];
const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const text = (value) => ({ type: "content", content: { type: "text", text: value } });
const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {}, resume: {} },
    },
    authMethods: [{
      id: "login", type: "terminal", name: "Login with Kimi account",
      description: "Open the device-code login flow in a terminal.", args: ["--login"], env: {},
      _meta: { "terminal-auth": { type: "terminal", label: "Login with Kimi account", command: "kimi", args: ["login"], env: {} } },
    }],
    agentInfo: { name: "Kimi Code CLI", version: "0.28.1" },
  }),
  authenticate: () => {
    if (process.env.KIMI_MOCK_SIGNED_OUT === "1") throw { code: -32000, message: "Authentication required" };
    return {};
  },
  "session/new": () => ({ sessionId, configOptions: configOptions() }),
  "session/load": () => ({ configOptions: configOptions() }),
  "session/set_config_option": (params) => {
    const option = configOptions().find((candidate) => candidate.id === params.configId);
    if (!option || !option.options.some((entry) => entry.value === params.value)) {
      throw { code: -32602, message: "Invalid params" };
    }
    config[params.configId] = params.value;
    update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
    return { configOptions: configOptions() };
  },
  "session/prompt": async (params) => {
    const prompt = params.prompt.map((part) => part.text ?? "").join(" ");
    if (prompt === "ask") {
      const response = await ask("session/request_permission", {
        sessionId,
        options: [
          { optionId: "q0_opt_0", name: "Red", kind: "allow_once" },
          { optionId: "q0_opt_1", name: "Blue", kind: "allow_once" },
          { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
        ],
        toolCall: { toolCallId: "0:ask-1", title: "AskUserQuestion", content: [text("Which color?")] },
      });
      record({ permissionResponse: response });
      say("answered");
      return { stopReason: "end_turn" };
    }
    if (prompt === "approve") {
      const response = await ask("session/request_permission", {
        sessionId,
        options: [
          { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
          { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
        toolCall: { toolCallId: "0:bash-1", title: "Bash", kind: "execute", content: [text("Requesting approval to run ls")] },
      });
      record({ permissionResponse: response });
      say("approved");
      return { stopReason: "end_turn" };
    }
    if (prompt === "plan") {
      const response = await ask("session/request_permission", {
        sessionId,
        options: [
          { optionId: "plan_approve", name: "Approve", kind: "allow_once" },
          { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
          { optionId: "plan_reject_and_exit", name: "Reject and Exit", kind: "reject_once" },
        ],
        toolCall: {
          toolCallId: "0:plan-1",
          title: "ExitPlanMode",
          content: [
            text("Plan saved to: /tmp/kimi-plan.md\n\n# Plan\n\n1. Ship it"),
            text("Requesting approval to Presenting plan and exiting plan mode"),
          ],
        },
      });
      record({ permissionResponse: response });
      return { stopReason: "end_turn" };
    }
    if (prompt === "silent") return { stopReason: "end_turn" };
    say("hello from kimi mock");
    return { stopReason: "end_turn" };
  },
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === undefined) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve?.(message.result ?? message.error);
      continue;
    }
    record({ method: message.method, params: message.params });
    const handler = handlers[message.method];
    if (message.id === undefined) continue;
    Promise.resolve()
      .then(() => {
        if (!handler) throw { code: -32601, message: "Method not found" };
        return handler(message.params ?? {});
      })
      .then(
        (result) => send({ jsonrpc: "2.0", id: message.id, result: result ?? null }),
        (error) => send({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message ?? "error" } }),
      );
  }
});
`;

async function makeMockKimi(extraEnv: Record<string, string> = {}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mock-"));
  const agentPath = NodePath.join(dir, "kimi-mock.mjs");
  const logPath = NodePath.join(dir, "requests.jsonl");
  const wrapperPath = NodePath.join(dir, "kimi");
  await NodeFSP.writeFile(agentPath, MOCK_AGENT_SOURCE, "utf8");
  const exports = Object.entries({ KIMI_MOCK_LOG: logPath, ...extraEnv })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\n${exports}\nexec node ${JSON.stringify(agentPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return { wrapperPath, logPath };
}

async function readLog(logPath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await NodeFSP.readFile(logPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function configWrites(log: ReadonlyArray<Record<string, unknown>>) {
  return log
    .filter((entry) => entry.method === "session/set_config_option")
    .map((entry) => entry.params as { sessionId: string; configId: string; value: string });
}

function permissionResponses(log: ReadonlyArray<Record<string, unknown>>) {
  return log.flatMap((entry) => (entry.permissionResponse ? [entry.permissionResponse] : []));
}

const KIMI_INSTANCE = ProviderInstanceId.make("kimi");
const KIMI_USAGE_READING = {
  source: "kimi-usages",
  windows: [
    { key: "weekly", label: "Weekly", usedPercent: 40, resetsAt: null, windowDurationMs: null },
  ],
};
const KIMI_DRIVER = ProviderDriverKind.make("kimi");

const layer = it.layer(
  Layer.effect(
    KimiAdapter,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      return yield* makeKimiAdapter(decodeKimiSettings({}), {
        resolveSettings: serverSettings.getSettings.pipe(
          Effect.map((snapshot) => snapshot.providers.kimi),
          Effect.orDie,
        ),
        readAccountUsage: Effect.succeed(KIMI_USAGE_READING),
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-kimi-adapter-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

/** Records every event for a thread and resolves the first of a given type. */
const watchThread = (adapter: KimiAdapterShape, threadId: ThreadId) =>
  Effect.gen(function* () {
    const events: Array<ProviderRuntimeEvent> = [];
    const waiters = new Map<string, Deferred.Deferred<ProviderRuntimeEvent>>();
    const waitFor = (type: ProviderRuntimeEvent["type"]) =>
      Effect.gen(function* () {
        const seen = events.find((event) => event.type === type);
        if (seen) return seen;
        let waiter = waiters.get(type);
        if (!waiter) {
          waiter = yield* Deferred.make<ProviderRuntimeEvent>();
          waiters.set(type, waiter);
        }
        return yield* Deferred.await(waiter);
      });
    yield* Stream.runForEach(adapter.streamEvents, (event) => {
      if (String(event.threadId) !== String(threadId)) return Effect.void;
      events.push(event);
      const waiter = waiters.get(event.type);
      return waiter ? Deferred.succeed(waiter, event).pipe(Effect.ignore) : Effect.void;
    }).pipe(Effect.forkChild);
    return { events, waitFor };
  });

layer("KimiAdapterLive", (it) => {
  it.effect(
    "applies an advertised model and the full-access mode, and never sends an unknown model",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KimiAdapter;
        const settings = yield* ServerSettingsService;
        const mock = yield* Effect.promise(() => makeMockKimi());
        yield* settings.updateSettings({ providers: { kimi: { binaryPath: mock.wrapperPath } } });

        const known = yield* adapter.startSession({
          threadId: ThreadId.make("kimi-model-known"),
          provider: KIMI_DRIVER,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: KIMI_INSTANCE, model: "probe/kimi-for-coding" },
        });
        assert.equal(known.model, "probe/kimi-for-coding");
        assert.deepStrictEqual(known.resumeCursor, { schemaVersion: 1, sessionId: "session_mock" });

        const unknown = yield* adapter.startSession({
          threadId: ThreadId.make("kimi-model-unknown"),
          provider: KIMI_DRIVER,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId: KIMI_INSTANCE, model: "kimi-code/not-a-model" },
        });
        // The session keeps the CLI's own default and says so.
        assert.equal(unknown.model, "probe/k3");

        const writes = configWrites(yield* Effect.promise(() => readLog(mock.logPath)));
        assert.deepInclude(writes, {
          sessionId: "session_mock",
          configId: "model",
          value: "probe/kimi-for-coding",
        });
        assert.deepInclude(writes, { sessionId: "session_mock", configId: "mode", value: "yolo" });
        assert.isFalse(writes.some((write) => write.value === "kimi-code/not-a-model"));

        yield* adapter.stopAll();
      }),
  );

  it.effect("routes AskUserQuestion to the person even in full access", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const mock = yield* Effect.promise(() => makeMockKimi());
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: mock.wrapperPath } } });
      const threadId = ThreadId.make("kimi-question");
      const watch = yield* watchThread(adapter, threadId);

      yield* adapter.startSession({
        threadId,
        provider: KIMI_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "ask", attachments: [] })
        .pipe(Effect.forkChild);

      const requested = yield* watch.waitFor("user-input.requested");
      assert.equal(requested.type, "user-input.requested");
      if (requested.type === "user-input.requested") {
        assert.equal(requested.payload.questions[0]?.question, "Which color?");
        assert.deepStrictEqual(
          requested.payload.questions[0]?.options.map((option) => option.label),
          ["Red", "Blue"],
        );
      }
      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requested.requestId)),
        {
          "kimi-question": "Blue",
        },
      );
      yield* Fiber.join(turn);

      const responses = permissionResponses(yield* Effect.promise(() => readLog(mock.logPath)));
      assert.deepStrictEqual(responses, [
        { outcome: { outcome: "selected", optionId: "q0_opt_1" } },
      ]);
      yield* adapter.stopAll();
    }),
  );

  it.effect("answers an approval with Kimi's own option id", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const mock = yield* Effect.promise(() => makeMockKimi());
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: mock.wrapperPath } } });
      const threadId = ThreadId.make("kimi-approval");
      const watch = yield* watchThread(adapter, threadId);

      yield* adapter.startSession({
        threadId,
        provider: KIMI_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "approve", attachments: [] })
        .pipe(Effect.forkChild);

      const opened = yield* watch.waitFor("request.opened");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      yield* Fiber.join(turn);

      // The shared ACP helper would have sent "allow-once", which Kimi rejects.
      const responses = permissionResponses(yield* Effect.promise(() => readLog(mock.logPath)));
      assert.deepStrictEqual(responses, [
        { outcome: { outcome: "selected", optionId: "approve_once" } },
      ]);
      yield* adapter.stopAll();
    }),
  );

  it.effect("captures an ExitPlanMode plan and ends Kimi's turn instead of approving it", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const mock = yield* Effect.promise(() => makeMockKimi());
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: mock.wrapperPath } } });
      const threadId = ThreadId.make("kimi-plan");
      const watch = yield* watchThread(adapter, threadId);

      yield* adapter.startSession({
        threadId,
        provider: KIMI_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan",
        attachments: [],
        interactionMode: "plan",
      });

      const proposed = yield* watch.waitFor("turn.proposed.completed");
      if (proposed.type === "turn.proposed.completed") {
        assert.equal(proposed.payload.planMarkdown, "# Plan\n\n1. Ship it");
      }
      const completed = yield* watch.waitFor("turn.completed");
      if (completed.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
      }
      const log = yield* Effect.promise(() => readLog(mock.logPath));
      assert.deepInclude(configWrites(log), {
        sessionId: "session_mock",
        configId: "mode",
        value: "plan",
      });
      assert.deepStrictEqual(permissionResponses(log), [
        { outcome: { outcome: "selected", optionId: "solla_plan_captured" } },
      ]);
      yield* adapter.stopAll();
    }),
  );

  it.effect("reports a turn that ended with no output as failed", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const mock = yield* Effect.promise(() => makeMockKimi());
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: mock.wrapperPath } } });
      const threadId = ThreadId.make("kimi-silent");
      const watch = yield* watchThread(adapter, threadId);

      yield* adapter.startSession({
        threadId,
        provider: KIMI_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "silent", attachments: [] });
      const silent = yield* watch.waitFor("turn.completed");
      if (silent.type === "turn.completed") {
        assert.equal(silent.payload.state, "failed");
        assert.equal(silent.payload.errorMessage, KIMI_EMPTY_TURN_MESSAGE);
      }

      yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
      const completed = watch.events.filter((event) => event.type === "turn.completed");
      assert.equal(completed.length, 2);
      const last = completed[1];
      if (last?.type === "turn.completed") {
        assert.equal(last.payload.state, "completed");
      }
      yield* adapter.stopAll();
    }),
  );

  it.effect("reports the plan usage Kimi just refreshed after each turn", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const mock = yield* Effect.promise(() => makeMockKimi());
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: mock.wrapperPath } } });
      const threadId = ThreadId.make("kimi-usage");
      const watch = yield* watchThread(adapter, threadId);

      yield* adapter.startSession({
        threadId,
        provider: KIMI_DRIVER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
      const usage = yield* watch.waitFor("account.rate-limits.updated");
      if (usage.type === "account.rate-limits.updated") {
        assert.deepStrictEqual(usage.payload.rateLimits, KIMI_USAGE_READING);
        assert.equal(String(usage.turnId), String(turn.turnId));
        assert.equal(String(usage.providerInstanceId), "kimi");
      }
      yield* adapter.stopAll();
    }),
  );

  it.effect("says how to sign in when Kimi is signed out", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const mock = yield* Effect.promise(() => makeMockKimi({ KIMI_MOCK_SIGNED_OUT: "1" }));
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: mock.wrapperPath } } });

      const exit = yield* adapter
        .startSession({
          threadId: ThreadId.make("kimi-signed-out"),
          provider: KIMI_DRIVER,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.include(String(exit.cause), KIMI_NOT_SIGNED_IN_MESSAGE);
      }
    }),
  );
});

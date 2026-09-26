// @effect-diagnostics nodeBuiltinImport:off - Standalone Node smoke runner owns its disposable fixture and evidence files.
/** Opt-in network smoke: node apps/server/integration/opencode-free-smoke.ts */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OpenCodeSettings,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ServerConfig } from "../src/config.ts";
import { OpenCodeRuntime, OpenCodeRuntimeLive } from "../src/provider/opencodeRuntime.ts";
import { makeOpenCodeAdapter } from "../src/provider/Layers/OpenCodeAdapter.ts";
import { decideWithJev } from "../src/mcp/toolkits/jev/client.ts";

if (process.env.SOLLA_RUN_FREE_OPENCODE_SMOKE !== "1") {
  throw new Error("This makes free network requests. Set SOLLA_RUN_FREE_OPENCODE_SMOKE=1 to run.");
}
const decodeSettings = Schema.decodeUnknownEffect(OpenCodeSettings);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-opencode-free-"));
const cwd = NodePath.join(root, "workspace");
const configDir = NodePath.join(root, "config");
await NodeFSP.mkdir(cwd);
await NodeFSP.mkdir(NodePath.join(configDir, "opencode"), { recursive: true });
const model = "opencode/big-pickle";
await NodeFSP.writeFile(
  NodePath.join(configDir, "opencode", "opencode.json"),
  JSON.stringify({
    model,
    small_model: model,
    share: "disabled",
    enabled_providers: ["opencode"],
  }),
);
await NodeFSP.writeFile(NodePath.join(cwd, "sum.js"), "exports.add = (a, b) => a - b;\n");
await NodeFSP.writeFile(
  NodePath.join(cwd, "sum.test.js"),
  'const {test}=require("node:test"); const assert=require("node:assert/strict"); const {add}=require("./sum"); test("adds",()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1)});\n',
);
const environment = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: NodeOS.tmpdir(),
  XDG_CONFIG_HOME: configDir,
  XDG_DATA_HOME: NodePath.join(root, "data"),
  XDG_CACHE_HOME: NodePath.join(root, "cache"),
  XDG_STATE_HOME: NodePath.join(root, "state"),
};
const report = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
report({ root, model });
const seen: unknown[] = [];
const program = Effect.gen(function* () {
  const runtime = yield* OpenCodeRuntime;
  const inventory = yield* runtime.loadInventoryFromCli({ binaryPath: "opencode", environment });
  const selected = inventory.providerList.all.find((provider) => provider.id === "opencode")
    ?.models["big-pickle"];
  NodeAssert.ok(selected, "Free coding model must be in the live catalog");
  NodeAssert.deepEqual(
    selected.cost,
    { input: 0, output: 0, cache: { read: 0, write: 0 } },
    "Refuse to test a paid model",
  );
  const settings = yield* decodeSettings({ binaryPath: "opencode" });
  const adapter = yield* makeOpenCodeAdapter(settings, { environment });
  const threadId = ThreadId.make("opencode-free-smoke");
  yield* adapter.startSession({
    provider: ProviderDriverKind.make("opencode"),
    threadId,
    cwd,
    runtimeMode: "full-access",
    modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model },
  });
  for (const input of [
    "Work only in this disposable directory. Read sum.js and sum.test.js. Fix add so it adds correctly, then run node --test sum.test.js. Report the test result. Do not use the network or access other directories.",
    "Without changing files, tell me which function you just fixed and whether its test passed. Keep it brief.",
  ]) {
    const eventsFiber = yield* adapter.streamEvents.pipe(
      Stream.tap((event) => Effect.sync(() => seen.push(event))),
      Stream.takeUntil((event) => event.type === "turn.completed"),
      Stream.runCollect,
      Effect.forkChild,
    );
    const turn = yield* adapter.sendTurn({ threadId, input });
    const events = yield* Fiber.join(eventsFiber);
    const completion = events.find((event) => event.type === "turn.completed");
    NodeAssert.equal(completion?.turnId, turn.turnId);
    NodeAssert.equal(
      completion?.type === "turn.completed" && completion.payload.state,
      "completed",
    );
    NodeAssert.ok(events.some((event) => event.type === "content.delta"));
    const costs = events.filter((event) => event.type === "account.rate-limits.updated");
    NodeAssert.ok(costs.length > 0, "The real OpenCode session must report usage for the bar");
    for (const event of costs) {
      NodeAssert.partialDeepStrictEqual(event.payload.rateLimits, {
        source: "opencode-session",
        sessionCost: 0,
      });
    }
    report({ turnId: turn.turnId, eventTypes: events.map((event) => event.type) });
  }
  yield* adapter.stopAll();
  const jev = yield* decideWithJev({
    state: "The add function now returns a + b. Its tests passed.",
    questions: {
      passed: { type: "noul", instructions: "Did the tests pass?" },
      operation: {
        type: "choice",
        instructions: "What operation does the function perform?",
        criteria: { add: "Addition", subtract: "Subtraction" },
      },
      status: {
        type: "score",
        instructions: "How complete is this fix?",
        criteria: ["Broken", "Fixed but untested", "Fixed with passing tests"],
      },
    },
  });
  report({ jev });
  return jev;
}).pipe(
  Effect.scoped,
  Effect.timeout("180 seconds"),
  Effect.provide(
    OpenCodeRuntimeLive.pipe(
      Layer.provideMerge(ServerConfig.layerTest(cwd, NodePath.join(root, "solla"))),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);
try {
  const jev = await Effect.runPromise(program);
  const tests = NodeChildProcess.execFileSync(process.execPath, ["--test", "sum.test.js"], {
    cwd,
    encoding: "utf8",
  });
  process.stdout.write(tests);
  await NodeFSP.writeFile(
    NodePath.join(root, "result.json"),
    JSON.stringify(
      { jev, source: await NodeFSP.readFile(NodePath.join(cwd, "sum.js"), "utf8"), tests },
      null,
      2,
    ),
  );
} finally {
  await NodeFSP.writeFile(NodePath.join(root, "events.json"), JSON.stringify(seen, null, 2));
  process.stdout.write(`Evidence retained in ${root}\n`);
}

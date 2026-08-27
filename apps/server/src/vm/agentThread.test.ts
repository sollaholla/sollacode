import { AGENT_BUILDER_THREAD_ID, type OrchestrationCommand, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ServerConfig from "../config.ts";
import {
  agentWorkingDirectoryName,
  createAgentThread,
  notifyAgentBlockerResolved,
  openAgentBuilderThread,
} from "./agentThread.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-agent-thread-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

/** Mock engine that records commands and rejects repeats of create commands. */
const makeEngine = () => {
  const dispatched: OrchestrationCommand[] = [];
  const createdAggregates = new Set<string>();
  const layer = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
    dispatch: (command) =>
      Effect.gen(function* () {
        if (command.type === "project.create" || command.type === "thread.create") {
          const key =
            command.type === "project.create"
              ? `project:${command.projectId}`
              : `thread:${command.threadId}`;
          if (createdAggregates.has(key)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `${key} already exists`,
            });
          }
          createdAggregates.add(key);
        }
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  });
  return { dispatched, layer };
};

it.effect("opens one persistent builder thread, greeting exactly once", () =>
  Effect.gen(function* () {
    const engine = makeEngine();
    const run = openAgentBuilderThread.pipe(Effect.provide(Layer.merge(engine.layer, configLayer)));

    const first = yield* run;
    assert.strictEqual(first, AGENT_BUILDER_THREAD_ID);
    const firstTypes = engine.dispatched.map((command) => command.type);
    assert.include(firstTypes, "thread.create");
    assert.include(firstTypes, "thread.message.assistant.complete");
    // Opening never starts a turn — the user writes the first prompt with
    // whatever model the composer has selected.
    assert.notInclude(firstTypes, "thread.turn.start");

    const before = engine.dispatched.length;
    const second = yield* run;
    assert.strictEqual(second, AGENT_BUILDER_THREAD_ID);
    // The repeat run creates nothing and greets nobody.
    const repeatTypes = engine.dispatched.slice(before).map((command) => command.type);
    assert.deepStrictEqual(repeatTypes, []);
  }),
);

it.effect("creates every agent thread in its own readable working directory", () => {
  const engine = makeEngine();
  return Effect.gen(function* () {
    const threadId = yield* createAgentThread("Fleet Scout");
    assert.isNotNull(threadId);

    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const threadCreate = engine.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
        command.type === "thread.create",
    );
    const expected = path.join(
      config.agentsWorkspaceDir,
      agentWorkingDirectoryName("Fleet Scout", threadId!),
    );
    assert.strictEqual(threadCreate?.worktreePath, expected);
    assert.isTrue(yield* fs.exists(expected));
    assert.isTrue(yield* fs.exists(path.join(expected, "AGENTS.md")));
    assert.strictEqual(yield* fs.readFileString(path.join(expected, "CLAUDE.md")), "@AGENTS.md\n");
  }).pipe(Effect.provide(Layer.merge(engine.layer, configLayer)));
});

it.effect("sends resolved and dismissed blocker outcomes to the agent as follow-up turns", () =>
  Effect.gen(function* () {
    const engine = makeEngine();
    const threadId = ThreadId.make("thread-waiting-on-user");
    const notify = (resolvedBy: "user" | "dismissed") =>
      notifyAgentBlockerResolved({
        threadId,
        title: "Sign in to the dashboard",
        resolvedBy,
      }).pipe(Effect.provide(engine.layer));

    yield* notify("user");
    yield* notify("dismissed");

    const turns = engine.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0]?.threadId, threadId);
    assert.strictEqual(turns[0]?.message.inputOrigin, "agent-loop");
    assert.include(turns[0]?.message.text ?? "", "The user resolved the request");
    assert.include(turns[1]?.message.text ?? "", "dismissed the request");
  }),
);

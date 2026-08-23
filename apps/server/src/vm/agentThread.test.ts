import { AGENT_BUILDER_THREAD_ID, type OrchestrationCommand } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ServerConfig from "../config.ts";
import { openAgentBuilderThread } from "./agentThread.ts";

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
    const run = openAgentBuilderThread.pipe(
      Effect.provide(engine.layer),
      Effect.provide(configLayer),
    );

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

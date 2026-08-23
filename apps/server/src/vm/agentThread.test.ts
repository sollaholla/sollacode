import { ProviderInstanceId, type OrchestrationCommand } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ServerConfig from "../config.ts";
import { agentBuilderThreadTitle, createAgentBuilderThread } from "./agentThread.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-agent-thread-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeEngine = () => {
  const dispatched: OrchestrationCommand[] = [];
  const layer = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  });
  return { dispatched, layer };
};

it.effect(
  "builder chats create the thread before starting the turn — the engine has no bootstrap",
  () =>
    Effect.gen(function* () {
      const engine = makeEngine();
      const threadId = yield* createAgentBuilderThread({
        prompt: "Watch the fleet dashboards every morning.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      }).pipe(Effect.provide(engine.layer), Effect.provide(configLayer));

      assert.isTrue(threadId.startsWith("agent-builder:"));
      const types = engine.dispatched.map((command) => command.type);
      // The ws layer decomposes bootstrap.createThread; the engine's decider
      // rejects thread.turn.start for a thread that does not exist. This pins
      // the explicit create-then-turn sequence that replaced the bootstrap.
      const createIndex = types.indexOf("thread.create");
      const turnIndex = types.indexOf("thread.turn.start");
      assert.isAbove(createIndex, -1);
      assert.isAbove(turnIndex, createIndex);

      const create = engine.dispatched[createIndex];
      const turn = engine.dispatched[turnIndex];
      assert.strictEqual(create?.type === "thread.create" ? create.threadId : null, threadId);
      assert.strictEqual(turn?.type === "thread.turn.start" ? turn.threadId : null, threadId);
      assert.isFalse("bootstrap" in (turn as object));
      if (turn?.type === "thread.turn.start") {
        assert.include(turn.message.text, "Watch the fleet dashboards every morning.");
        assert.strictEqual(turn.runtimeMode, "full-access");
      }
    }),
);

it("derives a readable single-line title from the prompt", () => {
  assert.strictEqual(agentBuilderThreadTitle("Watch my repos\nand more"), "Watch my repos");
  assert.strictEqual(agentBuilderThreadTitle("   "), "Agent Builder");
  const long = agentBuilderThreadTitle(`${"word ".repeat(30)}end`);
  assert.isAtMost(long.length, 60);
  assert.isTrue(long.endsWith("…"));
});

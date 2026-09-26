import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type ModelAccessPolicy,
} from "@t3tools/contracts";
import { modelPolicyError, resolveThreadModelPolicies } from "./modelAccessPolicy.ts";

const model = { instanceId: ProviderInstanceId.make("opencode"), model: "opencode/big-pickle" };
const block: ModelAccessPolicy = { mode: "block", models: [model] };
const makeLookup = (parents: Record<string, string | null>) => (id: ThreadId) =>
  Effect.succeed(
    Object.hasOwn(parents, id)
      ? Option.some({ id, sideChatParentThreadId: parents[id] } as OrchestrationThreadShell)
      : Option.none<OrchestrationThreadShell>(),
  );

it.effect("resolves existing nested side chats against the live parent rule", () =>
  Effect.gen(function* () {
    const policies = yield* resolveThreadModelPolicies({
      threadId: ThreadId.make("nested"),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        threadModelPolicies: { root: block, nested: { mode: "all", models: [] } },
      },
      getThread: makeLookup({ nested: "side", side: "root", root: null }),
    });
    expect(modelPolicyError(policies, model)).toContain("blocked");
  }),
);
it.effect("the global rule affects fallback only", () =>
  Effect.gen(function* () {
    const input = {
      threadId: ThreadId.make("root"),
      settings: { ...DEFAULT_SERVER_SETTINGS, fallbackModelPolicy: block },
      getThread: makeLookup({ root: null }),
    };
    expect(modelPolicyError(yield* resolveThreadModelPolicies(input), model)).toBeNull();
    expect(
      modelPolicyError(yield* resolveThreadModelPolicies({ ...input, fallback: true }), model),
    ).toContain("blocked");
  }),
);
for (const parents of [{ side: "missing" }, { side: "side" }]) {
  it.effect(`fails closed for broken inheritance ${parents.side}`, () =>
    Effect.gen(function* () {
      const policies = yield* resolveThreadModelPolicies({
        threadId: ThreadId.make("side"),
        settings: { ...DEFAULT_SERVER_SETTINGS, threadModelPolicies: { root: block } },
        getThread: makeLookup(parents),
      });
      expect(modelPolicyError(policies, model)).toContain("blocked");
    }),
  );
}
it.effect("does not turn a settings or ancestry lookup failure into permission", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      resolveThreadModelPolicies({
        threadId: ThreadId.make("side"),
        settings: { ...DEFAULT_SERVER_SETTINGS, threadModelPolicies: { root: block } },
        getThread: () => Effect.fail("unavailable"),
      }),
    );
    expect(result._tag).toBe("Failure");
  }),
);

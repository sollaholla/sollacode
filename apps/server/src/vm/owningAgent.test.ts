import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveOwningVmAgent } from "./owningAgent.ts";

const agent = { vmAgentId: "agent-1", name: "Personal Assistant" } as never;
const agentThread = ThreadId.make("agent-thread");
const sideChat = ThreadId.make("side-chat");
const nested = ThreadId.make("nested-side-chat");
const plain = ThreadId.make("plain-thread");

const parents = new Map<string, string | null>([
  [agentThread, null],
  [sideChat, agentThread],
  [nested, sideChat],
  [plain, null],
]);

const harness = {
  getAgentByThreadId: (threadId: string) =>
    Effect.succeed(threadId === agentThread ? Option.some(agent) : Option.none()),
  getThreadShellById: (threadId: ThreadId) =>
    Effect.succeed(
      parents.has(threadId)
        ? Option.some({ id: threadId, sideChatParentThreadId: parents.get(threadId) } as never)
        : Option.none(),
    ),
};

describe("resolveOwningVmAgent", () => {
  it.effect("returns the agent for its own chat", () =>
    Effect.gen(function* () {
      const found = yield* resolveOwningVmAgent({ threadId: agentThread, ...harness });
      assert.isTrue(Option.isSome(found));
    }),
  );

  it.effect("walks a side chat (and a nested one) up to the owning agent", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isSome(yield* resolveOwningVmAgent({ threadId: sideChat, ...harness })));
      assert.isTrue(Option.isSome(yield* resolveOwningVmAgent({ threadId: nested, ...harness })));
    }),
  );

  it.effect("stays none for a plain thread and an unknown thread", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* resolveOwningVmAgent({ threadId: plain, ...harness })));
      assert.isTrue(
        Option.isNone(
          yield* resolveOwningVmAgent({ threadId: ThreadId.make("missing"), ...harness }),
        ),
      );
    }),
  );

  it.effect("terminates on a parent cycle", () =>
    Effect.gen(function* () {
      const a = ThreadId.make("a");
      const b = ThreadId.make("b");
      const cyclic = new Map<string, string>([
        [a, b],
        [b, a],
      ]);
      const found = yield* resolveOwningVmAgent({
        threadId: a,
        getAgentByThreadId: () => Effect.succeed(Option.none()),
        getThreadShellById: (id) =>
          Effect.succeed(Option.some({ id, sideChatParentThreadId: cyclic.get(id) } as never)),
      });
      assert.isTrue(Option.isNone(found));
    }),
  );
});

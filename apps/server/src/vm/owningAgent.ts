import type { OrchestrationThreadShell, ThreadId, VmAgent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Longest side-chat chain we are willing to walk before giving up. */
const MAX_HOPS = 8;

/**
 * Resolve the custom agent that owns a thread: the agent whose dedicated chat
 * this is, or — for a side chat forked from an agent's chat (at any depth) —
 * the agent at the top of the side-chat chain. Side chats share the agent's
 * browser and its consulting rights, so tools that gate on "is this an agent
 * thread" must look through the chain rather than at the thread id alone.
 */
export const resolveOwningVmAgent = <E1, E2>(input: {
  readonly threadId: ThreadId;
  readonly getAgentByThreadId: (threadId: string) => Effect.Effect<Option.Option<VmAgent>, E1>;
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, E2>;
}): Effect.Effect<Option.Option<VmAgent>, E1 | E2> =>
  Effect.gen(function* () {
    const visited = new Set<string>();
    let current: ThreadId = input.threadId;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (visited.has(current)) break;
      visited.add(current);
      const agent = yield* input.getAgentByThreadId(current);
      if (Option.isSome(agent)) return agent;
      const shell = yield* input.getThreadShellById(current);
      if (Option.isNone(shell)) break;
      const parent = shell.value.sideChatParentThreadId;
      if (parent === undefined || parent === null) break;
      current = parent;
    }
    return Option.none<VmAgent>();
  });

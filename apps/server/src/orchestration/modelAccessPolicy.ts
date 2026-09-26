import {
  ThreadId,
  type ModelAccessPolicy,
  type ModelSelection,
  type OrchestrationThreadShell,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { modelAccessPoliciesAllow } from "@t3tools/shared/modelAccessPolicy";

/** Resolve live ancestry on every admission so changes cover existing side chats too. */
export const resolveThreadModelPolicies = <E>(input: {
  threadId: ThreadId;
  settings: Pick<ServerSettings, "threadModelPolicies" | "fallbackModelPolicy">;
  fallback?: boolean;
  getThread: (id: ThreadId) => Effect.Effect<Option.Option<OrchestrationThreadShell>, E>;
}) =>
  Effect.gen(function* () {
    const policies: ModelAccessPolicy[] = input.fallback
      ? [input.settings.fallbackModelPolicy]
      : [];
    if (Object.keys(input.settings.threadModelPolicies).length === 0) return policies;
    const visited = new Set<string>();
    let id: ThreadId | null = input.threadId;
    while (id !== null) {
      if (visited.has(id) || visited.size >= 64)
        return [...policies, { mode: "allow", models: [] } satisfies ModelAccessPolicy];
      visited.add(id);
      const policy = input.settings.threadModelPolicies[id];
      if (policy) policies.push(policy);
      const thread: Option.Option<OrchestrationThreadShell> = yield* input.getThread(id);
      if (Option.isNone(thread))
        return [...policies, { mode: "allow", models: [] } satisfies ModelAccessPolicy];
      id = thread.value.sideChatParentThreadId ?? null;
    }
    return policies;
  });

export function modelPolicyError(
  policies: ReadonlyArray<ModelAccessPolicy>,
  selection: ModelSelection,
): string | null {
  return modelAccessPoliciesAllow(policies, selection)
    ? null
    : `Model ${selection.model} on ${selection.instanceId} is blocked by this thread or its parent agent's model restrictions. Choose an allowed model or update Model restrictions.`;
}

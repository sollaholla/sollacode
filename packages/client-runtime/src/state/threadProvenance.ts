import {
  isAgentBuilderThreadId,
  isAgentsProjectId,
  isOrchestratorThreadId,
  parseRemoteThreadId,
  type EnvironmentId,
  type OrchestrationThreadShell,
  type ScopedThreadRef,
  type ThreadId,
  type VmAgent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { parseThreadKey, threadKey } from "./entities.ts";
import type { VmAgentRegistryView } from "./vmAgents.ts";

/** Side-chat hops followed from a creating chat up to the chat that owns it. */
const MAX_CREATOR_HOPS = 8;

export type ThreadCreatorShell = Pick<
  OrchestrationThreadShell,
  "id" | "projectId" | "title" | "isSideChat" | "sideChatParentThreadId"
>;

/**
 * Where a message's sender lives: a chat on the same computer as the message,
 * or, for a message that came from another computer, the chat there.
 */
export function resolveSenderThreadRef(
  environmentId: EnvironmentId,
  senderThreadId: ThreadId,
): ScopedThreadRef {
  const remote = parseRemoteThreadId(senderThreadId);
  return remote === null
    ? { environmentId, threadId: senderThreadId }
    : { environmentId: remote.environmentId, threadId: remote.threadId };
}

/**
 * Names the chat that opened a thread (its `createdByThreadId`) for the
 * provenance chip: the Orchestrator only when the orchestrator thread itself
 * opened it, the agent that owns the creating chat (its own chat, one of its
 * side chats or a delegated worker), else the creating chat by title. An
 * orchestrator side chat is named by its own title, as the server stamps it.
 * Agents are read only when the walk ends in the agents project, so a thread
 * opened by an ordinary chat never needs the agent registry.
 */
export function resolveThreadCreatorLabel(input: {
  readonly createdByThreadId: ThreadId;
  readonly readThread: (threadId: ThreadId) => ThreadCreatorShell | null;
  readonly readAgents: () => ReadonlyArray<Pick<VmAgent, "threadId" | "name">>;
}): string {
  if (isOrchestratorThreadId(input.createdByThreadId)) return "Created by the Orchestrator";
  if (parseRemoteThreadId(input.createdByThreadId) !== null) {
    return "Created by a chat on another computer";
  }
  const creator = input.readThread(input.createdByThreadId);
  if (creator === null) return "Created by another chat";

  let root = creator;
  const visited = new Set<ThreadId>([root.id]);
  for (let hop = 0; hop < MAX_CREATOR_HOPS; hop += 1) {
    const parentId = root.isSideChat === true ? root.sideChatParentThreadId : null;
    if (parentId == null || visited.has(parentId)) break;
    const parent = input.readThread(parentId);
    if (parent === null) break;
    visited.add(parent.id);
    root = parent;
  }

  if (isAgentsProjectId(root.projectId) && !isAgentBuilderThreadId(root.id)) {
    const agent = input.readAgents().find((candidate) => candidate.threadId === root.id);
    if (agent !== undefined) return `Created by ${agent.name}`;
  }
  return `Created by “${creator.title}”`;
}

/**
 * One derived label per creating chat, shared by every thread it opened. The
 * value is a string, so rows re-render only when the name itself changes, not
 * on every turn of the creating chat or agent registry update.
 */
export function createThreadCreatorLabelAtoms(input: {
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<ThreadCreatorShell | null>;
  readonly agentsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<VmAgentRegistryView, unknown>>;
}) {
  const labelAtomFamily = Atom.family((key: string) => {
    const creatorRef = parseThreadKey(key);
    return Atom.make((get) =>
      resolveThreadCreatorLabel({
        createdByThreadId: creatorRef.threadId,
        readThread: (threadId) =>
          get(input.threadShellAtom({ environmentId: creatorRef.environmentId, threadId })),
        readAgents: () =>
          Option.match(AsyncResult.value(get(input.agentsAtom(creatorRef.environmentId))), {
            onNone: () => [],
            onSome: (view) => view.agents,
          }),
      }),
    ).pipe(Atom.withLabel(`thread-creator-label:${key}`));
  });
  return (creatorRef: ScopedThreadRef) => labelAtomFamily(threadKey(creatorRef));
}

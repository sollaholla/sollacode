import {
  AGENT_BUILDER_THREAD_ID,
  AGENTS_PROJECT_ID,
  EnvironmentId,
  ORCHESTRATOR_PROJECT_ID,
  ORCHESTRATOR_THREAD_ID,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createThreadCreatorLabelAtoms,
  resolveThreadCreatorLabel,
  type ThreadCreatorShell,
} from "./threadProvenance.ts";
import type { VmAgentRegistryView } from "./vmAgents.ts";

const PROJECT_ID = ProjectId.make("project-1");
const AGENT_THREAD_ID = ThreadId.make("agent-thread");

const shell = (
  id: ThreadId,
  title: string,
  options: { readonly projectId?: ProjectId; readonly parent?: ThreadId } = {},
): ThreadCreatorShell => ({
  id,
  projectId: options.projectId ?? PROJECT_ID,
  title,
  isSideChat: options.parent !== undefined,
  sideChatParentThreadId: options.parent ?? null,
});

const AGENTS = [{ threadId: AGENT_THREAD_ID, name: "Scout" }];

function labelFor(
  createdByThreadId: ThreadId,
  threads: ReadonlyArray<ThreadCreatorShell>,
  agents: ReadonlyArray<{ readonly threadId: ThreadId | null; readonly name: string }> = AGENTS,
) {
  let agentReads = 0;
  const label = resolveThreadCreatorLabel({
    createdByThreadId,
    readThread: (threadId) => threads.find((thread) => thread.id === threadId) ?? null,
    readAgents: () => {
      agentReads += 1;
      return agents;
    },
  });
  return { label, agentReads };
}

describe("resolveThreadCreatorLabel", () => {
  it("names an ordinary creating chat by title without reading agents", () => {
    const creator = ThreadId.make("chat-1");
    expect(labelFor(creator, [shell(creator, "Fix the login bug")])).toEqual({
      label: "Created by “Fix the login bug”",
      agentReads: 0,
    });
  });

  it("names the agent for its own chat, its side chats and its delegated workers", () => {
    const sideChat = ThreadId.make("agent-side-chat");
    const worker = ThreadId.make("delegation-worker:1");
    const threads = [
      shell(AGENT_THREAD_ID, "Old agent title", { projectId: AGENTS_PROJECT_ID }),
      shell(sideChat, "Side chat", { projectId: AGENTS_PROJECT_ID, parent: AGENT_THREAD_ID }),
      shell(worker, "Worker", { projectId: AGENTS_PROJECT_ID, parent: sideChat }),
    ];
    expect(labelFor(AGENT_THREAD_ID, threads).label).toBe("Created by Scout");
    expect(labelFor(sideChat, threads).label).toBe("Created by Scout");
    expect(labelFor(worker, threads).label).toBe("Created by Scout");
  });

  it("falls back to the chat title until the agent registry knows the agent", () => {
    const threads = [shell(AGENT_THREAD_ID, "Scout", { projectId: AGENTS_PROJECT_ID })];
    expect(labelFor(AGENT_THREAD_ID, threads, []).label).toBe("Created by “Scout”");
  });

  it("names the Orchestrator and Agent Builder, and a creator it cannot see", () => {
    expect(labelFor(ORCHESTRATOR_THREAD_ID, []).label).toBe("Created by the Orchestrator");
    expect(
      labelFor(AGENT_BUILDER_THREAD_ID, [
        shell(AGENT_BUILDER_THREAD_ID, "Agent Builder", { projectId: AGENTS_PROJECT_ID }),
      ]),
    ).toEqual({ label: "Created by “Agent Builder”", agentReads: 0 });
    expect(labelFor(ThreadId.make("deleted"), []).label).toBe("Created by another chat");
  });

  it("names an orchestrator side chat by its own title, not as the Orchestrator", () => {
    const sideChat = ThreadId.make("orchestrator-side-chat");
    expect(
      labelFor(sideChat, [
        shell(ORCHESTRATOR_THREAD_ID, "Orchestrator", { projectId: ORCHESTRATOR_PROJECT_ID }),
        shell(sideChat, "Check the deploy", {
          projectId: ORCHESTRATOR_PROJECT_ID,
          parent: ORCHESTRATOR_THREAD_ID,
        }),
      ]),
    ).toEqual({ label: "Created by “Check the deploy”", agentReads: 0 });
  });

  it("stops on a side-chat cycle", () => {
    const first = ThreadId.make("first");
    const second = ThreadId.make("second");
    expect(
      labelFor(first, [
        shell(first, "First", { parent: second }),
        shell(second, "Second", { parent: first }),
      ]).label,
    ).toBe("Created by “First”");
  });
});

describe("createThreadCreatorLabelAtoms", () => {
  it("relabels when the agent registry loads, and only for a new name", () => {
    const environmentId = EnvironmentId.make("env-1");
    const threadsAtom = Atom.make<ReadonlyArray<ThreadCreatorShell>>([
      shell(AGENT_THREAD_ID, "Scout", { projectId: AGENTS_PROJECT_ID }),
    ]);
    const agentsAtom = Atom.make<AsyncResult.AsyncResult<VmAgentRegistryView, unknown>>(
      AsyncResult.initial(true),
    );
    const labelAtom = createThreadCreatorLabelAtoms({
      threadShellAtom: (ref) =>
        Atom.make((get) => get(threadsAtom).find((thread) => thread.id === ref.threadId) ?? null),
      agentsAtom: () => agentsAtom,
    });
    const registry = AtomRegistry.make();
    const atom = labelAtom({ environmentId, threadId: AGENT_THREAD_ID });
    const seen: string[] = [];
    const unsubscribe = registry.subscribe(atom, (label) => seen.push(label), {
      immediate: true,
    });

    registry.set(
      agentsAtom,
      AsyncResult.success({
        type: "snapshot",
        agents: [{ threadId: AGENT_THREAD_ID, name: "Scout Prime" }],
      } as unknown as VmAgentRegistryView),
    );
    registry.set(threadsAtom, [
      { ...shell(AGENT_THREAD_ID, "Scout", { projectId: AGENTS_PROJECT_ID }) },
    ]);

    expect(seen).toEqual(["Created by “Scout”", "Created by Scout Prime"]);
    unsubscribe();
    registry.dispose();
  });
});

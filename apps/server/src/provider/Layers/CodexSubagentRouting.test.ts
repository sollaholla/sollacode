import { describe, expect, it } from "vite-plus/test";
import { TurnId } from "@t3tools/contracts";
import {
  codexBackgroundStopTarget,
  codexBackgroundTaskId,
  routeCodexBackgroundNotification,
  updateCodexBackgroundTaskMetadata,
  type CodexBackgroundTask,
} from "./CodexSubagentRouting.ts";

// Native IDs observed in the affected root and v2 /root/image_read_preview rollout.
const root = "01a09b21-fb04-7cd0-aa43-f2426bc8114b";
const child = "01a09c4d-262a-77e1-81cf-fc2aebe9fcd2";
function harness() {
  const tasks = new Map<string, CodexBackgroundTask>();
  const route = (method: string, params: unknown) =>
    routeCodexBackgroundNotification({
      rootProviderThreadId: root,
      rootTurnId: TurnId.make("root-turn"),
      method,
      params,
      tasks,
    });
  return { route, tasks };
}

describe("Codex background conversation routing", () => {
  it("fails closed for scoped events before startup binds the root identity", () => {
    expect(
      routeCodexBackgroundNotification({
        rootProviderThreadId: undefined,
        rootTurnId: undefined,
        method: "item/agentMessage/delta",
        params: { threadId: child, delta: "early child" },
        tasks: new Map(),
      }),
    ).toBeNull();
  });

  it("isolates v2 child traffic without old collab receiver registration", () => {
    const { route, tasks } = harness();
    expect(
      route("item/agentMessage/delta", {
        threadId: child,
        turnId: "child-turn",
        itemId: "msg",
        delta: "CHILD PRIVATE TOKENS",
      }),
    ).toMatchObject({
      discovered: true,
      providerThreadId: child,
      status: "running",
      parentTurnId: "root-turn",
    });
    expect(
      route("item/agentMessage/delta", {
        threadId: child,
        turnId: "child-turn",
        itemId: "msg",
        delta: "MORE PRIVATE TOKENS",
      }),
    ).toBeNull();
    expect(
      route("item/reasoning/textDelta", {
        threadId: child,
        turnId: "child-turn",
        itemId: "thought",
        delta: "PRIVATE REASONING",
      }),
    ).toBeNull();
    expect(
      route("item/commandExecution/outputDelta", {
        threadId: child,
        turnId: "child-turn",
        itemId: "cmd",
        delta: "PRIVATE COMMAND OUTPUT",
      }),
    ).toBeNull();
    expect(JSON.stringify([...tasks.values()])).not.toContain("PRIVATE");
  });
  it("reports child current work, real cumulative tokens and completion under one background task", () => {
    const { route } = harness();
    expect(
      route("thread/started", {
        thread: {
          id: child,
          agentNickname: "James",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: root,
                depth: 1,
                agent_path: "/root/image_read_preview",
              },
            },
          },
        },
      }),
    ).toMatchObject({ title: "Codex subagent /root/image_read_preview" });
    expect(route("turn/started", { threadId: child, turn: { id: "child-turn" } })).toMatchObject({
      status: "running",
      nativeTurnId: "child-turn",
    });
    expect(
      route("item/started", {
        threadId: child,
        turnId: "child-turn",
        item: { id: "cmd", type: "commandExecution", command: "sensitive command text" },
      }),
    ).toMatchObject({ lastToolName: "command", summary: "Running command" });
    expect(
      route("thread/tokenUsage/updated", {
        threadId: child,
        tokenUsage: { total: { totalTokens: 1234 }, last: { totalTokens: 12 } },
      }),
    ).toMatchObject({ totalTokens: 1234 });
    expect(
      route("thread/tokenUsage/updated", {
        threadId: child,
        tokenUsage: { total: { totalTokens: 1234 } },
      }),
    ).toMatchObject({ totalTokens: 1234 });
    route("item/completed", {
      threadId: child,
      turnId: "child-turn",
      item: { id: "msg", type: "agentMessage", text: "Child finished its image work." },
    });
    expect(
      route("turn/completed", { threadId: child, turn: { id: "child-turn", status: "completed" } }),
    ).toMatchObject({
      status: "completed",
      summary: "Child finished its image work.",
      totalTokens: 1234,
    });
    expect(
      route("thread/tokenUsage/updated", {
        threadId: child,
        tokenUsage: { total: { totalTokens: 1240 } },
      }),
    ).toMatchObject({ status: "completed", totalTokens: 1240 });
  });
  it("does not advertise a resumed idle child as running and preserves its name for the next turn", () => {
    const { route } = harness();
    expect(
      route("thread/started", {
        thread: { id: child, name: "Image verification", status: { type: "idle" } },
      }),
    ).toBeNull();
    expect(
      route("turn/started", { threadId: child, turn: { id: "new-child-turn" } }),
    ).toMatchObject({
      discovered: true,
      title: "Codex subagent Image verification",
      status: "running",
    });
  });

  it("announces discovery once and announces a later explicit run once", () => {
    const { route } = harness();
    expect(route("thread/started", { thread: { id: child } })).toMatchObject({ discovered: true });
    const initial = route("turn/started", { threadId: child, turn: { id: "first" } });
    expect(initial).not.toHaveProperty("discovered");
    expect(initial).not.toHaveProperty("started");
    route("turn/completed", { threadId: child, turn: { id: "first", status: "completed" } });
    expect(route("turn/started", { threadId: child, turn: { id: "second" } })).toMatchObject({
      started: true,
    });
    expect(route("turn/started", { threadId: child, turn: { id: "second" } })).not.toHaveProperty(
      "started",
    );
  });
  it("hydrates real thread/read identity without replaying its idle lifecycle or private turns", () => {
    const { route, tasks } = harness();
    route("turn/started", { threadId: child, turn: { id: "first" } });
    const response = {
      thread: {
        id: child,
        status: { type: "notLoaded" },
        name: null,
        agentNickname: "Helmholtz",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: root,
              depth: 1,
              agent_path: "/root/installed_task_probe",
              agent_nickname: "Helmholtz",
              agent_role: null,
            },
          },
        },
        turns: [{ secret: "NOT REQUESTED OR RETAINED" }],
      },
    };
    expect(updateCodexBackgroundTaskMetadata(tasks, child, response)).toMatchObject({
      metadataUpdated: true,
      title: "Codex subagent /root/installed_task_probe",
      status: "running",
      nativeTurnId: "first",
    });
    expect(updateCodexBackgroundTaskMetadata(tasks, child, response)).toBeNull();
    expect(
      updateCodexBackgroundTaskMetadata(tasks, child, { thread: { ...response.thread, id: root } }),
    ).toBeNull();
    expect(JSON.stringify([...tasks.values()])).not.toContain("NOT REQUESTED");
    route("turn/completed", { threadId: child, turn: { id: "first", status: "completed" } });
    expect(
      updateCodexBackgroundTaskMetadata(tasks, child, {
        thread: { id: child, name: "Later name" },
      }),
    ).toMatchObject({ status: "completed" });
  });

  it("preserves all genuine root notifications and global session notices", () => {
    const { route } = harness();
    for (const method of [
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
      "thread/tokenUsage/updated",
      "error",
    ]) {
      expect(route(method, { threadId: root })).toBeUndefined();
    }
    expect(route("account/rateLimits/updated", { rateLimits: {} })).toBeUndefined();
  });
  it("never routes child failure or completion into root lifecycle", () => {
    const { route } = harness();
    expect(
      route("error", {
        threadId: child,
        turnId: "child-turn",
        error: { message: "child failed" },
        willRetry: false,
      }),
    ).toMatchObject({ status: "failed", summary: "child failed" });
    expect(
      route("turn/completed", {
        threadId: child,
        turn: { id: "child-turn", status: "interrupted" },
      }),
    ).toMatchObject({ status: "stopped" });
  });
  it("stops only a known running child turn and rejects root, unknown and finished tasks", () => {
    const { route, tasks } = harness();
    route("turn/started", { threadId: child, turn: { id: "child-turn" } });
    expect(codexBackgroundStopTarget(tasks, codexBackgroundTaskId(child), root)).toEqual({
      threadId: child,
      turnId: "child-turn",
    });
    expect(codexBackgroundStopTarget(tasks, codexBackgroundTaskId(root), root)).toBeNull();
    expect(codexBackgroundStopTarget(tasks, "unknown", root)).toBeNull();
    route("turn/completed", { threadId: child, turn: { id: "child-turn", status: "completed" } });
    expect(codexBackgroundStopTarget(tasks, codexBackgroundTaskId(child), root)).toBeNull();
  });
});

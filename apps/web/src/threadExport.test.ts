import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import {
  LARGE_THREAD_EXPORT_TURN_THRESHOLD,
  buildThreadHandoff,
  countThreadTurns,
  serializeThreadHandoff,
} from "./threadExport";

function makeThread(turnCount = 2): EnvironmentThread {
  const messages = Array.from({ length: turnCount }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: index === 0 ? "Use token=super-secret-value here" : "Done",
    turnId: `turn-${index}`,
    streaming: false,
    createdAt: `2026-07-29T00:00:${String(index).padStart(2, "0")}.000Z`,
    updatedAt: `2026-07-29T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  return {
    environmentId: "local",
    id: "thread-1",
    projectId: "project-1",
    title: "Export me",
    modelSelection: { instanceId: "codex", model: "gpt-5", options: { apiKey: "hidden" } },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/workspace",
    latestTurn: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: [
      {
        id: "event-1",
        tone: "tool",
        kind: "tool-result",
        summary: "Read file",
        payload: {
          toolCall: { name: "read", path: "/workspace/file.ts" },
          result: "ok",
          authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        },
        turnId: "turn-1",
        createdAt: "2026-07-29T00:00:02.000Z",
      },
    ],
    checkpoints: [],
    session: {
      threadId: "thread-1",
      status: "stopped",
      providerName: "Codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-07-29T00:01:00.000Z",
    },
  } as unknown as EnvironmentThread;
}

describe("thread handoff export", () => {
  it("serializes metadata, ordered messages, tool events, and a schema marker", () => {
    const handoff = buildThreadHandoff(makeThread(), new Date("2026-07-29T01:00:00.000Z"));
    expect(handoff.schema).toBe("solla.thread-handoff");
    expect(handoff.schemaVersion).toBe(1);
    expect(handoff.metadata.turnCount).toBe(2);
    expect(handoff.conversation.timeline.map((entry) => entry.type)).toEqual([
      "message",
      "message",
      "event",
    ]);
    expect(JSON.stringify(handoff)).toContain("toolCall");
  });

  it("redacts credential-shaped keys and values", () => {
    const serialized = serializeThreadHandoff(makeThread());
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain('"credentialsIncluded": false');
  });

  it("counts more than 500 distinct turns for the heavy-export warning", () => {
    const thread = makeThread(LARGE_THREAD_EXPORT_TURN_THRESHOLD + 1);
    expect(countThreadTurns(thread)).toBe(501);
  });
});

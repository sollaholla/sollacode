import { describe, expect, it } from "vite-plus/test";

import type { ThreadSnapshot } from "./events";
import {
  PENDING_THREAD_TITLE_TTL_MS,
  reconcilePendingThreadTitles,
  rememberPendingThreadTitle,
} from "./threadTitleOverrides";

const thread = (title: string): ThreadSnapshot => ({
  threadKey: "env-1:thread-a",
  threadId: "thread-a",
  environmentId: "env-1",
  title,
  isWorking: false,
  waitingOn: "nothing",
  hasError: false,
  lastError: null,
  failureKind: null,
  errorAt: null,
  settled: false,
  environmentUnreachable: false,
  model: "gpt-5.6-sol",
  provider: "codex",
  accessMode: "full-access",
  interactionMode: "default",
  effort: "high",
  isSideChat: false,
  sideChatParentThreadId: null,
  backgroundAgentName: null,
  projectId: "project-1",
  projectName: "Sample Project",
  workspaceName: "Sample Project",
  latestTurnState: "completed",
});

describe("pending Orchestrator thread titles", () => {
  it("routes an immediate second rename through the title accepted by the first", () => {
    const rawWorld = new Map([["env-1:thread-a", thread("Unity Runtime Scene Fix")]]);
    const pending = rememberPendingThreadTitle(new Map(), {
      threadKey: "env-1:thread-a",
      title: "Sample Project Runtime Rendering Fixes",
      nowMs: 1_000,
    });

    const reconciled = reconcilePendingThreadTitles(rawWorld, pending, 1_001);

    expect(reconciled.world.get("env-1:thread-a")?.title).toBe(
      "Sample Project Runtime Rendering Fixes",
    );
    expect(reconciled.pending.size).toBe(1);
  });

  it("drops the override when the shell projection catches up", () => {
    const title = "Sample Project Runtime Rendering Fixes";
    const pending = rememberPendingThreadTitle(new Map(), {
      threadKey: "env-1:thread-a",
      title,
      nowMs: 1_000,
    });

    const reconciled = reconcilePendingThreadTitles(
      new Map([["env-1:thread-a", thread(title)]]),
      pending,
      1_100,
    );

    expect(reconciled.world.get("env-1:thread-a")?.title).toBe(title);
    expect(reconciled.pending.size).toBe(0);
  });

  it("expires instead of masking a later external rename", () => {
    const rawWorld = new Map([["env-1:thread-a", thread("New title from another client")]]);
    const pending = rememberPendingThreadTitle(new Map(), {
      threadKey: "env-1:thread-a",
      title: "Voice title",
      nowMs: 1_000,
    });

    const reconciled = reconcilePendingThreadTitles(
      rawWorld,
      pending,
      1_000 + PENDING_THREAD_TITLE_TTL_MS,
    );

    expect(reconciled.world).toBe(rawWorld);
    expect(reconciled.pending.size).toBe(0);
  });
});

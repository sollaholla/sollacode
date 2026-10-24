import { describe, expect, it } from "vite-plus/test";

import {
  assembleProjectStatistics,
  attachmentBytesByThreadSegment,
  type ProjectStatisticsRows,
  type ProjectStatisticsUsageRow,
} from "./projectStatistics.ts";

const now = Date.parse("2026-10-11T12:00:00.000Z");

const usage = (
  input: Partial<ProjectStatisticsUsageRow> & Pick<ProjectStatisticsUsageRow, "threadId" | "day">,
): ProjectStatisticsUsageRow => ({
  providerInstanceId: "claudeAgent",
  provider: "claudeAgent",
  turns: 1,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  ...input,
});

const rows: ProjectStatisticsRows = {
  projectIds: ["project-busy", "project-empty"],
  threads: [
    {
      threadId: "thread-big",
      projectId: "project-busy",
      title: "Big thread",
      archivedAt: null,
      updatedAt: "2026-10-11T10:00:00.000Z",
      worktreePath: "/worktrees/a",
      historyBytes: 5_000,
      messages: 12,
      turns: 4,
      artifactBytes: 2_000,
    },
    {
      threadId: "thread-small",
      projectId: "project-busy",
      title: "Small thread",
      archivedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
      worktreePath: "/worktrees/a",
      historyBytes: 100,
      messages: 2,
      turns: 1,
      artifactBytes: 0,
    },
  ],
  usage: [
    usage({
      threadId: "thread-big",
      day: "2026-10-11",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
    }),
    usage({
      threadId: "thread-big",
      day: "2026-10-10",
      providerInstanceId: "codex",
      provider: "codex",
      turns: 2,
      inputTokens: 300,
      cachedInputTokens: 700,
      outputTokens: 50,
      reasoningTokens: 30,
    }),
    // Outside the 30-day window: all-time only.
    usage({ threadId: "thread-small", day: "2026-08-01", inputTokens: 1_000, outputTokens: 1 }),
  ],
};

describe("assembleProjectStatistics", () => {
  const result = assembleProjectStatistics({
    rows,
    attachmentBytes: (threadId) => (threadId === "thread-big" ? 300 : 0),
    nowEpochMs: now,
  });
  const busy = result.projects[0]!;

  it("totals a project's threads, storage, and tokens", () => {
    expect(busy).toMatchObject({
      projectId: "project-busy",
      activeThreads: 1,
      archivedThreads: 1,
      turns: 5,
      messages: 14,
      lastActivityAt: "2026-10-11T10:00:00.000Z",
      storage: { historyBytes: 5_100, attachmentBytes: 300, artifactBytes: 2_000, worktrees: 1 },
    });
    expect(busy.tokens.allTime).toEqual({
      turns: 4,
      inputTokens: 1_400,
      cachedInputTokens: 700,
      cacheWriteTokens: 0,
      outputTokens: 71,
      reasoningTokens: 30,
      costUsd: 0.5,
    });
    expect(busy.tokens.last30Days.turns).toBe(3);
    expect(busy.tokens.daily).toEqual([
      { day: "2026-10-10", tokens: 1_050 },
      { day: "2026-10-11", tokens: 120 },
    ]);
    expect(busy.tokens.byProvider.map((entry) => entry.providerInstanceId)).toEqual([
      "claudeAgent",
      "codex",
    ]);
  });

  it("lists threads largest first with their own share", () => {
    expect(
      busy.threads.map((thread) => [thread.threadId, thread.fileBytes, thread.tokens]),
    ).toEqual([
      ["thread-big", 2_300, 1_170],
      ["thread-small", 0, 1_001],
    ]);
  });

  it("lists at most the 50 largest threads while counting every one", () => {
    const many = assembleProjectStatistics({
      rows: {
        projectIds: ["project-busy"],
        threads: Array.from({ length: 60 }, (_, index) => ({
          ...rows.threads[0]!,
          threadId: `thread-${index}`,
          historyBytes: index,
        })),
        usage: [],
      },
      attachmentBytes: () => 0,
      nowEpochMs: now,
    }).projects[0]!;
    expect(many.activeThreads).toBe(60);
    expect(many.threads).toHaveLength(50);
    expect(many.threads[0]?.threadId).toBe("thread-59");
  });

  it("keeps projects with nothing in them, and dates tracking from the first usage", () => {
    expect(result.projects[1]).toMatchObject({
      projectId: "project-empty",
      activeThreads: 0,
      lastActivityAt: null,
      threads: [],
    });
    expect(result.tokenTrackingSince).toBe("2026-08-01T00:00:00.000Z");
    expect(result.generatedAt).toBe("2026-10-11T12:00:00.000Z");
  });
});

describe("attachmentBytesByThreadSegment", () => {
  it("groups stored files by the thread segment their names start with", () => {
    expect(
      attachmentBytesByThreadSegment([
        {
          name: "201537c3-8ea3-424c-b447-b45fee932247-09226d9f-64cc-d5f1-8a33-b32da64b9afa.jpg",
          bytes: 10,
        },
        {
          name: "201537c3-8ea3-424c-b447-b45fee932247-0f3f06ea-08f2-f6a1-89b9-c097a973d567.png",
          bytes: 5,
        },
        { name: "thread-1-11111111-2222-3333-4444-555555555555.wav", bytes: 7 },
        { name: ".DS_Store", bytes: 99 },
      ]),
    ).toEqual(
      new Map([
        ["201537c3-8ea3-424c-b447-b45fee932247", 15],
        ["thread-1", 7],
      ]),
    );
  });
});

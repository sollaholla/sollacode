import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationProjectFolderUsage,
  type OrchestrationProjectStatistics,
  type OrchestrationTokenUsageTotals,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import {
  dailyTokenSeries,
  distinctFolderBytes,
  filterProjectOverviews,
  folderUsageNotes,
  formatByteSize,
  formatTokenCount,
  formatUsdAmount,
  joinProjectStatistics,
  projectStatisticsStatus,
  projectStorageBytes,
  providerUsageRows,
  sortProjectOverviews,
  storageSegments,
  summarizeProjectOverviews,
} from "./projectStatistics.ts";

const environmentId = EnvironmentId.make("env-1");

const project = (id: string, title: string, updatedAt = "2026-10-01T00:00:00.000Z") =>
  ({
    id: ProjectId.make(id),
    environmentId,
    title,
    workspaceRoot: `/Users/me/code/${title.toLowerCase()}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  }) satisfies EnvironmentProject;

const usage = (tokens: number, costUsd = 0): OrchestrationTokenUsageTotals => ({
  turns: 1,
  inputTokens: tokens,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd,
});

const statistics = (
  projectId: string,
  input: { storage: number; tokens: number; lastActivityAt: string | null; costUsd?: number },
): OrchestrationProjectStatistics => ({
  projectId: ProjectId.make(projectId),
  activeThreads: 1,
  archivedThreads: 0,
  turns: 1,
  messages: 2,
  lastActivityAt: input.lastActivityAt,
  storage: { historyBytes: input.storage, attachmentBytes: 0, artifactBytes: 0, worktrees: 0 },
  tokens: {
    allTime: usage(input.tokens, input.costUsd),
    last30Days: usage(input.tokens, input.costUsd),
    daily: [],
    byProvider: [],
  },
  threads: [],
});

const folder = (projectId: string, bytes: number | null): OrchestrationProjectFolderUsage => ({
  projectId: ProjectId.make(projectId),
  bytes,
  measuredAt: bytes === null ? null : "2026-10-10T12:00:00.000Z",
  measuring: false,
  skippedFolders: [],
  unreadableFolders: 0,
  error: null,
});

const overviews = joinProjectStatistics(
  [
    project("alpha", "Alpha"),
    project("beta", "beta"),
    project("solla-agents", "Agents"),
    project("fresh", "Fresh", "2026-10-09T00:00:00.000Z"),
  ],
  [
    {
      environmentId,
      result: {
        generatedAt: "2026-10-10T12:00:00.000Z",
        tokenTrackingSince: "2026-10-10T00:00:00.000Z",
        projects: [
          statistics("alpha", {
            storage: 10,
            tokens: 500,
            lastActivityAt: "2026-10-05T00:00:00.000Z",
          }),
          statistics("beta", {
            storage: 900,
            tokens: 50,
            lastActivityAt: "2026-10-08T00:00:00.000Z",
            costUsd: 1.5,
          }),
          statistics("solla-agents", {
            storage: 5_000,
            tokens: 9_000,
            lastActivityAt: "2026-10-10T00:00:00.000Z",
          }),
          // Deleted since: not on the live list, so not shown.
          statistics("gone", { storage: 1, tokens: 1, lastActivityAt: null }),
        ],
      },
      folders: [folder("alpha", 1_000), { ...folder("beta", null), measuring: true }],
      error: null,
      isLoading: false,
    },
  ],
);

const titles = (entries: ReadonlyArray<{ project: { title: string } }>) =>
  entries.map((entry) => entry.project.title);

describe("project overviews", () => {
  it("joins statistics onto the live projects and marks the built-in ones", () => {
    expect(titles(overviews)).toEqual(["Alpha", "beta", "Agents", "Fresh"]);
    expect(overviews.find((entry) => entry.project.id === "fresh")?.statistics).toBeNull();
    expect(overviews.filter((entry) => entry.builtIn).map((entry) => entry.project.id)).toEqual([
      "solla-agents",
    ]);
  });

  it("sorts the user's own projects first, by the chosen measure", () => {
    expect(titles(sortProjectOverviews(overviews, "name"))).toEqual([
      "Alpha",
      "beta",
      "Fresh",
      "Agents",
    ]);
    // A project with no statistics yet falls back to when it changed.
    expect(titles(sortProjectOverviews(overviews, "recent"))).toEqual([
      "Fresh",
      "beta",
      "Alpha",
      "Agents",
    ]);
    // Alpha's folder outweighs beta's chats.
    expect(titles(sortProjectOverviews(overviews, "storage"))).toEqual([
      "Alpha",
      "beta",
      "Fresh",
      "Agents",
    ]);
    expect(titles(sortProjectOverviews(overviews, "tokens"))).toEqual([
      "Alpha",
      "beta",
      "Fresh",
      "Agents",
    ]);
  });

  it("filters on every word, across name and folder", () => {
    expect(titles(filterProjectOverviews(overviews, "code BET"))).toEqual(["beta"]);
    expect(titles(filterProjectOverviews(overviews, "  "))).toHaveLength(4);
    expect(filterProjectOverviews(overviews, "alpha nothing")).toEqual([]);
  });

  it("totals what it can count", () => {
    expect(summarizeProjectOverviews(overviews)).toEqual({
      projects: 4,
      // Chats, then Alpha's folder: beta's is still being measured.
      storageBytes: 5_910 + 1_000,
      tokensLast30Days: 9_550,
      costLast30DaysUsd: 1.5,
    });
  });

  it("counts a project folder inside another measured one only once", () => {
    const home = { ...project("home", "Home"), workspaceRoot: "/Users/me" };
    const entries = joinProjectStatistics(
      [home, project("alpha", "Alpha"), project("beta", "Beta")],
      [
        {
          environmentId,
          result: null,
          folders: [folder("home", 100_000), folder("alpha", 1_000), folder("beta", null)],
          error: null,
          isLoading: false,
        },
      ],
    );
    expect(distinctFolderBytes(entries)).toBe(100_000);
    expect(projectStorageBytes(entries[1]!)).toBe(1_000);
    expect(distinctFolderBytes(entries.slice(1))).toBe(1_000);
  });

  it("says why a folder has no size, or what its size leaves out", () => {
    expect(folderUsageNotes(null)).toEqual([]);
    expect(folderUsageNotes({ ...folder("a", null), measuring: true })).toEqual([
      "Measuring the folder…",
    ]);
    expect(folderUsageNotes({ ...folder("a", null), error: "This folder doesn't exist." })).toEqual(
      ["This folder doesn't exist."],
    );
    const notes = folderUsageNotes({
      ...folder("a", 5),
      skippedFolders: ["Music", "Pictures"],
      unreadableFolders: 2,
    });
    expect(notes[0]).toContain("Not counted: Music, Pictures.");
    expect(notes[0]).toContain("Full Disk Access");
    expect(notes[1]).toBe("2 folders inside couldn't be read.");
  });
});

describe("projectStatisticsStatus", () => {
  it("reports loading and failure from any environment, and the earliest tracking start", () => {
    const answered = (since: string | null) => ({
      generatedAt: "2026-10-10T12:00:00.000Z",
      tokenTrackingSince: since,
      projects: [],
    });
    expect(
      projectStatisticsStatus([
        {
          environmentId,
          result: answered("2026-10-09T00:00:00.000Z"),
          folders: null,
          error: null,
          isLoading: false,
        },
        {
          environmentId: EnvironmentId.make("env-2"),
          result: answered("2026-10-02T00:00:00.000Z"),
          folders: null,
          error: null,
          isLoading: true,
        },
        {
          environmentId: EnvironmentId.make("env-3"),
          result: null,
          folders: null,
          error: "Couldn't load project statistics.",
          isLoading: false,
        },
      ]),
    ).toEqual({
      isLoading: true,
      error: "Couldn't load project statistics.",
      tokenTrackingSince: "2026-10-02T00:00:00.000Z",
    });
  });
});

describe("dailyTokenSeries", () => {
  it("fills the days nothing ran so the chart keeps its time axis", () => {
    const series = dailyTokenSeries(
      [
        { day: "2026-10-01", tokens: 5 },
        { day: "2026-10-10", tokens: 7 },
      ],
      "2026-10-10T23:59:00.000Z",
      10,
    );
    expect(series).toHaveLength(10);
    expect(series[0]).toEqual({ day: "2026-10-01", tokens: 5 });
    expect(series[5]).toEqual({ day: "2026-10-06", tokens: 0 });
    expect(series[9]).toEqual({ day: "2026-10-10", tokens: 7 });
  });
});

describe("shares", () => {
  it("splits storage into its parts, and an empty project into zeros", () => {
    expect(
      storageSegments({
        historyBytes: 300,
        attachmentBytes: 100,
        artifactBytes: 0,
        worktrees: 2,
      }).map((segment) => [segment.key, segment.fraction]),
    ).toEqual([
      ["history", 0.75],
      ["attachments", 0.25],
      ["artifacts", 0],
    ]);
    // Once measured, the folder leads.
    expect(
      storageSegments(
        { historyBytes: 300, attachmentBytes: 100, artifactBytes: 0, worktrees: 0 },
        600,
      ).map((segment) => [segment.key, segment.fraction]),
    ).toEqual([
      ["folder", 0.6],
      ["history", 0.3],
      ["attachments", 0.1],
      ["artifacts", 0],
    ]);
    expect(
      storageSegments({
        historyBytes: 0,
        attachmentBytes: 0,
        artifactBytes: 0,
        worktrees: 0,
      }).every((segment) => segment.fraction === 0),
    ).toBe(true);
  });

  it("names providers as configured, falling back to the product name", () => {
    const rows = providerUsageRows(
      [
        {
          providerInstanceId: ProviderInstanceId.make("claude-work"),
          provider: ProviderDriverKind.make("claudeAgent"),
          usage: usage(300, 2),
        },
        {
          providerInstanceId: ProviderInstanceId.make("codex-removed"),
          provider: ProviderDriverKind.make("codex"),
          usage: usage(100),
        },
      ],
      [
        {
          instanceId: ProviderInstanceId.make("claude-work"),
          displayName: "Claude (work)",
        } as unknown as ServerProvider,
      ],
    );
    expect(rows.map((row) => [row.label, row.tokens, row.fraction])).toEqual([
      ["Claude (work)", 300, 0.75],
      ["Codex", 100, 0.25],
    ]);
  });
});

describe("formatting", () => {
  it("formats sizes, token counts, and dollars compactly", () => {
    expect([0, 980, 12_700, 327_155_712, 1_954_210_119, 1_048_575].map(formatByteSize)).toEqual([
      "0 B",
      "980 B",
      "12.4 KB",
      "312 MB",
      "1.82 GB",
      "1 MB",
    ]);
    expect([0, 950, 12_340, 4_561_000, 999_950, 1_200_000_000].map(formatTokenCount)).toEqual([
      "0",
      "950",
      "12.3K",
      "4.56M",
      "1M",
      "1.2B",
    ]);
    expect([0, 0.004, 1.5, 12_345.6].map(formatUsdAmount)).toEqual([
      "$0.00",
      "<$0.01",
      "$1.50",
      "$12,346",
    ]);
  });
});

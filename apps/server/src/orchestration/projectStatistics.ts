import * as DateTime from "effect/DateTime";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationGetProjectStatisticsResult,
  type OrchestrationProjectStatistics,
  type OrchestrationTokenUsageTotals,
} from "@t3tools/contracts";

/** One live thread, as the statistics query reads it. */
export interface ProjectStatisticsThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  readonly worktreePath: string | null;
  readonly historyBytes: number;
  readonly messages: number;
  readonly turns: number;
  readonly artifactBytes: number;
}

/** A thread's recorded turn usage for one provider instance on one UTC day. */
export interface ProjectStatisticsUsageRow {
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly provider: string;
  readonly day: string;
  readonly turns: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
}

export interface ProjectStatisticsRows {
  readonly projectIds: ReadonlyArray<string>;
  readonly threads: ReadonlyArray<ProjectStatisticsThreadRow>;
  readonly usage: ReadonlyArray<ProjectStatisticsUsageRow>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days of daily usage a project reports, today included. */
export const PROJECT_STATISTICS_DAYS = 30;
/** Threads a project lists, largest first, so one busy project cannot bloat the response. */
export const PROJECT_STATISTICS_THREAD_LIMIT = 50;

const emptyTotals = (): { -readonly [K in keyof OrchestrationTokenUsageTotals]: number } => ({
  turns: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
});

const safe = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

function addUsage(totals: ReturnType<typeof emptyTotals>, row: ProjectStatisticsUsageRow): void {
  totals.turns += safe(row.turns);
  totals.inputTokens += safe(row.inputTokens);
  totals.cachedInputTokens += safe(row.cachedInputTokens);
  totals.cacheWriteTokens += safe(row.cacheWriteTokens);
  totals.outputTokens += safe(row.outputTokens);
  totals.reasoningTokens += safe(row.reasoningTokens);
  totals.costUsd += Number.isFinite(row.costUsd) && row.costUsd > 0 ? row.costUsd : 0;
}

const tokensOf = (row: ProjectStatisticsUsageRow) =>
  safe(row.inputTokens) +
  safe(row.cachedInputTokens) +
  safe(row.cacheWriteTokens) +
  safe(row.outputTokens);

const finishTotals = (totals: ReturnType<typeof emptyTotals>): OrchestrationTokenUsageTotals => ({
  ...totals,
  costUsd: Math.round(totals.costUsd * 100) / 100,
});

const isoAt = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));
const utcDay = (epochMs: number) => isoAt(epochMs).slice(0, 10);

/**
 * Folds the statistics query's rows into one entry per live project.
 *
 * `attachmentBytes` reports what each thread keeps in the attachments folder;
 * the database only remembers what was attached, and the retention sweep
 * deletes the files themselves.
 */
export function assembleProjectStatistics(input: {
  readonly rows: ProjectStatisticsRows;
  readonly attachmentBytes: (threadId: string) => number;
  readonly nowEpochMs: number;
}): OrchestrationGetProjectStatisticsResult {
  const firstRecentDay = utcDay(input.nowEpochMs - (PROJECT_STATISTICS_DAYS - 1) * DAY_MS);
  const threadsByProject = new Map<string, Array<ProjectStatisticsThreadRow>>();
  for (const thread of input.rows.threads) {
    const list = threadsByProject.get(thread.projectId) ?? [];
    list.push(thread);
    threadsByProject.set(thread.projectId, list);
  }
  const usageByThread = new Map<string, Array<ProjectStatisticsUsageRow>>();
  let tokenTrackingSince: string | null = null;
  for (const row of input.rows.usage) {
    const list = usageByThread.get(row.threadId) ?? [];
    list.push(row);
    usageByThread.set(row.threadId, list);
    if (tokenTrackingSince === null || row.day < tokenTrackingSince) tokenTrackingSince = row.day;
  }

  const projects: Array<OrchestrationProjectStatistics> = input.rows.projectIds.map((projectId) => {
    const threads = threadsByProject.get(projectId) ?? [];
    const allTime = emptyTotals();
    const last30Days = emptyTotals();
    const daily = new Map<string, number>();
    const byProvider = new Map<
      string,
      { provider: string; usage: ReturnType<typeof emptyTotals> }
    >();
    const worktrees = new Set<string>();
    let historyBytes = 0;
    let attachmentBytes = 0;
    let artifactBytes = 0;
    let turns = 0;
    let messages = 0;
    let lastActivityAt: string | null = null;

    const threadStatistics = threads.map((thread) => {
      const threadAttachmentBytes = safe(input.attachmentBytes(thread.threadId));
      historyBytes += safe(thread.historyBytes);
      attachmentBytes += threadAttachmentBytes;
      artifactBytes += safe(thread.artifactBytes);
      turns += safe(thread.turns);
      messages += safe(thread.messages);
      if (thread.worktreePath !== null) worktrees.add(thread.worktreePath);
      if (lastActivityAt === null || thread.updatedAt > lastActivityAt) {
        lastActivityAt = thread.updatedAt;
      }
      let threadTokens = 0;
      for (const row of usageByThread.get(thread.threadId) ?? []) {
        addUsage(allTime, row);
        threadTokens += tokensOf(row);
        const provider = byProvider.get(row.providerInstanceId) ?? {
          provider: row.provider,
          usage: emptyTotals(),
        };
        addUsage(provider.usage, row);
        byProvider.set(row.providerInstanceId, provider);
        if (row.day >= firstRecentDay) {
          addUsage(last30Days, row);
          daily.set(row.day, (daily.get(row.day) ?? 0) + tokensOf(row));
        }
      }
      return {
        threadId: ThreadId.make(thread.threadId),
        title: thread.title,
        archived: thread.archivedAt !== null,
        lastActivityAt: thread.updatedAt,
        turns: safe(thread.turns),
        historyBytes: safe(thread.historyBytes),
        fileBytes: threadAttachmentBytes + safe(thread.artifactBytes),
        tokens: threadTokens,
      };
    });

    return {
      projectId: ProjectId.make(projectId),
      activeThreads: threads.filter((thread) => thread.archivedAt === null).length,
      archivedThreads: threads.filter((thread) => thread.archivedAt !== null).length,
      turns,
      messages,
      lastActivityAt,
      storage: { historyBytes, attachmentBytes, artifactBytes, worktrees: worktrees.size },
      tokens: {
        allTime: finishTotals(allTime),
        last30Days: finishTotals(last30Days),
        daily: [...daily.entries()]
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([day, tokens]) => ({ day, tokens })),
        byProvider: [...byProvider.entries()]
          .map(([providerInstanceId, entry]) => ({
            providerInstanceId: ProviderInstanceId.make(providerInstanceId),
            provider: ProviderDriverKind.make(entry.provider),
            usage: finishTotals(entry.usage),
          }))
          .toSorted(
            (left, right) =>
              right.usage.inputTokens +
              right.usage.cachedInputTokens +
              right.usage.cacheWriteTokens +
              right.usage.outputTokens -
              (left.usage.inputTokens +
                left.usage.cachedInputTokens +
                left.usage.cacheWriteTokens +
                left.usage.outputTokens),
          ),
      },
      threads: threadStatistics
        .toSorted(
          (left, right) =>
            right.historyBytes + right.fileBytes - (left.historyBytes + left.fileBytes) ||
            right.lastActivityAt.localeCompare(left.lastActivityAt),
        )
        .slice(0, PROJECT_STATISTICS_THREAD_LIMIT),
    };
  });

  return {
    generatedAt: isoAt(input.nowEpochMs),
    tokenTrackingSince: tokenTrackingSince === null ? null : `${tokenTrackingSince}T00:00:00.000Z`,
    projects,
  };
}

/**
 * Attachment files per thread, from their names: an attachment is stored as
 * `<thread segment>-<uuid>.<ext>` directly in the attachments folder.
 */
export function attachmentBytesByThreadSegment(
  files: ReadonlyArray<{ readonly name: string; readonly bytes: number }>,
): ReadonlyMap<string, number> {
  const bytes = new Map<string, number>();
  const pattern =
    /^(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-z0-9]+)?$/iu;
  for (const file of files) {
    const segment = pattern.exec(file.name)?.[1]?.toLowerCase();
    if (segment === undefined) continue;
    bytes.set(segment, (bytes.get(segment) ?? 0) + safe(file.bytes));
  }
  return bytes;
}

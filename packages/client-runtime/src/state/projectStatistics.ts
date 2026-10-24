import {
  isAgentsProjectId,
  isOrchestratorProjectId,
  type EnvironmentId,
  type OrchestrationGetProjectStatisticsResult,
  type OrchestrationProjectDailyTokens,
  type OrchestrationProjectFolders,
  type OrchestrationProjectFolderUsage,
  type OrchestrationProjectProviderUsage,
  type OrchestrationProjectStatistics,
  type OrchestrationProjectStorage,
  type OrchestrationTokenUsageTotals,
  type ServerProvider,
} from "@t3tools/contracts";
import { providerDisplayLabel } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { parseArchivedThreadsEnvironmentKey } from "./archivedThreads.ts";
import type { EnvironmentProject } from "./models.ts";

/**
 * Settings → Projects on web and mobile: what each project holds and has used,
 * joined onto the live project list so a rename or delete shows at once while
 * the numbers catch up on the next refresh.
 */

export interface ProjectStatisticsEnvironmentState {
  readonly environmentId: EnvironmentId;
  readonly result: OrchestrationGetProjectStatisticsResult | null;
  /** Each project folder's size on disk; null until the environment sends them. */
  readonly folders: ReadonlyArray<OrchestrationProjectFolderUsage> | null;
  readonly error: string | null;
  readonly isLoading: boolean;
}

/** One environment's statistics and folder sizes per key from `makeArchivedThreadsEnvironmentKey`. */
export function createProjectStatisticsAtomFamily<E, F>(options: {
  readonly getStatisticsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationGetProjectStatisticsResult, E>>;
  readonly getFoldersAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationProjectFolders, F>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((environmentKey: string) =>
    Atom.make(
      (get): ReadonlyArray<ProjectStatisticsEnvironmentState> =>
        parseArchivedThreadsEnvironmentKey(environmentKey).map((environmentId) => {
          const result = get(options.getStatisticsAtom(environmentId));
          const folders = get(options.getFoldersAtom(environmentId));
          return {
            environmentId,
            // A refresh keeps the last answer on screen rather than blanking it.
            result: Option.getOrNull(AsyncResult.value(result)),
            // An environment older than folder sizes fails this stream: no sizes, no error.
            folders: Option.getOrNull(AsyncResult.value(folders))?.folders ?? null,
            error: result._tag === "Failure" ? "Couldn't load project statistics." : null,
            isLoading: result.waiting,
          };
        }),
    ).pipe(Atom.withLabel(`${options.labelPrefix}:${environmentKey}`)),
  );
}

/** Loading and failure across environments, and the earliest turn any of them counted. */
export function projectStatisticsStatus(
  environments: ReadonlyArray<ProjectStatisticsEnvironmentState>,
): {
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly tokenTrackingSince: string | null;
} {
  const since = environments
    .map((environment) => environment.result?.tokenTrackingSince ?? null)
    .filter((value): value is string => value !== null)
    .toSorted();
  return {
    isLoading: environments.some((environment) => environment.isLoading),
    error: environments.find((environment) => environment.error !== null)?.error ?? null,
    tokenTrackingSince: since[0] ?? null,
  };
}

export interface ProjectOverview {
  readonly project: EnvironmentProject;
  /** Null until the environment answers, or for a project added since it last did. */
  readonly statistics: OrchestrationProjectStatistics | null;
  /** The project folder's size on disk; null until the environment sends it. */
  readonly folder: OrchestrationProjectFolderUsage | null;
  /** The orchestrator's and agents' own projects: counted, never renamed or deleted here. */
  readonly builtIn: boolean;
}

export function isBuiltInProject(projectId: string): boolean {
  return isOrchestratorProjectId(projectId) || isAgentsProjectId(projectId);
}

export function joinProjectStatistics(
  projects: ReadonlyArray<EnvironmentProject>,
  environments: ReadonlyArray<ProjectStatisticsEnvironmentState>,
): ReadonlyArray<ProjectOverview> {
  const statisticsByKey = new Map<string, OrchestrationProjectStatistics>();
  const foldersByKey = new Map<string, OrchestrationProjectFolderUsage>();
  for (const environment of environments) {
    for (const statistics of environment.result?.projects ?? []) {
      statisticsByKey.set(`${environment.environmentId}:${statistics.projectId}`, statistics);
    }
    for (const folder of environment.folders ?? []) {
      foldersByKey.set(`${environment.environmentId}:${folder.projectId}`, folder);
    }
  }
  return projects.map((project) => ({
    project,
    statistics: statisticsByKey.get(`${project.environmentId}:${project.id}`) ?? null,
    folder: foldersByKey.get(`${project.environmentId}:${project.id}`) ?? null,
    builtIn: isBuiltInProject(project.id),
  }));
}

/** Every token the model processed: fresh and cached input, cache writes, and output. */
export function totalTokens(usage: OrchestrationTokenUsageTotals): number {
  return usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens;
}

/** What a project's chats keep: history, attachments, and artifacts. */
export function totalStorageBytes(storage: OrchestrationProjectStorage): number {
  return storage.historyBytes + storage.attachmentBytes + storage.artifactBytes;
}

/** Everything a project takes: its chats and its folder on disk, as far as each is known. */
export function projectStorageBytes(entry: Pick<ProjectOverview, "statistics" | "folder">): number {
  return (
    (entry.statistics ? totalStorageBytes(entry.statistics.storage) : 0) +
    (entry.folder?.bytes ?? 0)
  );
}

function isInsideRoot(child: string, parent: string): boolean {
  if (child === parent) return false;
  const separator = parent.includes("/") ? "/" : "\\";
  return child.startsWith(parent.endsWith(separator) ? parent : `${parent}${separator}`);
}

/**
 * Folder sizes added up once each: a project folder inside another measured
 * one, such as a repository under a home-folder project, is already in its total.
 */
export function distinctFolderBytes(entries: ReadonlyArray<ProjectOverview>): number {
  const measured = entries.filter((entry) => entry.folder?.bytes != null);
  const counted = new Set<string>();
  let total = 0;
  for (const entry of measured) {
    const { environmentId, workspaceRoot } = entry.project;
    const key = `${environmentId}:${workspaceRoot}`;
    if (counted.has(key)) continue;
    const nested = measured.some(
      (other) =>
        other.project.environmentId === environmentId &&
        isInsideRoot(workspaceRoot, other.project.workspaceRoot),
    );
    if (nested) continue;
    counted.add(key);
    total += entry.folder?.bytes ?? 0;
  }
  return total;
}

/** What to say beside a folder's size: why there is none, or what it leaves out. */
export function folderUsageNotes(
  folder: OrchestrationProjectFolderUsage | null,
): ReadonlyArray<string> {
  if (folder === null) return [];
  if (folder.error !== null) return [folder.error];
  const notes: string[] = [];
  if (folder.bytes === null)
    notes.push(folder.measuring ? "Measuring the folder…" : "Not measured yet.");
  if (folder.skippedFolders.length > 0) {
    notes.push(
      `Not counted: ${folder.skippedFolders.join(", ")}. macOS asks before an app reads these; give Solla Code Full Disk Access to include them.`,
    );
  }
  if (folder.unreadableFolders > 0) {
    notes.push(
      `${folder.unreadableFolders.toLocaleString()} ${folder.unreadableFolders === 1 ? "folder" : "folders"} inside couldn't be read.`,
    );
  }
  return notes;
}

export type ProjectSortKey = "recent" | "name" | "storage" | "tokens";

export const PROJECT_SORT_OPTIONS: ReadonlyArray<{
  readonly key: ProjectSortKey;
  readonly label: string;
}> = [
  { key: "recent", label: "Recent activity" },
  { key: "name", label: "Name" },
  { key: "storage", label: "Storage" },
  { key: "tokens", label: "Tokens, 30 days" },
];

const lastActivityOf = (entry: ProjectOverview) =>
  entry.statistics?.lastActivityAt ?? entry.project.updatedAt;

/** Built-in projects sink below the user's own; ties fall back to name. */
export function sortProjectOverviews(
  entries: ReadonlyArray<ProjectOverview>,
  key: ProjectSortKey,
): ReadonlyArray<ProjectOverview> {
  const byName = (left: ProjectOverview, right: ProjectOverview) =>
    left.project.title.localeCompare(right.project.title, undefined, { sensitivity: "base" }) ||
    left.project.id.localeCompare(right.project.id);
  const measure = (entry: ProjectOverview): number => {
    if (key === "storage") {
      return entry.statistics === null && entry.folder?.bytes == null
        ? -1
        : projectStorageBytes(entry);
    }
    if (entry.statistics === null) return -1;
    return totalTokens(entry.statistics.tokens.last30Days);
  };
  return entries.toSorted((left, right) => {
    if (left.builtIn !== right.builtIn) return left.builtIn ? 1 : -1;
    if (key === "name") return byName(left, right);
    if (key === "recent") {
      return lastActivityOf(right).localeCompare(lastActivityOf(left)) || byName(left, right);
    }
    return measure(right) - measure(left) || byName(left, right);
  });
}

/** Every word of the query must appear in the project's name or folder. */
export function filterProjectOverviews(
  entries: ReadonlyArray<ProjectOverview>,
  query: string,
): ReadonlyArray<ProjectOverview> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  return entries.filter((entry) => {
    const haystack = `${entry.project.title}\n${entry.project.workspaceRoot}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export interface ProjectStatisticsSummary {
  readonly projects: number;
  readonly storageBytes: number;
  readonly tokensLast30Days: number;
  readonly costLast30DaysUsd: number;
}

export function summarizeProjectOverviews(
  entries: ReadonlyArray<ProjectOverview>,
): ProjectStatisticsSummary {
  let storageBytes = 0;
  let tokensLast30Days = 0;
  let costLast30DaysUsd = 0;
  for (const { statistics } of entries) {
    if (statistics === null) continue;
    storageBytes += totalStorageBytes(statistics.storage);
    tokensLast30Days += totalTokens(statistics.tokens.last30Days);
    costLast30DaysUsd += statistics.tokens.last30Days.costUsd;
  }
  storageBytes += distinctFolderBytes(entries);
  return { projects: entries.length, storageBytes, tokensLast30Days, costLast30DaysUsd };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The last `days` UTC days ending on the day the statistics were taken, with
 * the days nothing ran filled in as zero so a chart keeps its time axis.
 */
export function dailyTokenSeries(
  daily: ReadonlyArray<OrchestrationProjectDailyTokens>,
  generatedAt: string,
  days = 30,
): ReadonlyArray<OrchestrationProjectDailyTokens> {
  const tokensByDay = new Map(daily.map((entry) => [entry.day, entry.tokens]));
  const lastDayMs = Date.parse(`${generatedAt.slice(0, 10)}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const day = DateTime.formatIso(
      DateTime.makeUnsafe(lastDayMs - (days - 1 - index) * DAY_MS),
    ).slice(0, 10);
    return { day, tokens: tokensByDay.get(day) ?? 0 };
  });
}

export interface ShareSegment<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly value: number;
  /** Of the whole, 0 to 1; every segment is 0 when the whole is. */
  readonly fraction: number;
}

function shares<K extends string>(
  parts: ReadonlyArray<{ readonly key: K; readonly label: string; readonly value: number }>,
): ReadonlyArray<ShareSegment<K>> {
  const whole = parts.reduce((sum, part) => sum + part.value, 0);
  return parts.map((part) => ({ ...part, fraction: whole > 0 ? part.value / whole : 0 }));
}

export type StorageSegmentKey = "folder" | "history" | "attachments" | "artifacts";

/** A project's storage in parts; the folder leads once it has been measured. */
export function storageSegments(
  storage: OrchestrationProjectStorage,
  folderBytes: number | null = null,
): ReadonlyArray<ShareSegment<StorageSegmentKey>> {
  return shares([
    ...(folderBytes === null
      ? []
      : [{ key: "folder" as const, label: "Folder on disk", value: folderBytes }]),
    { key: "history", label: "Chat history", value: storage.historyBytes },
    { key: "attachments", label: "Attachments", value: storage.attachmentBytes },
    { key: "artifacts", label: "Artifacts", value: storage.artifactBytes },
  ]);
}

export type TokenSegmentKey = "input" | "cached" | "cacheWrite" | "output";

export function tokenSegments(
  usage: OrchestrationTokenUsageTotals,
): ReadonlyArray<ShareSegment<TokenSegmentKey>> {
  return shares([
    { key: "input", label: "Input", value: usage.inputTokens },
    { key: "cached", label: "Cached input", value: usage.cachedInputTokens },
    { key: "cacheWrite", label: "Cache writes", value: usage.cacheWriteTokens },
    { key: "output", label: "Output", value: usage.outputTokens },
  ]);
}

export interface ProviderUsageRow {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly fraction: number;
}

/**
 * Providers as people named them. An instance since removed falls back to its
 * product name; models are deliberately not shown, since a provider can report
 * ids this client has never heard of.
 */
export function providerUsageRows(
  byProvider: ReadonlyArray<OrchestrationProjectProviderUsage>,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderUsageRow> {
  const displayNames = new Map(
    providers.map((provider) => [provider.instanceId, provider.displayName]),
  );
  const whole = byProvider.reduce((sum, entry) => sum + totalTokens(entry.usage), 0);
  return byProvider.map((entry) => {
    const tokens = totalTokens(entry.usage);
    return {
      key: entry.providerInstanceId,
      label: providerDisplayLabel(displayNames.get(entry.providerInstanceId), entry.provider),
      tokens,
      costUsd: entry.usage.costUsd,
      turns: entry.usage.turns,
      fraction: whole > 0 ? tokens / whole : 0,
    };
  });
}

const TRACKING_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** What the token numbers cover: only turns since usage was first recorded, and only some providers. */
export function tokenTrackingNote(since: string | null): string {
  return since === null
    ? "Token usage is counted from each turn that finishes from now on, for Claude and Codex. Turns from before this update weren't measured."
    : `Token usage counted since ${TRACKING_DATE.format(Date.parse(since))}, for Claude and Codex. Costs are what the provider reports at API rates, even when a subscription covers them.`;
}

/** Three significant digits at most, stepping up a unit once rounding reaches the next. */
function scaled(amount: number, base: number, units: ReadonlyArray<string>) {
  const round = (value: number) => Number(value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0));
  let value = Math.max(0, amount);
  let index = 0;
  while (index < units.length - 1 && round(value) >= base) {
    value /= base;
    index += 1;
  }
  return { value: index === 0 ? Math.round(value) : round(value), unit: units[index]! };
}

/** "0 B", "980 B", "12.4 KB", "312 MB", "1.82 GB". */
export function formatByteSize(bytes: number): string {
  const { value, unit } = scaled(bytes, 1024, ["B", "KB", "MB", "GB", "TB"]);
  return `${value} ${unit}`;
}

/** "0", "950", "12.3K", "4.56M", "1.2B". */
export function formatTokenCount(tokens: number): string {
  const { value, unit } = scaled(tokens, 1000, ["", "K", "M", "B", "T"]);
  return `${value}${unit}`;
}

/** Fractions of a cent read as "<$0.01" rather than a misleading "$0.00". */
export function formatUsdAmount(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toLocaleString("en-US", {
    minimumFractionDigits: usd < 1000 ? 2 : 0,
    maximumFractionDigits: usd < 1000 ? 2 : 0,
  })}`;
}

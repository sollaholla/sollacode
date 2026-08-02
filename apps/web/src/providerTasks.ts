import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * Sub-agents and background work a provider starts during a turn.
 *
 * The runtime already emits `task.started` / `task.progress` / `task.completed`
 * per the provider spec, but nothing rendered them: a turn that fanned out to
 * three sub-agents looked exactly like a turn that had gone quiet. This folds
 * the event stream back into one row per task.
 */

/**
 * A "running" task that has not reported in this long is downgraded to
 * `stale`. A task only leaves `running` when a `task.completed` event arrives,
 * and a runtime that dies mid-turn never sends one — so without this, killed
 * work claims to be running forever.
 *
 * Thirty minutes because background commands emit no progress events at all:
 * for those, time since start is the only liveness signal there is, and a long
 * build or render legitimately says nothing for twenty. Erring long means a
 * dead task lingers a while; erring short would label real work as suspect,
 * and this panel is only worth having if its "running" means something.
 */
export const PROVIDER_TASK_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Any task silent for this long is dropped, whatever its last known status.
 *
 * This deliberately covers stale tasks as well as finished ones. Applying it
 * only to finished work let days-old ghosts — tasks whose runtime died without
 * ever emitting `task.completed` — accumulate without limit, which is the one
 * category that can never clear itself.
 */
export const PROVIDER_TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How long finished work stays listed after its last event.
 *
 * Completed and stopped tasks have answered their question, so they leave
 * after a glanceable window — before this, every finished build of a long
 * session sat in the panel for a day and the list ran into the hundreds.
 * Failures hold on longer, because a failure the user has not noticed yet is
 * the one finished state that still needs them.
 */
export const PROVIDER_TASK_COMPLETED_RETENTION_MS = 10 * 60 * 1000;
export const PROVIDER_TASK_FAILED_RETENTION_MS = 60 * 60 * 1000;

/**
 * Even inside the retention window, only this many finished rows stay. A
 * parallel burst finishing at once would otherwise flood the pager with
 * near-identical rows; the newest few carry all the signal, and anything the
 * user needed longer is in the transcript.
 */
export const PROVIDER_TASK_FINISHED_MAX_COUNT = 20;

export const PROVIDER_TASK_PAGE_SIZE = 10;

/**
 * `stale` is deliberately distinct from `stopped`: we did not observe this task
 * end, we simply stopped hearing from it. Claiming either "running" or
 * "stopped" would assert something we do not know.
 */
export type ProviderTaskStatus = "running" | "stale" | "completed" | "failed" | "stopped";

export interface ProviderTask {
  readonly taskId: string;
  /** `local_agent`, `local_bash`, … — absent on providers that don't send one. */
  readonly taskType: string | null;
  /** Latest progress description, falling back to the start description. */
  readonly title: string;
  readonly summary: string | null;
  readonly lastToolName: string | null;
  readonly status: ProviderTaskStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly toolUses: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toolUseCount(payload: Record<string, unknown> | null): number | null {
  const usage = asRecord(payload?.usage);
  const value = usage?.tool_uses;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStatus(value: unknown): ProviderTaskStatus {
  return value === "failed" || value === "stopped" || value === "completed" ? value : "completed";
}

function isFinished(status: ProviderTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

/**
 * Folds task activities into one entry per task, newest activity last.
 *
 * A `task.progress` for a task we never saw start still creates a row: the
 * events are independent, and dropping progress for a missed start would hide
 * exactly the long-running work this panel exists to show.
 *
 * The result is a *status* view, not a log: finished work ages out within
 * minutes (an hour for failures), a hard cap keeps bursts from flooding the
 * list, and silent "running" work is downgraded to `stale`. Without these,
 * the panel accumulates every task since the thread began and reports
 * long-dead processes as live.
 */
export function deriveProviderTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: { readonly nowMs?: number },
): ReadonlyArray<ProviderTask> {
  const nowMs = options?.nowMs ?? Date.now();
  const byTaskId = new Map<string, ProviderTask>();

  for (const activity of activities) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    const payload = asRecord(activity.payload);
    const taskId = stringField(payload, "taskId");
    if (!taskId) continue;

    const existing = byTaskId.get(taskId);
    const title =
      stringField(payload, "title") ??
      stringField(payload, "description") ??
      stringField(payload, "detail") ??
      existing?.title ??
      "Background task";

    byTaskId.set(taskId, {
      taskId,
      taskType: stringField(payload, "taskType") ?? existing?.taskType ?? null,
      title,
      summary: stringField(payload, "summary") ?? existing?.summary ?? null,
      lastToolName: stringField(payload, "lastToolName") ?? existing?.lastToolName ?? null,
      status:
        activity.kind === "task.completed"
          ? toStatus(payload?.status)
          : existing?.status === "running" || existing === undefined
            ? "running"
            : existing.status,
      startedAt: existing?.startedAt ?? activity.createdAt,
      updatedAt: activity.createdAt,
      toolUses: toolUseCount(payload) ?? existing?.toolUses ?? null,
    });
  }

  const aged: ProviderTask[] = [];
  for (const task of byTaskId.values()) {
    const updatedMs = Date.parse(task.updatedAt);
    const ageMs = Number.isNaN(updatedMs) ? 0 : nowMs - updatedMs;

    // Checked before the status branch so it applies to everything. A task
    // that has said nothing for a day is history regardless of whether we ever
    // saw it end — and a ghost never will.
    if (ageMs > PROVIDER_TASK_MAX_AGE_MS) continue;
    if (isFinished(task.status)) {
      const retentionMs =
        task.status === "failed"
          ? PROVIDER_TASK_FAILED_RETENTION_MS
          : PROVIDER_TASK_COMPLETED_RETENTION_MS;
      if (ageMs > retentionMs) continue;
      aged.push(task);
      continue;
    }
    aged.push(ageMs > PROVIDER_TASK_STALE_AFTER_MS ? { ...task, status: "stale" as const } : task);
  }

  // Running first — those are the ones still consuming time and the reason to
  // look at the panel at all. Stale next, because unexplained silence is the
  // next most actionable thing. Ties break on most-recently-updated.
  const rank = (task: ProviderTask) =>
    task.status === "running" ? 0 : task.status === "stale" ? 1 : 2;
  const sorted = aged.toSorted((left, right) => {
    const byRank = rank(left) - rank(right);
    return byRank === 0 ? right.updatedAt.localeCompare(left.updatedAt) : byRank;
  });
  // Finished rows sort newest-first within their rank, so keeping the first N
  // finished entries keeps the newest ones. Live work is never capped.
  let finishedKept = 0;
  return sorted.filter((task) => {
    if (!isFinished(task.status)) return true;
    finishedKept += 1;
    return finishedKept <= PROVIDER_TASK_FINISHED_MAX_COUNT;
  });
}

/**
 * Only confidently-live work counts as active. A stale task is excluded on
 * purpose: counting it produced the "4 running" badge for four processes that
 * had not existed for hours.
 */
export function isProviderTaskActive(task: ProviderTask): boolean {
  return task.status === "running";
}

export function countActiveProviderTasks(tasks: ReadonlyArray<ProviderTask>): number {
  return tasks.filter(isProviderTaskActive).length;
}

export interface ProviderTaskPage {
  readonly items: ReadonlyArray<ProviderTask>;
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
}

/**
 * One page of tasks. The page index is clamped rather than trusted, because the
 * list shrinks underneath the panel as tasks age out — a held page index would
 * otherwise land past the end and render empty.
 */
export function pageProviderTasks(
  tasks: ReadonlyArray<ProviderTask>,
  page: number,
  pageSize: number = PROVIDER_TASK_PAGE_SIZE,
): ProviderTaskPage {
  const size = Math.max(1, pageSize);
  const pageCount = Math.max(1, Math.ceil(tasks.length / size));
  const clamped = Math.min(Math.max(0, Math.trunc(page)), pageCount - 1);
  const start = clamped * size;
  return {
    items: tasks.slice(start, start + size),
    page: clamped,
    pageCount,
    total: tasks.length,
  };
}

/**
 * Whether the panel has anything worth showing. Finished tasks stay visible for
 * the rest of the turn so a sub-agent that failed is not erased by completing.
 */
export function shouldShowProviderTaskPanel(tasks: ReadonlyArray<ProviderTask>): boolean {
  return tasks.length > 0;
}

/**
 * Where the task panel renders. `split` shares the right panel column (or
 * sheet on phones) with the surface tabs; `hidden` when there is nothing to
 * show or the panel is collapsed.
 */
export type ProviderTaskPanelPlacement = "hidden" | "split";

export function resolveProviderTaskPanelPlacement(input: {
  readonly hasTasks: boolean;
  readonly rightPanelOpen: boolean;
}): ProviderTaskPanelPlacement {
  if (!input.hasTasks) return "hidden";
  if (!input.rightPanelOpen) return "hidden";
  return "split";
}

const TASK_TYPE_LABELS: Record<string, string> = {
  local_agent: "Sub-agent",
  local_bash: "Background command",
  remote_agent: "Remote agent",
};

/**
 * Label for the composer chip.
 *
 * Running and stale are counted separately and worded differently: "2 running"
 * is a claim about live work, while stale work is reported as unaccounted for
 * rather than folded into a number that would overstate what is happening.
 */
export function providerTaskChipLabel(tasks: ReadonlyArray<ProviderTask>): string | null {
  const running = countActiveProviderTasks(tasks);
  const stale = tasks.filter((task) => task.status === "stale").length;
  if (running > 0) {
    return stale > 0
      ? `${running} running · ${stale} stalled`
      : `${running} running task${running === 1 ? "" : "s"}`;
  }
  if (stale > 0) return `${stale} stalled task${stale === 1 ? "" : "s"}`;
  return null;
}

export function providerTaskTypeLabel(task: ProviderTask): string {
  if (task.taskType === null) return "Task";
  return TASK_TYPE_LABELS[task.taskType] ?? task.taskType;
}

function formatSilence(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The stale label states what we observed — silence — rather than asserting the
 * task is alive or dead. We genuinely do not know which.
 */
export function providerTaskStatusLabel(task: ProviderTask, nowMs: number = Date.now()): string {
  switch (task.status) {
    case "running":
      return task.lastToolName ? `Running · ${task.lastToolName}` : "Running";
    case "stale": {
      const updatedMs = Date.parse(task.updatedAt);
      const silence = Number.isNaN(updatedMs) ? null : formatSilence(nowMs - updatedMs);
      return silence ? `No updates for ${silence}` : "No recent updates";
    }
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

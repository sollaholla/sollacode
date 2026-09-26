import type { TurnId } from "@t3tools/contracts";

export interface CodexBackgroundTask {
  readonly providerThreadId: string;
  readonly discovered?: boolean;
  readonly started?: boolean;
  readonly metadataUpdated?: boolean;
  announced?: boolean;
  parentTurnId?: TurnId;
  nativeTurnId?: string;
  title: string;
  status: "running" | "completed" | "failed" | "stopped";
  summary?: string;
  lastToolName?: string;
  totalTokens?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export const CODEX_BACKGROUND_TASK_METHOD = "codex/backgroundTask/updated";
export const codexBackgroundTaskId = (providerThreadId: string) =>
  `codex-subagent:${providerThreadId}`;

function codexBackgroundTaskTitle(thread: Record<string, unknown> | undefined): string | undefined {
  const source = record(thread?.source);
  const spawn = record(record(source?.subAgent ?? source?.subagent)?.thread_spawn);
  const name =
    text(spawn?.agent_path) ??
    text(thread?.agentPath) ??
    text(thread?.agent_path) ??
    text(thread?.agentNickname) ??
    text(spawn?.agent_nickname) ??
    text(thread?.name);
  return name ? `Codex subagent ${name}` : undefined;
}

/** Metadata reads enrich identity only; a read cannot restart or finish a live child. */
export function updateCodexBackgroundTaskMetadata(
  tasks: Map<string, CodexBackgroundTask>,
  providerThreadId: string,
  response: unknown,
): CodexBackgroundTask | null {
  const thread = record(record(response)?.thread);
  const task = tasks.get(providerThreadId);
  if (!task || thread?.id !== providerThreadId) return null;
  const title = codexBackgroundTaskTitle(thread);
  if (!title || title === task.title) return null;
  task.title = title;
  return { ...task, metadataUpdated: true };
}

/**
 * Codex v2 broadcasts native child notifications on the parent's transport.
 * Conversation identity, not old collab receiver registration, is the boundary.
 * `undefined` means a root/session event; `null` means a child event with no UI update.
 */
export function routeCodexBackgroundNotification(input: {
  readonly rootProviderThreadId: string | undefined;
  readonly rootTurnId: TurnId | undefined;
  readonly method: string;
  readonly params: unknown;
  readonly tasks: Map<string, CodexBackgroundTask>;
}): CodexBackgroundTask | null | undefined {
  const params = record(input.params);
  const thread = record(params?.thread);
  const providerThreadId =
    text(params?.threadId) ?? (input.method === "thread/started" ? text(thread?.id) : undefined);
  if (!providerThreadId || providerThreadId === input.rootProviderThreadId) return undefined;
  if (!input.rootProviderThreadId) return null;
  let task = input.tasks.get(providerThreadId);
  const isNew = !task;
  if (!task) {
    task = {
      providerThreadId,
      title: `Codex subagent ${providerThreadId.slice(0, 8)}`,
      status: "running",
      ...(input.rootTurnId ? { parentTurnId: input.rootTurnId } : {}),
    };
    input.tasks.set(providerThreadId, task);
  }
  const title = codexBackgroundTaskTitle(thread);
  if (title) task.title = title;
  const previousTurnId = task.nativeTurnId;
  const previousStatus = task.status;
  const nativeTurnId = text(params?.turnId) ?? text(record(params?.turn)?.id);
  if (nativeTurnId) task.nativeTurnId = nativeTurnId;
  const snapshot = () => {
    const discovered = !task.announced;
    const started =
      !discovered &&
      input.method === "turn/started" &&
      (previousStatus !== "running" || (!!previousTurnId && previousTurnId !== nativeTurnId));
    task.announced = true;
    return {
      ...task,
      ...(discovered ? { discovered: true } : {}),
      ...(started ? { started: true } : {}),
    };
  };
  const item = record(params?.item);
  switch (input.method) {
    case "thread/started":
      if (record(thread?.status)?.type === "idle") {
        task.status = "completed";
        return null;
      }
      task.status = "running";
      task.summary = "Working in the background";
      return snapshot();
    case "turn/started":
      task.status = "running";
      task.summary = "Working in the background";
      if (input.rootTurnId) task.parentTurnId = input.rootTurnId;
      return snapshot();
    case "thread/name/updated": {
      const name = text(params?.threadName);
      if (name) task.title = `Codex subagent ${name}`;
      return snapshot();
    }
    case "thread/tokenUsage/updated": {
      const usage = record(params?.tokenUsage);
      const total = record(usage?.total)?.totalTokens;
      if (typeof total === "number" && Number.isFinite(total) && total >= 0)
        task.totalTokens = total;
      return { ...snapshot(), ...(task.status !== "running" ? { metadataUpdated: true } : {}) };
    }
    case "item/started": {
      const type = text(item?.type);
      if (type && type !== "agentMessage" && type !== "reasoning" && type !== "userMessage") {
        const toolLabels: Record<string, string> = {
          commandExecution: "command",
          fileChange: "file edit",
          mcpToolCall: "MCP tool",
          webSearch: "web search",
          collabAgentToolCall: "subagent coordination",
        };
        task.lastToolName = text(item?.tool) ?? toolLabels[type] ?? type;
        task.summary = `Running ${task.lastToolName}`;
        return snapshot();
      }
      break;
    }
    case "item/completed":
      if (item?.type === "agentMessage") {
        const message = text(item.text);
        if (message) task.summary = message.slice(0, 16000);
        return snapshot();
      }
      break;
    case "turn/completed": {
      const status = record(params?.turn)?.status;
      task.status =
        status === "failed" ? "failed" : status === "interrupted" ? "stopped" : "completed";
      if (!task.summary) task.summary = `Background task ${task.status}`;
      return snapshot();
    }
    case "thread/closed":
      task.status = "stopped";
      return snapshot();
    case "error":
      task.summary = text(record(params?.error)?.message) ?? "Background provider error";
      if (params?.willRetry !== true) task.status = "failed";
      return snapshot();
  }
  // Announce a child discovered after resume even if its first frame is a delta.
  // Later token/reasoning/command frames remain confined to its native transcript.
  return isNew ? snapshot() : null;
}

export function codexBackgroundStopTarget(
  tasks: ReadonlyMap<string, CodexBackgroundTask>,
  taskId: string,
  rootProviderThreadId: string | undefined,
): { threadId: string; turnId: string } | null {
  const task = [...tasks.values()].find(
    (entry) => codexBackgroundTaskId(entry.providerThreadId) === taskId,
  );
  return task &&
    task.providerThreadId !== rootProviderThreadId &&
    task.status === "running" &&
    task.nativeTurnId
    ? { threadId: task.providerThreadId, turnId: task.nativeTurnId }
    : null;
}

// xAI sends its vendor notifications under both spellings: the bare namespace
// and the underscore-prefixed form that marks an extension in ACP. Matching is
// exact, so a method list carrying only one of them silently drops the other -
// which is how a completed background task could arrive and never be recorded.
// Nothing outside xAI produces an `x.ai/` method, so accepting both only ever
// widens recognition of their own traffic.
export const GROK_SESSION_UPDATE_METHODS = ["x.ai/session/update", "_x.ai/session/update"] as const;

export const GROK_TASK_BACKGROUNDED_METHODS = [
  "x.ai/task_backgrounded",
  "_x.ai/task_backgrounded",
] as const;

export const GROK_TASK_COMPLETED_METHODS = ["x.ai/task_completed", "_x.ai/task_completed"] as const;

export const GROK_TASK_KILL_METHODS = ["x.ai/task/kill", "_x.ai/task/kill"] as const;

export const GROK_BACKGROUND_TASK_NOTIFICATION_METHODS = [
  ...GROK_SESSION_UPDATE_METHODS,
  ...GROK_TASK_BACKGROUNDED_METHODS,
  ...GROK_TASK_COMPLETED_METHODS,
] as const;

const TASK_DESCRIPTION_MAX_CHARS = 160;

export type GrokBackgroundTaskStatus = "completed" | "failed" | "stopped";

export type GrokBackgroundTaskNotification =
  | {
      readonly kind: "started";
      readonly taskId: string;
      readonly taskType: string;
      readonly description?: string;
    }
  | {
      readonly kind: "completed";
      readonly taskId: string;
      readonly taskType?: string;
      readonly status: GrokBackgroundTaskStatus;
      readonly summary?: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function firstMeaningfulLine(value: string): string {
  const lines = value.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return value.trim();
}

function stripAnsi(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === "[") {
      const end = value.indexOf("m", index + 2);
      if (end === -1) {
        result += value.slice(index);
        break;
      }
      index = end + 1;
      continue;
    }
    result += value[index];
    index += 1;
  }
  return result;
}

function clipped(value: string, maxChars = TASK_DESCRIPTION_MAX_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function taskIdFrom(value: unknown): string | undefined {
  return nonEmptyString(value);
}

function grokTaskType(kind: string | undefined, fallback: string): string {
  switch (kind) {
    case "bash":
    case "shell":
    case "command":
      return "local_bash";
    case "agent":
    case "subagent":
      return "local_agent";
    default:
      return fallback;
  }
}

function descriptionFromBackgrounded(update: Record<string, unknown>): string | undefined {
  const description = nonEmptyString(update.description);
  if (description) return clipped(firstMeaningfulLine(description));
  const command = nonEmptyString(update.command);
  if (command) return clipped(firstMeaningfulLine(command));
  return undefined;
}

function lastOutputLine(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const cleaned = stripAnsi(output);
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  return last ? clipped(last) : undefined;
}

function completedStatus(snapshot: Record<string, unknown>): GrokBackgroundTaskStatus {
  if (snapshot.explicitly_killed === true) return "stopped";
  const exitCode =
    typeof snapshot.exit_code === "number" && Number.isFinite(snapshot.exit_code)
      ? snapshot.exit_code
      : undefined;
  if (exitCode !== undefined && exitCode !== 0) return "failed";
  if (nonEmptyString(snapshot.signal)) return "failed";
  if (snapshot.completed === false) return "failed";
  return "completed";
}

function completedSummary(
  snapshot: Record<string, unknown>,
  status: GrokBackgroundTaskStatus,
): string | undefined {
  if (status === "stopped") return "Stopped";
  if (status === "failed") {
    const exitCode =
      typeof snapshot.exit_code === "number" && Number.isFinite(snapshot.exit_code)
        ? snapshot.exit_code
        : undefined;
    const signal = nonEmptyString(snapshot.signal);
    if (exitCode !== undefined) return `Exit ${exitCode}`;
    if (signal) return `Signal ${signal}`;
    return "Failed";
  }
  return (
    lastOutputLine(nonEmptyString(snapshot.output)) ??
    nonEmptyString(snapshot.description) ??
    "Completed"
  );
}

function unwrapUpdate(raw: unknown, method?: string): Record<string, unknown> | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  if (typeof envelope.sessionUpdate === "string") {
    return envelope;
  }
  const nested = asRecord(envelope.update);
  if (nested) {
    return nested;
  }
  if (method && GROK_TASK_BACKGROUNDED_METHODS.includes(method as never)) {
    return { ...envelope, sessionUpdate: "task_backgrounded" };
  }
  if (method && GROK_TASK_COMPLETED_METHODS.includes(method as never)) {
    return { ...envelope, sessionUpdate: "task_completed" };
  }
  return envelope;
}

export function parseGrokBackgroundTaskNotification(
  raw: unknown,
  method?: string,
): GrokBackgroundTaskNotification | undefined {
  const update = unwrapUpdate(raw, method);
  if (!update) return undefined;

  const sessionUpdate = nonEmptyString(update.sessionUpdate);
  if (sessionUpdate === "task_backgrounded") {
    const taskId = taskIdFrom(update.task_id) ?? taskIdFrom(update.taskId);
    if (!taskId) return undefined;
    const description = descriptionFromBackgrounded(update);
    return {
      kind: "started",
      taskId,
      taskType: grokTaskType(nonEmptyString(update.kind), "local_bash"),
      ...(description ? { description } : {}),
    };
  }

  if (sessionUpdate === "task_completed") {
    const snapshot = asRecord(update.task_snapshot) ?? update;
    const taskId =
      taskIdFrom(snapshot.task_id) ??
      taskIdFrom(snapshot.taskId) ??
      taskIdFrom(update.task_id) ??
      taskIdFrom(update.taskId);
    if (!taskId) return undefined;
    const status = completedStatus(snapshot);
    const summary = completedSummary(snapshot, status);
    const taskType = grokTaskType(nonEmptyString(snapshot.kind), "");
    return {
      kind: "completed",
      taskId,
      status,
      ...(taskType ? { taskType } : {}),
      ...(summary ? { summary } : {}),
    };
  }

  return undefined;
}

export function grokTaskKillPayload(input: {
  readonly sessionId: string;
  readonly taskId: string;
}): { readonly sessionId: string; readonly taskId: string } {
  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
  };
}

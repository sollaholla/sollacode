import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";

export const THREAD_EXPORT_SCHEMA = "solla.thread-handoff";
export const THREAD_EXPORT_SCHEMA_VERSION = 1;
export const LARGE_THREAD_EXPORT_TURN_THRESHOLD = 500;

const SENSITIVE_KEY =
  /(^|[_-])(api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|session[_-]?key|token)($|[_-])/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(api[_-]?key|password|secret|token)\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
] as const;

export function redactSensitiveString(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function sanitizeThreadExportValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactSensitiveString(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value;
  }
  if (depth >= 24) return "[TRUNCATED: maximum nesting depth]";
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeThreadExportValue(entry, "", depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeThreadExportValue(entryValue, entryKey, depth + 1),
      ]),
    );
  }
  return String(value);
}

export function countThreadTurns(thread: EnvironmentThread): number {
  const turnIds = new Set<string>();
  const add = (turnId: string | null | undefined) => {
    if (turnId) turnIds.add(turnId);
  };
  add(thread.latestTurn?.turnId);
  thread.messages.forEach((message) => add(message.turnId));
  thread.activities.forEach((activity) => add(activity.turnId));
  thread.proposedPlans.forEach((plan) => add(plan.turnId));
  thread.checkpoints.forEach((checkpoint) => add(checkpoint.turnId));
  return turnIds.size;
}

function safeFilenamePart(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized || "conversation";
}

export function threadExportFilename(thread: EnvironmentThread, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${safeFilenamePart(thread.title)}-${timestamp}.json`;
}

export function buildThreadHandoff(thread: EnvironmentThread, exportedAt = new Date()) {
  const messages = thread.messages.map((message) => ({
    ...message,
    text: redactSensitiveString(message.text),
    ...(message.attachments ? { attachments: sanitizeThreadExportValue(message.attachments) } : {}),
  }));
  const events = thread.activities.map((activity) => ({
    ...activity,
    summary: redactSensitiveString(activity.summary),
    payload: sanitizeThreadExportValue(activity.payload),
  }));
  const attachmentManifest = thread.messages.flatMap((message) =>
    (message.attachments ?? []).map((attachment) => ({
      messageId: message.id,
      data: sanitizeThreadExportValue(attachment),
    })),
  );
  const timeline = [
    ...messages.map((message) => ({
      type: "message" as const,
      at: message.createdAt,
      turnId: message.turnId,
      data: message,
    })),
    ...events.map((event) => ({
      type: "event" as const,
      at: event.createdAt,
      turnId: event.turnId,
      data: event,
    })),
    ...thread.proposedPlans.map((plan) => ({
      type: "proposed-plan" as const,
      at: plan.createdAt,
      turnId: plan.turnId,
      data: sanitizeThreadExportValue(plan),
    })),
    ...thread.checkpoints.map((checkpoint) => ({
      type: "checkpoint" as const,
      at: checkpoint.completedAt,
      turnId: checkpoint.turnId,
      data: sanitizeThreadExportValue(checkpoint),
    })),
  ].sort((left, right) => {
    const byTime = Date.parse(left.at) - Date.parse(right.at);
    if (byTime !== 0) return byTime;
    return left.type.localeCompare(right.type);
  });

  return {
    schema: THREAD_EXPORT_SCHEMA,
    schemaVersion: THREAD_EXPORT_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    purpose: "Complete conversation handoff for continuation by another agent or tool.",
    metadata: {
      environmentId: thread.environmentId,
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      turnCount: countThreadTurns(thread),
    },
    providerRuntime: {
      modelSelection: sanitizeThreadExportValue(thread.modelSelection),
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      session:
        thread.session === null
          ? null
          : {
              status: thread.session.status,
              providerName: thread.session.providerName,
              providerInstanceId: thread.session.providerInstanceId,
              runtimeMode: thread.session.runtimeMode,
              activeTurnId: thread.session.activeTurnId,
              lastError:
                thread.session.lastError === null
                  ? null
                  : redactSensitiveString(thread.session.lastError),
              updatedAt: thread.session.updatedAt,
            },
      latestTurn: sanitizeThreadExportValue(thread.latestTurn),
    },
    conversation: {
      messages,
      events,
      timeline,
      proposedPlans: sanitizeThreadExportValue(thread.proposedPlans),
      checkpoints: sanitizeThreadExportValue(thread.checkpoints),
    },
    attachments: {
      includedInline: false,
      manifest: attachmentManifest,
      note: "Attachment metadata and stable references are included; local binary contents are not duplicated.",
    },
    safety: {
      credentialsIncluded: false,
      redaction:
        "Sensitive key names and common credential/token value patterns are replaced with [REDACTED].",
    },
  };
}

export function serializeThreadHandoff(thread: EnvironmentThread, exportedAt = new Date()): string {
  return JSON.stringify(buildThreadHandoff(thread, exportedAt), null, 2);
}

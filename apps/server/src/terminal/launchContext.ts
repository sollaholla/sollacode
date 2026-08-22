/**
 * Persisted terminal launch context — everything the server needs to bring a
 * session back after its own restart, without waiting for a client to focus
 * the pane. One `.launch.json` per live session, written on spawn and removed
 * when the session ends on purpose (shell exit, explicit close). A file that
 * survives a server shutdown therefore marks a session that was still running
 * and should be restored at the next boot.
 */

export interface TerminalLaunchContext {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly runtimeEnv: Record<string, string> | null;
  readonly cols: number;
  readonly rows: number;
}

export const TERMINAL_LAUNCH_CONTEXT_SUFFIX = ".launch.json";

export function launchContextFilePath(historyLogPath: string): string {
  return historyLogPath.endsWith(".log")
    ? `${historyLogPath.slice(0, -".log".length)}${TERMINAL_LAUNCH_CONTEXT_SUFFIX}`
    : `${historyLogPath}${TERMINAL_LAUNCH_CONTEXT_SUFFIX}`;
}

export function isLaunchContextFileName(name: string): boolean {
  return name.endsWith(TERMINAL_LAUNCH_CONTEXT_SUFFIX);
}

export function encodeTerminalLaunchContext(
  context: TerminalLaunchContext,
  updatedAt: string,
): string {
  return `${JSON.stringify({
    v: 1,
    threadId: context.threadId,
    terminalId: context.terminalId,
    cwd: context.cwd,
    worktreePath: context.worktreePath,
    runtimeEnv: context.runtimeEnv,
    cols: context.cols,
    rows: context.rows,
    updatedAt,
  })}\n`;
}

function normalizedRuntimeEnvValue(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => entry[0].length > 0 && typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function parseTerminalLaunchContext(raw: string): TerminalLaunchContext | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== 1) {
    return null;
  }
  const threadId = typeof candidate.threadId === "string" ? candidate.threadId.trim() : "";
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const cwd = typeof candidate.cwd === "string" ? candidate.cwd.trim() : "";
  if (threadId.length === 0 || terminalId.length === 0 || cwd.length === 0) {
    return null;
  }
  const worktreePath =
    typeof candidate.worktreePath === "string" && candidate.worktreePath.trim().length > 0
      ? candidate.worktreePath
      : null;
  const cols =
    typeof candidate.cols === "number" && Number.isInteger(candidate.cols) && candidate.cols > 0
      ? candidate.cols
      : null;
  const rows =
    typeof candidate.rows === "number" && Number.isInteger(candidate.rows) && candidate.rows > 0
      ? candidate.rows
      : null;
  if (cols === null || rows === null) {
    return null;
  }
  return {
    threadId,
    terminalId,
    cwd,
    worktreePath,
    runtimeEnv: normalizedRuntimeEnvValue(candidate.runtimeEnv),
    cols,
    rows,
  };
}

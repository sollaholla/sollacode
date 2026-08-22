/**
 * Per-provider resume for agent CLIs that were running in a thread terminal.
 *
 * `--continue` / `--last` always picks the most recent session for the cwd, so
 * two Grok panes in the same project would collide. When we have a session id,
 * each CLI gets its own id-specific launch line (`grok --resume <id>`,
 * `claude --resume <id>`, `codex resume <id>`). Without an id we do not guess.
 */
const AGENT_CLI_COMMANDS = new Set([
  "claude",
  "grok",
  "codex",
  "cursor",
  "cursor-agent",
  "opencode",
]);

export interface AgentCliResumeState {
  readonly command: string;
  readonly sessionId: string | null;
  readonly resumeOnRestore: boolean;
}

/** Minimum pause after spawn so a login shell can start reading. */
export const AGENT_CLI_RESTORE_MIN_DELAY_MS = 400;
/** Give slow prompts (zsh plugins) time to print before we type. */
export const AGENT_CLI_RESTORE_MAX_WAIT_MS = 1500;
export const AGENT_CLI_RESTORE_POLL_MS = 50;

const SHELL_PROMPT_TAIL = /[%$#>]\s*$/;

/**
 * True when the PTY looks like it is sitting at a prompt, not still printing
 * motd / zsh session restore. Any-output was too eager: macOS zsh prints
 * "Restored session: …" and then `rm`s a session file, which ate the resume
 * line we typed.
 */
export function historyLooksLikeShellPrompt(history: string): boolean {
  if (history.trim().length === 0) {
    return false;
  }
  const lines = history.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.replace(/\s+$/g, "") ?? "";
    if (line.length === 0) {
      continue;
    }
    if (/Restored session:/i.test(line) || /^rm:\s/i.test(line)) {
      return false;
    }
    return SHELL_PROMPT_TAIL.test(line);
  }
  return false;
}

/**
 * Type the resume line unless that CLI is already in the foreground.
 * zsh helpers (gitstatusd, p10k) also show up as children; treating any
 * child as "busy" skipped the keystrokes and left TUI history on screen.
 */
export function shouldTypeAgentCliResume(input: {
  readonly targetCommand: string;
  readonly runningCommand: string | null;
}): boolean {
  if (input.runningCommand === null) {
    return true;
  }
  return input.runningCommand.trim().toLowerCase() !== input.targetCommand.trim().toLowerCase();
}

export function isAgentCliCommand(command: string | null | undefined): command is string {
  if (command === null || command === undefined) {
    return false;
  }
  const normalized = command.trim().toLowerCase();
  return normalized.length > 0 && AGENT_CLI_COMMANDS.has(normalized);
}

function processPathBasename(token: string): string {
  const trimmed = token.trim().replace(/^["']|["']$/g, "");
  const base = (trimmed.split(/[/\\]/).pop() ?? trimmed).trim();
  return base.replace(/\.(js|mjs|cjs|exe|cmd|bat|ps1)$/i, "");
}

/** Basename of a process comm/path, minus Windows shims and node script suffixes. */
export function normalizeChildCommandName(raw: string): string | null {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const firstToken = (trimmed.split(/\s+/)[0] ?? trimmed).trim();
  if (firstToken.length === 0) return null;
  const base = processPathBasename(firstToken);
  return base.length > 0 ? base : null;
}

/**
 * npm/Homebrew installs of Claude often show up as `node …/claude-code/cli.js`
 * rather than a `claude` comm name. Walk comm + argv for the real agent CLI.
 */
export function agentCliCommandFromProcess(
  comm: string | null | undefined,
  args: string | null | undefined,
): string | null {
  const commBase = comm ? processPathBasename(comm).toLowerCase() : "";
  if (isAgentCliCommand(commBase)) {
    return commBase;
  }
  if (!args || args.trim().length === 0) {
    return null;
  }
  const tokens = tokenizeProcessArgs(args);
  for (const token of tokens) {
    if (looksLikeFlag(token)) {
      continue;
    }
    const base = processPathBasename(token).toLowerCase();
    if (isAgentCliCommand(base)) {
      return base;
    }
    if (base === "cli" && /claude-code|@anthropic-ai[/\\]claude/i.test(token)) {
      return "claude";
    }
    if (
      /@openai[/\\]codex/i.test(token) ||
      /(?:^|[/\\])codex(?:\.js|\.mjs|\.cjs|\.cmd)?$/i.test(token)
    ) {
      return "codex";
    }
    if (/@xai[/\\]grok|(?:^|[/\\])grok(?:\.js|\.mjs|\.cjs|\.cmd)?$/i.test(token)) {
      return "grok";
    }
  }
  return null;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Id-specific resume lines. Cursor and OpenCode are recognized as agent CLIs
 * but have no confirmed session-id resume flag here, so they return null.
 */
export function agentCliResumeShellCommand(
  command: string,
  sessionId: string | null | undefined,
): string | null {
  if (!isAgentCliCommand(command)) {
    return null;
  }
  const id = sessionId?.trim() ?? "";
  if (id.length === 0) {
    return null;
  }
  const quoted = shellQuote(id);
  switch (command.trim().toLowerCase()) {
    case "grok":
      return `grok --resume ${quoted}`;
    case "claude":
      return `claude --resume ${quoted}`;
    case "codex":
      return `codex resume ${quoted}`;
    default:
      return null;
  }
}

export function agentCliResumeShellInput(
  command: string,
  sessionId: string | null | undefined,
): string | null {
  const shellCommand = agentCliResumeShellCommand(command, sessionId);
  // Leading CR drops a half-typed line so the resume command hits a prompt.
  return shellCommand === null ? null : `\r${shellCommand}\r`;
}

export function canResumeAgentCli(state: AgentCliResumeState | null | undefined): boolean {
  if (!state?.resumeOnRestore) {
    return false;
  }
  if (agentCliResumeShellInput(state.command, state.sessionId) !== null) {
    return true;
  }
  // Claude 2.1 often has no captured id until after the first poll. We still
  // try to resume by resolving the newest project transcript at restore time.
  return state.command.trim().toLowerCase() === "claude";
}

/** Persist a restore attempt whenever we have an id, or Claude may still be recoverable. */
export function shouldMarkAgentResumeOnRestore(
  command: string,
  sessionId: string | null | undefined,
): boolean {
  if (sessionId?.trim()) {
    return true;
  }
  return command.trim().toLowerCase() === "claude";
}

/**
 * Claude stores project transcripts under `~/.claude/projects/<encoded-cwd>/`.
 * Non-alphanumeric path characters become `-`, matching Claude Code's encoder.
 */
export function claudeProjectDirectoryName(cwd: string): string {
  const trimmed = cwd.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.replace(/[^A-Za-z0-9]/g, "-");
}

/** TUI history is unusable if we cannot bring that CLI session back. */
export function shouldClearHistoryOnFailedResume(
  state: AgentCliResumeState | null | undefined,
): boolean {
  return state?.resumeOnRestore === true && !canResumeAgentCli(state);
}

export function resumeStateFilePath(historyLogPath: string): string {
  return historyLogPath.endsWith(".log")
    ? `${historyLogPath.slice(0, -".log".length)}.resume.json`
    : `${historyLogPath}.resume.json`;
}

export function encodeAgentCliResumeState(state: AgentCliResumeState, updatedAt: string): string {
  return `${JSON.stringify({
    v: 2,
    command: state.command,
    sessionId: state.sessionId,
    resumeOnRestore: state.resumeOnRestore,
    updatedAt,
  })}\n`;
}

export function parseAgentCliResumeState(raw: string): AgentCliResumeState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.command !== "string" || typeof record.resumeOnRestore !== "boolean") {
      return null;
    }
    const command = record.command.trim();
    if (!isAgentCliCommand(command)) {
      return null;
    }
    const sessionId =
      typeof record.sessionId === "string" && record.sessionId.trim().length > 0
        ? record.sessionId.trim()
        : null;
    return { command, sessionId, resumeOnRestore: record.resumeOnRestore };
  } catch {
    return null;
  }
}

const FLAG_WITH_VALUE = new Set(["--resume", "-r", "--session-id", "-s"]);

function tokenizeProcessArgs(args: string): string[] {
  return (args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((token) =>
    token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token,
  );
}

function looksLikeFlag(token: string): boolean {
  return token.startsWith("-");
}

/**
 * Read a session id the CLI was already launched with. Codex uses a
 * `resume <id>` subcommand; Grok and Claude use `--resume` / `--session-id`.
 */
export function sessionIdFromProcessArgs(
  command: string,
  args: string | null | undefined,
): string | null {
  if (!args || args.trim().length === 0) {
    return null;
  }
  const tokens = tokenizeProcessArgs(args);
  const normalized = command.trim().toLowerCase();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const equalsMatch = token.match(/^--(?:resume|session-id)=(.*)$/);
    if (equalsMatch?.[1] && equalsMatch[1].length > 0 && !looksLikeFlag(equalsMatch[1])) {
      return equalsMatch[1];
    }
    if (FLAG_WITH_VALUE.has(token)) {
      const next = tokens[index + 1] ?? "";
      if (next.length > 0 && !looksLikeFlag(next)) {
        return next;
      }
    }
    if (normalized === "codex" && token === "resume") {
      const next = tokens[index + 1] ?? "";
      if (next.length > 0 && !looksLikeFlag(next)) {
        return next;
      }
    }
  }
  return null;
}

export interface GrokActiveSessionEntry {
  readonly session_id: string;
  readonly pid: number;
}

/** Claude 2.1 writes one file per live process at `~/.claude/sessions/<pid>.json`. */
export interface ClaudeActiveSessionEntry {
  readonly sessionId: string;
  readonly pid: number;
}

export function claudeActiveSessionFileName(pid: number): string {
  return `${pid}.json`;
}

export function parseClaudeActiveSession(raw: string): ClaudeActiveSessionEntry | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.sessionId !== "string" || typeof record.pid !== "number") {
      return null;
    }
    const sessionId = record.sessionId.trim();
    if (sessionId.length === 0 || !Number.isInteger(record.pid) || record.pid <= 0) {
      return null;
    }
    return { sessionId, pid: record.pid };
  } catch {
    return null;
  }
}

export function sessionIdFromClaudeActiveSessions(
  processIds: ReadonlyArray<number>,
  entries: ReadonlyArray<ClaudeActiveSessionEntry>,
): string | null {
  const pids = new Set(processIds);
  for (const entry of entries) {
    if (pids.has(entry.pid)) {
      return entry.sessionId;
    }
  }
  return null;
}

export function parseGrokActiveSessions(raw: string): ReadonlyArray<GrokActiveSessionEntry> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const entries: GrokActiveSessionEntry[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.session_id !== "string" || typeof record.pid !== "number") {
        continue;
      }
      const sessionId = record.session_id.trim();
      if (sessionId.length === 0 || !Number.isInteger(record.pid) || record.pid <= 0) {
        continue;
      }
      entries.push({ session_id: sessionId, pid: record.pid });
    }
    return entries;
  } catch {
    return [];
  }
}

export function sessionIdFromGrokActiveSessions(
  processIds: ReadonlyArray<number>,
  entries: ReadonlyArray<GrokActiveSessionEntry>,
): string | null {
  const pids = new Set(processIds);
  for (const entry of entries) {
    if (pids.has(entry.pid)) {
      return entry.session_id;
    }
  }
  return null;
}

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** A Claude session that only recorded `/tui fullscreen` is ~1.3KB. */
export const CLAUDE_EMPTY_SESSION_MAX_BYTES = 8_192;

export interface ClaudeTranscriptCandidate {
  readonly path: string;
  readonly bytes: number;
}

/**
 * Pick the session Claude should `--resume`. A failed restore starts a new
 * empty session whose jsonl is the one lsof sees first; prefer the previously
 * captured id, then the largest real transcript, and never replace a known id
 * with an empty splash session.
 */
export function selectClaudeSessionId(input: {
  readonly preferredSessionId?: string | null;
  readonly transcripts: ReadonlyArray<ClaudeTranscriptCandidate>;
}): string | null {
  const candidates: Array<{ id: string; bytes: number }> = [];
  for (const transcript of input.transcripts) {
    const id = sessionIdFromClaudeTranscriptPath(transcript.path);
    if (id) {
      candidates.push({ id, bytes: transcript.bytes });
    }
  }
  if (candidates.length === 0) {
    return input.preferredSessionId?.trim() ? input.preferredSessionId.trim() : null;
  }
  const preferred = input.preferredSessionId?.trim() ?? "";
  if (preferred.length > 0 && candidates.some((candidate) => candidate.id === preferred)) {
    return preferred;
  }
  const substantial = candidates.filter(
    (candidate) => candidate.bytes >= CLAUDE_EMPTY_SESSION_MAX_BYTES,
  );
  if (substantial.length > 0) {
    return substantial.toSorted((left, right) => right.bytes - left.bytes)[0]?.id ?? null;
  }
  if (preferred.length > 0) {
    return preferred;
  }
  return candidates[0]?.id ?? null;
}

export function sessionIdFromClaudeTranscriptPath(filePath: string): string | null {
  const base = filePath.split(/[/\\]/).pop() ?? "";
  const match = base.match(UUID_FILE);
  return match?.[1] ?? null;
}

export function sessionIdFromCodexTranscriptPath(filePath: string): string | null {
  const base = filePath.split(/[/\\]/).pop() ?? "";
  const match = base.match(
    /(?:^|-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? null;
}

export function sessionIdFromGrokSessionPath(filePath: string): string | null {
  const parts = filePath.split(/[/\\]/);
  const sessionsIndex = parts.lastIndexOf("sessions");
  if (sessionsIndex < 0) {
    return null;
  }
  const sessionId = parts[sessionsIndex + 2]?.trim() ?? "";
  return sessionId.length > 0 ? sessionId : null;
}

export function sessionIdFromOpenFiles(
  command: string,
  filePaths: ReadonlyArray<string>,
  preferredSessionId?: string | null,
): string | null {
  const normalized = command.trim().toLowerCase();
  if (normalized === "claude") {
    return selectClaudeSessionId({
      ...(preferredSessionId !== undefined ? { preferredSessionId } : {}),
      transcripts: filePaths.map((path) => ({ path, bytes: CLAUDE_EMPTY_SESSION_MAX_BYTES })),
    });
  }
  for (const filePath of filePaths) {
    if (normalized === "codex") {
      const sessionId = sessionIdFromCodexTranscriptPath(filePath);
      if (sessionId) return sessionId;
    }
    if (normalized === "grok") {
      const sessionId = sessionIdFromGrokSessionPath(filePath);
      if (sessionId) return sessionId;
    }
  }
  return null;
}

export function parseLsofNameLines(stdout: string): ReadonlyArray<string> {
  const paths: string[] = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (!line.startsWith("n")) {
      continue;
    }
    const filePath = line.slice(1).trim();
    if (filePath.length > 0) {
      paths.push(filePath);
    }
  }
  return paths;
}

/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import {
  DEFAULT_TERMINAL_ID,
  ProviderInstanceId,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  ThreadId,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalGetLayoutInput,
  type TerminalGetLayoutResult,
  type TerminalLayoutStreamEvent,
  type TerminalListInput,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalReadInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSetLayoutInput,
  type TerminalSummary,
  type TerminalThreadLayout,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  nextAgentCliWorkingState,
  terminalCommandProviderDriver,
  terminalSubprocessIsWorking,
} from "@t3tools/shared/terminalProvider";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";
import { TERMINAL_AGENT_PROVIDER_INSTANCE_ID } from "../mcp/McpServerInstructions.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as PtyAdapter from "./PtyAdapter.ts";
import {
  GROK_TERMINAL_MCP_OVERLAY,
  injectTerminalAgentAwareness,
  POSIX_TERMINAL_AGENT_LAUNCHER,
  TERMINAL_AGENT_PROVIDERS,
  WINDOWS_TERMINAL_AGENT_LAUNCHER,
  windowsTerminalAgentCommandLauncher,
} from "./agentAwareness.ts";
import {
  inspectWindowsSubprocessFromRows,
  parseWindowsCimProcessOutput,
  windowsProcessSnapshotCommand,
  type WindowsCimProcessRow,
  type WindowsSubprocessInspectResult,
} from "./windowsSubprocess.ts";
import {
  encodeTerminalLaunchContext,
  isLaunchContextFileName,
  launchContextFilePath,
  parseTerminalLaunchContext,
} from "./launchContext.ts";
import {
  encodeTerminalThreadLayout,
  isThreadLayoutFileName,
  parseTerminalThreadLayout,
  reconcileTerminalThreadLayoutGroups,
  terminalIdsInThreadLayout,
  threadLayoutFilePath,
} from "./threadLayout.ts";
import {
  AGENT_CLI_RESTORE_MAX_WAIT_MS,
  AGENT_CLI_RESTORE_MIN_DELAY_MS,
  AGENT_CLI_RESTORE_POLL_MS,
  agentCliCommandFromProcess,
  agentCliResumeShellInput,
  canResumeAgentCli,
  normalizeChildCommandName,
  claudeProjectDirectoryName,
  historyLooksLikeShellPrompt,
  shouldMarkAgentResumeOnRestore,
  shouldTypeAgentCliResume,
  encodeAgentCliResumeState,
  isAgentCliCommand,
  shouldClearHistoryOnFailedResume,
  parseAgentCliResumeState,
  parseClaudeActiveSession,
  parseGrokActiveSessions,
  parseLsofNameLines,
  resumeStateFilePath,
  selectClaudeSessionId,
  claudeActiveSessionFileName,
  sessionIdFromClaudeActiveSessions,
  sessionIdFromClaudeTranscriptPath,
  sessionIdFromGrokActiveSessions,
  sessionIdFromOpenFiles,
  sessionIdFromProcessArgs,
  type AgentCliResumeState,
  type ClaudeActiveSessionEntry,
} from "./agentCliResume.ts";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
};

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_HISTORY_BYTE_LIMIT = 512 * 1024;
const DEFAULT_PENDING_PROCESS_EVENT_BYTE_LIMIT = 256 * 1024;
/**
 * Upper bound for one coalesced output event. Big enough that a transcript
 * replay collapses into a handful of events, small enough that a single
 * websocket frame and client write stay cheap.
 */
const MAX_COALESCED_OUTPUT_CHARS = 128 * 1024;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const FINAL_SUBPROCESS_POLL_TIMEOUT_MS = 2_000;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
/** Floor under accepted PTY resizes; smaller grids are transient client layout. */
export const MIN_PTY_RESIZE_COLS = 10;
export const MIN_PTY_RESIZE_ROWS = 4;

/**
 * How long the geometry owner's claim outlives its last open/write/resize.
 * While fresh, resize requests from other clients are ignored so machines
 * viewing the same terminal cannot ping-pong the PTY between their pane
 * grids (every width swap makes ConPTY rewrap its whole buffer and
 * full-screen TUIs repaint). Once stale, any client may take over.
 */
export const TERMINAL_GEOMETRY_OWNER_STALE_MS = 60_000;
const TERMINAL_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  // macOS Terminal/iTerm assign this so /etc/zshrc_Apple_Terminal can save and
  // restore that exact GUI session. Inherited into a T3 PTY, zsh sources the
  // parent's ~/.zsh_sessions/<id>.session and `rm`s it — which races the
  // keystrokes we type to relaunch an agent CLI.
  "TERM_SESSION_ID",
]);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);

/**
 * Whether `clientId` may resize the PTY right now. Anonymous requests (old
 * clients) may only resize an unowned or stale-owned grid, so a machine the
 * user is actively typing on cannot be stomped by a passive viewer.
 */
export function geometryOwnerAllowsResize(
  session: Pick<TerminalSessionState, "geometryOwnerClientId" | "geometryOwnerActiveAtMs">,
  clientId: string | undefined,
  nowMs: number,
): boolean {
  const owner = session.geometryOwnerClientId;
  if (owner === null) return true;
  if (clientId !== undefined && owner === clientId) return true;
  const activeAt = session.geometryOwnerActiveAtMs;
  return activeAt === null || nowMs - activeAt >= TERMINAL_GEOMETRY_OWNER_STALE_MS;
}

/** Returns true when ownership moved to a different client. */
function claimGeometryOwner(
  session: TerminalSessionState,
  clientId: string | undefined,
  nowMs: number,
): boolean {
  if (clientId === undefined) return false;
  const changed = session.geometryOwnerClientId !== clientId;
  session.geometryOwnerClientId = clientId;
  session.geometryOwnerActiveAtMs = nowMs;
  return changed;
}
const MAX_TERMINAL_LABEL_LENGTH = 128;
const TERMINAL_HISTORY_TRUNCATION_MARKER = "[Earlier terminal output truncated]\n";
const TERMINAL_LIVE_TRUNCATION_MARKER =
  "\r\n[Terminal output truncated because the consumer fell behind]\r\n";
const terminalTextEncoder = new TextEncoder();
const terminalTextDecoder = new TextDecoder();

class TerminalSubprocessCheckError extends Schema.TaggedErrorClass<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    terminalPid: Schema.Number,
    command: Schema.Literals(["powershell", "pgrep", "ps"]),
  },
) {
  override get message(): string {
    return `Failed to inspect terminal subprocesses for PID ${this.terminalPid} with ${this.command}`;
  }
}

class TerminalProcessSignalError extends Schema.TaggedErrorClass<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    cause: Schema.optional(Schema.Defect()),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
    terminalPid: Schema.Number,
  },
) {
  override get message(): string {
    return `Failed to send ${this.signal} to terminal process ${this.terminalPid}`;
  }
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    /**
     * Open or attach to a terminal session.
     *
     * Reuses an existing session for the same thread/terminal id and restores
     * persisted history on first open.
     */
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Attach to a terminal and stream its initial snapshot followed by live events.
     *
     * Returns an unsubscribe function.
     */
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError>;

    /**
     * List known sessions without attaching. Optional `threadId` narrows the
     * inventory; this never spawns a pane.
     */
    readonly list: (
      input: TerminalListInput,
    ) => Effect.Effect<ReadonlyArray<TerminalSummary>, TerminalError>;

    /**
     * Return the current snapshot of an existing session, including history.
     * Does not spawn, resize, or attach a stream.
     */
    readonly read: (
      input: TerminalReadInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Write input bytes to a terminal session.
     */
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    /**
     * Resize the PTY backing a terminal session.
     */
    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

    /**
     * Clear terminal output history.
     */
    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /**
     * Restart a terminal session in place.
     *
     * Always resets history before spawning the new process.
     */
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Close an active terminal session.
     *
     * When `terminalId` is omitted, closes all sessions for the thread.
     */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

    /**
     * Subscribe to terminal runtime events with a direct callback.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /**
     * Subscribe to lightweight terminal metadata with an initial full snapshot.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /**
     * Read the server-authoritative pane layout for a thread, if any client
     * has published one.
     */
    readonly getLayout: (
      input: TerminalGetLayoutInput,
    ) => Effect.Effect<TerminalGetLayoutResult, TerminalError>;

    /**
     * Publish a thread's pane layout. Last write wins; the accepted document
     * (with its bumped revision) is broadcast to layout subscribers and
     * persisted across server restarts.
     */
    readonly setLayout: (
      input: TerminalSetLayoutInput,
    ) => Effect.Effect<TerminalThreadLayout, TerminalError>;

    /**
     * Subscribe to pane layout documents with an initial full snapshot.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribeLayouts: (
      listener: (event: TerminalLayoutStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("t3/terminal/Manager/TerminalManager") {}

interface TerminalSubprocessInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
  readonly processArgs?: string | null;
}

interface TerminalSubprocessInspector {
  (
    terminalPid: number,
  ): Effect.Effect<TerminalSubprocessInspectResult, TerminalSubprocessCheckError>;
}

const resizePtyProcess = (
  session: TerminalSessionState,
  process: PtyAdapter.PtyProcess,
  cols: number,
  rows: number,
) =>
  Effect.try({
    try: () => process.resize(cols, rows),
    catch: (cause) =>
      new TerminalResizeError({
        threadId: session.threadId,
        terminalId: session.terminalId,
        terminalPid: process.pid,
        cols,
        rows,
        cause,
      }),
  });

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  pendingProcessEventBytes: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  /** True when the foreground child is mid-turn, not an idle agent TUI. */
  working: boolean;
  /** Last time an agent TUI frame looked mid-turn; used to debounce idle. */
  workingLastBusyAtMs: number | null;
  /** When `working` last flipped on; the UI's "Working for" clock. */
  workingSince: string | null;
  /** Last time the PTY produced output; gates busy markers frozen in history. */
  lastDataAtMs: number | null;
  /** Client whose grid the PTY currently follows; see TERMINAL_GEOMETRY_OWNER_STALE_MS. */
  geometryOwnerClientId: string | null;
  /** Last open/write/resize from the owner; staleness lets another client take over. */
  geometryOwnerActiveAtMs: number | null;
  /** Normalized child command name when `hasRunningSubprocess`; cleared when idle. */
  childCommandLabel: string | null;
  /** Last known CLI session id for id-specific resume; independent of live subprocess. */
  agentCliSessionId: string | null;
  /** Ephemeral MCP credential owned only by this PTY; never persisted. */
  agentMcpProviderSessionId: string | null;
  runtimeEnv: Record<string, string> | null;
}

interface PersistHistoryRequest {
  history: string;
  immediate: boolean;
}

type PendingProcessEvent =
  | { type: "output"; data: string }
  | { type: "truncated"; data: string }
  | { type: "exit"; event: PtyAdapter.PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      sequence: number;
      history: string | null;
      data: string;
      workingChanged: boolean;
    }
  | {
      type: "exit";
      process: PtyAdapter.PtyProcess | null;
      threadId: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: number | null;
      agentMcpProviderSessionId: string | null;
    };

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyAdapter.PtyProcess, Fiber.Fiber<void, never>>;
}

function truncateTerminalWireLabel(value: string): string {
  if (value.length <= MAX_TERMINAL_LABEL_LENGTH) return value;
  return value.slice(0, MAX_TERMINAL_LABEL_LENGTH);
}

/** Windows has USERPROFILE, not HOME; without the fallback every home-dir
    lookup (grok/claude active sessions, claude transcripts — so all agent
    CLI resume detection) silently failed there. */
function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  if (typeof env.HOME === "string" && env.HOME.length > 0) {
    return env.HOME;
  }
  if (typeof env.USERPROFILE === "string" && env.USERPROFILE.length > 0) {
    return env.USERPROFILE;
  }
  return "";
}

function looksSessionBusy(session: TerminalSessionState): boolean {
  return terminalSubprocessIsWorking({
    hasRunningSubprocess: session.hasRunningSubprocess,
    command: session.childCommandLabel,
    history: session.history,
  });
}

/** Returns true when `session.working` changed. */
function sampleSessionWorking(session: TerminalSessionState, nowMs: number): boolean {
  const looksBusy = looksSessionBusy(session);
  if (terminalCommandProviderDriver(session.childCommandLabel) === null) {
    const changed = looksBusy !== session.working;
    session.working = looksBusy;
    session.workingLastBusyAtMs = null;
    if (changed) {
      session.workingSince = looksBusy ? DateTime.formatIso(DateTime.makeUnsafe(nowMs)) : null;
    }
    return changed;
  }
  const next = nextAgentCliWorkingState({
    currentlyWorking: session.working,
    looksBusy,
    lastBusyAtMs: session.workingLastBusyAtMs,
    nowMs,
    lastOutputAtMs: session.lastDataAtMs,
  });
  const changed = next.working !== session.working;
  session.working = next.working;
  session.workingLastBusyAtMs = next.lastBusyAtMs;
  if (changed) {
    session.workingSince = next.working ? DateTime.formatIso(DateTime.makeUnsafe(nowMs)) : null;
  }
  return changed;
}

function terminalWireLabel(session: TerminalSessionState): string {
  if (session.hasRunningSubprocess && session.childCommandLabel) {
    const trimmed = session.childCommandLabel.trim();
    if (trimmed.length > 0) {
      return truncateTerminalWireLabel(trimmed);
    }
  }
  return truncateTerminalWireLabel(getTerminalLabel(session.terminalId));
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
    cols: session.cols,
    rows: session.rows,
  };
}

function summary(session: TerminalSessionState): TerminalSummary {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    working: session.working,
    ...(session.workingSince !== null ? { workingSince: session.workingSince } : {}),
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
    cols: session.cols,
    rows: session.rows,
    ...(session.geometryOwnerClientId !== null
      ? { geometryOwner: session.geometryOwnerClientId }
      : {}),
  };
}

function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean {
  switch (event.type) {
    case "started":
    case "restarted":
    case "exited":
    case "closed":
    case "error":
    case "activity":
      return true;
    case "output":
    case "cleared":
      return false;
  }
}

function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return {
        type: "snapshot",
        snapshot: event.snapshot,
      };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
  }
}

function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
) {
  return typeof event.sequence === "number" && typeof initialSnapshot.sequence === "number"
    ? event.sequence <= initialSnapshot.sequence
    : event.type === "started" &&
        event.snapshot.threadId === initialSnapshot.threadId &&
        event.snapshot.terminalId === initialSnapshot.terminalId &&
        event.snapshot.updatedAt <= initialSnapshot.updatedAt;
}

function advanceEventSequence(session: TerminalSessionState): {
  readonly updatedAt: string;
  readonly sequence: number;
} {
  const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  session.eventSequence += 1;
  session.updatedAt = updatedAt;
  return { updatedAt, sequence: session.eventSequence };
}

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

function terminalUtf8ByteLength(value: string): number {
  return terminalTextEncoder.encode(value).byteLength;
}

function trimTerminalTextToUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = terminalTextEncoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;

  let start = encoded.byteLength - maxBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    start += 1;
  }
  return terminalTextDecoder.decode(encoded.subarray(start));
}

function compactProcessedEvents(session: TerminalSessionState): void {
  if (session.pendingProcessEventIndex <= 0) return;
  session.pendingProcessEvents = session.pendingProcessEvents.slice(
    session.pendingProcessEventIndex,
  );
  session.pendingProcessEventIndex = 0;
}

function boundPendingOutputEvents(session: TerminalSessionState, maxPendingBytes: number): void {
  if (session.pendingProcessEventBytes <= maxPendingBytes) return;

  const exitEvents = session.pendingProcessEvents.filter((event) => event.type === "exit");
  const output = session.pendingProcessEvents
    .filter((event) => event.type === "output")
    .map((event) => event.data)
    .join("");
  const markerBytes = terminalUtf8ByteLength(TERMINAL_LIVE_TRUNCATION_MARKER);
  const retainedOutput = trimTerminalTextToUtf8Tail(
    output,
    Math.max(0, maxPendingBytes - markerBytes),
  );
  const boundedOutput: PendingProcessEvent[] = [
    { type: "truncated", data: TERMINAL_LIVE_TRUNCATION_MARKER },
    ...(retainedOutput.length > 0
      ? ([{ type: "output", data: retainedOutput }] satisfies PendingProcessEvent[])
      : []),
  ];

  session.pendingProcessEvents = [...boundedOutput, ...exitEvents];
  session.pendingProcessEventIndex = 0;
  session.pendingProcessEventBytes = boundedOutput.reduce(
    (bytes, event) => bytes + (event.type === "exit" ? 0 : terminalUtf8ByteLength(event.data)),
    0,
  );
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
  maxPendingBytes: number,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  compactProcessedEvents(session);
  session.pendingProcessEvents.push(event);
  if (event.type !== "exit") {
    session.pendingProcessEventBytes += terminalUtf8ByteLength(event.data);
    boundPendingOutputEvents(session, maxPendingBytes);
  }
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

function defaultShellResolver(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? normalized;
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

function isRetryableShellSpawnError(error: PtyAdapter.PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

export interface PosixProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly command: string;
  readonly args: string;
}

export function parsePosixProcessSnapshot(stdout: string): ReadonlyArray<PosixProcessRow> {
  const rows: PosixProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid)) continue;
    rows.push({ pid, parentPid, command: match[3] ?? "", args: match[4] ?? "" });
  }
  return rows;
}

export function inspectPosixSubprocessFromRows(
  terminalPid: number,
  rows: ReadonlyArray<PosixProcessRow>,
): TerminalSubprocessInspectResult {
  const rowByPid = new Map(rows.map((row) => [row.pid, row] as const));
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.parentPid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.parentPid, children);
  }

  const firstChildPid = childrenByParent.get(terminalPid)?.[0];
  if (firstChildPid === undefined) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
  }

  const processIds = new Set<number>([terminalPid]);
  const pending = [terminalPid];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      if (processIds.has(childPid)) continue;
      processIds.add(childPid);
      pending.push(childPid);
    }
  }

  const firstChild = rowByPid.get(firstChildPid);
  const firstCommand = firstChild ? normalizeChildCommandName(firstChild.command) : null;
  const firstArgs = firstChild?.args ?? "";
  let agentCommand = agentCliCommandFromProcess(firstCommand, firstArgs);
  let agentArgs = firstArgs.length > 0 ? firstArgs : null;
  if (agentCommand === null) {
    for (const processId of processIds) {
      if (processId === terminalPid || processId === firstChildPid) continue;
      const row = rowByPid.get(processId);
      if (!row) continue;
      const detected = agentCliCommandFromProcess(normalizeChildCommandName(row.command), row.args);
      if (!detected) continue;
      agentCommand = detected;
      agentArgs = row.args.length > 0 ? row.args : null;
      break;
    }
  }

  return {
    hasRunningSubprocess: true,
    childCommand: agentCommand ?? (firstCommand ? truncateTerminalWireLabel(firstCommand) : null),
    processIds: [...processIds],
    processArgs: agentArgs,
  };
}

function truncateWindowsInspectResult(
  result: WindowsSubprocessInspectResult,
): TerminalSubprocessInspectResult {
  return {
    hasRunningSubprocess: result.hasRunningSubprocess,
    childCommand: result.childCommand ? truncateTerminalWireLabel(result.childCommand) : null,
    processIds: result.processIds,
    processArgs: result.processArgs,
  };
}

function captureWindowsProcessSnapshot(
  rootPids: readonly number[],
): Effect.Effect<
  ReadonlyArray<WindowsCimProcessRow>,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const roots = rootPids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (roots.length === 0) {
    return Effect.succeed([]);
  }
  return Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      // powershell.exe is a real executable — never spawn it through cmd.exe
      // shell mode, which would re-tokenize the `-Command` payload (pipes,
      // semicolons) before PowerShell ever sees it.
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", windowsProcessSnapshotCommand(roots)],
      timeout: "1500 millis",
      maxOutputBytes: 262_144,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    });
  }).pipe(
    // A timed-out or failed snapshot is UNKNOWN, not "no children". Mapping
    // it to zero rows demoted every live agent pane at once (losing their
    // resume-on-restore marks) whenever the box was slow enough for the
    // 1.5s PowerShell budget to lapse.
    Effect.mapError(
      (cause) =>
        new TerminalSubprocessCheckError({
          cause,
          terminalPid: roots[0] ?? 0,
          command: "powershell",
        }),
    ),
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.succeed(parseWindowsCimProcessOutput(result.stdout))
        : Effect.fail(
            new TerminalSubprocessCheckError({
              cause: `powershell process snapshot exited with code ${String(result.code)}`,
              terminalPid: roots[0] ?? 0,
              command: "powershell",
            }),
          ),
    ),
  );
}

function windowsInspectSubprocess(
  terminalPid: number,
  _platform: NodeJS.Platform,
): Effect.Effect<
  TerminalSubprocessInspectResult,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  return captureWindowsProcessSnapshot([terminalPid]).pipe(
    Effect.map((rows) =>
      truncateWindowsInspectResult(inspectWindowsSubprocessFromRows(terminalPid, rows)),
    ),
  );
}

const capturePosixProcessSnapshot = Effect.fnUntraced(function* (
  terminalPid: number,
): Effect.fn.Return<
  ReadonlyArray<PosixProcessRow>,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: "ps",
      args: ["-axo", "pid=,ppid=,comm=,args="],
      timeout: "1 second",
      maxOutputBytes: 1024 * 1024,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            terminalPid,
            command: "ps",
          }),
      ),
    );
  if (result.code !== 0 || result.timedOut) {
    return yield* new TerminalSubprocessCheckError({
      cause: `ps process snapshot exited with code ${String(result.code)}`,
      terminalPid,
      command: "ps",
    });
  }
  return parsePosixProcessSnapshot(result.stdout);
});

const posixInspectSubprocess = Effect.fnUntraced(function* (
  terminalPid: number,
  _platform: NodeJS.Platform,
) {
  const rows = yield* capturePosixProcessSnapshot(terminalPid);
  return inspectPosixSubprocessFromRows(terminalPid, rows);
});

function defaultSubprocessInspectorForPlatform(platform: NodeJS.Platform) {
  return Effect.fnUntraced(function* (terminalPid: number) {
    if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
      return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
    }
    if (platform === "win32") {
      return yield* windowsInspectSubprocess(terminalPid, platform);
    }
    return yield* posixInspectSubprocess(terminalPid, platform);
  });
}

function capHistory(history: string, maxLines: number, maxBytes: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  const lineTruncated = lines.length > maxLines;
  const lineCapped = lineTruncated ? lines.slice(lines.length - maxLines).join("\n") : history;
  const candidate = lineTruncated && hasTrailingNewline ? `${lineCapped}\n` : lineCapped;
  const byteTruncated = terminalUtf8ByteLength(candidate) > maxBytes;
  if (!lineTruncated && !byteTruncated) return candidate;

  const markerBytes = terminalUtf8ByteLength(TERMINAL_HISTORY_TRUNCATION_MARKER);
  const withoutExistingMarker = candidate.startsWith(TERMINAL_HISTORY_TRUNCATION_MARKER)
    ? candidate.slice(TERMINAL_HISTORY_TRUNCATION_MARKER.length)
    : candidate;
  const retained = trimTerminalTextToUtf8Tail(
    withoutExistingMarker,
    Math.max(0, maxBytes - markerBytes),
  );
  return `${TERMINAL_HISTORY_TRUNCATION_MARKER}${retained}`;
}

function capLoadedHistory(
  history: string,
  maxLines: number,
  maxBytes: number,
  sourcePrefixTruncated: boolean,
): string {
  const capped = capHistory(history, maxLines, maxBytes);
  if (!sourcePrefixTruncated || capped.startsWith(TERMINAL_HISTORY_TRUNCATION_MARKER)) {
    return capped;
  }
  const markerBytes = terminalUtf8ByteLength(TERMINAL_HISTORY_TRUNCATION_MARKER);
  return `${TERMINAL_HISTORY_TRUNCATION_MARKER}${trimTerminalTextToUtf8Tail(
    capped,
    Math.max(0, maxBytes - markerBytes),
  )}`;
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  return false;
}

function shouldStripOscSequence(content: string): boolean {
  // Queries with no emulator reply retry and flicker. Color *sets* must
  // reach xterm so the TUI can paint its palette.
  return /^(10|11|12);\?/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        if (nextCodePoint !== 0x5d || !shouldStripOscSequence(content)) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      if (codePoint !== 0x9d || !shouldStripOscSequence(content)) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("SOLLA_TERMINAL_")) {
    return true;
  }
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

// Marker variables the AppImage runtime injects into the process it launches.
// They describe the AppImage itself, not the user's session, so terminals must
// not inherit them.
const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// PATH-style variables the AppImage runtime prepends with its temporary mount
// (e.g. /tmp/.mount_T3-XXXX/usr/bin). Only the mount segments are dropped; the
// user's real entries are preserved.
const APPIMAGE_PATH_LIKE_ENV_KEYS = ["PATH", "LD_LIBRARY_PATH"] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// On Linux AppImage builds the runtime mounts the app under a temporary dir and
// injects APPIMAGE/APPDIR/ARGV0/OWD plus mount entries on PATH/LD_LIBRARY_PATH.
// The integrated terminal inherits the server process environment, so without
// this scrub those leak into the PTY and tools resolve against the AppImage
// mount instead of the user's real environment (e.g. `php` reporting
// PHP_BINARY as the AppImage path). See issue #1699. The scrub is gated on an
// actual AppImage launch so non-AppImage environments are left untouched.
function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter((segment) => segment.length > 0 && !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length > 0) {
        scrubbed[key] = kept.join(":");
      } else {
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      if (key.toUpperCase().startsWith("SOLLA_TERMINAL_")) continue;
      spawnEnv[key] = value;
    }
  }
  // Claude Code's default inline renderer appends a repaint frame to
  // scrollback on every resize, which stacks garbled frames in shared-PTY
  // panes. Its fullscreen (alt-screen) renderer repaints in place, so default
  // any claude launched from a t3 terminal into it; a user-provided value
  // (project runtime env or shell profile) wins.
  if (spawnEnv["CLAUDE_CODE_NO_FLICKER"] === undefined) {
    spawnEnv["CLAUDE_CODE_NO_FLICKER"] = "1";
  }
  // Integrated PTYs are not macOS Terminal windows. Apple's zsh session
  // restore would otherwise print "Restored session:" and steal input.
  if (spawnEnv["SHELL_SESSIONS_DISABLE"] === undefined) {
    spawnEnv["SHELL_SESSIONS_DISABLE"] = "1";
  }
  if (spawnEnv["COLORTERM"] === undefined) {
    spawnEnv["COLORTERM"] = "truecolor";
  }
  // node-pty only exports its `name` option as TERM on POSIX; a ConPTY
  // (Windows) shell inherits whatever the desktop app was launched with,
  // which for a GUI launch is nothing. TUIs probing an unset/limited TERM
  // pick degraded renderers (claude falls back to the frame-stacking inline
  // renderer), so advertise the surface we actually render with.
  if (spawnEnv["TERM"] === undefined) {
    spawnEnv["TERM"] = "xterm-256color";
  }
  if (spawnEnv["COLORFGBG"] === undefined) {
    // xterm.js does not answer OSC 11, so TUIs that auto-detect light/dark
    // fall back to a washed-out palette. 15;0 is white-on-black.
    spawnEnv["COLORFGBG"] = "15;0";
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env).filter(
    ([key]) => !key.toUpperCase().startsWith("SOLLA_TERMINAL_"),
  );
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  historyByteLimit?: number;
  pendingProcessEventByteLimit?: number;
  ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: TerminalSubprocessInspector;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  resolveAgentCliSessionId?: (input: {
    readonly command: string;
    readonly processIds: ReadonlyArray<number>;
    readonly processArgs: string | null;
    readonly preferredSessionId?: string | null;
  }) => Effect.Effect<string | null>;
  registerTerminalProcesses?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  unregisterTerminal?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  issueTerminalAgentMcpCredential?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<McpProviderSessionConfig | null>;
  revokeTerminalAgentMcpCredential?: (providerSessionId: string) => Effect.Effect<void>;
  touchTerminalAgentMcpCredential?: (providerSessionId: string) => Effect.Effect<void>;
}

export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir } = yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
    issueTerminalAgentMcpCredential: ({ threadId }) =>
      McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make(threadId),
        providerInstanceId: ProviderInstanceId.make(TERMINAL_AGENT_PROVIDER_INSTANCE_ID),
        capabilities: new Set(["artifacts", "collaboration", "history", "preview", "terminals"]),
      }).pipe(Effect.map((issued) => issued?.config ?? null)),
    revokeTerminalAgentMcpCredential: McpSessionRegistry.revokeActiveMcpProviderSession,
    touchTerminalAgentMcpCredential: McpSessionRegistry.touchActiveMcpProviderSession,
  });
});

export const makeWithOptions = Effect.fn("TerminalManager.makeWithOptions")(function* (
  options: TerminalManagerOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const logsDir = options.logsDir;
  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
  const historyByteLimit = Math.max(
    terminalUtf8ByteLength(TERMINAL_HISTORY_TRUNCATION_MARKER),
    options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT,
  );
  const pendingProcessEventByteLimit = Math.max(
    terminalUtf8ByteLength(TERMINAL_LIVE_TRUNCATION_MARKER),
    options.pendingProcessEventByteLimit ?? DEFAULT_PENDING_PROCESS_EVENT_BYTE_LIMIT,
  );
  const platform = yield* HostProcessPlatform;
  // Terminals must inherit the user's full environment (minus the blocklist
  // applied in createTerminalSpawnEnv) — an allowlist here silently strips
  // things like PSModulePath, DISPLAY, proxies, and toolchain variables.
  // `options.env` is the test seam.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const subprocessInspector =
    options.subprocessInspector ??
    ((terminalPid) =>
      defaultSubprocessInspectorForPlatform(platform)(terminalPid).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ));
  const subprocessPollIntervalMs =
    options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
  const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
  const maxRetainedInactiveSessions =
    options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
  const registerTerminalProcesses = options.registerTerminalProcesses ?? (() => Effect.void);
  const unregisterTerminal = options.unregisterTerminal ?? (() => Effect.void);
  const issueTerminalAgentMcpCredential =
    options.issueTerminalAgentMcpCredential ?? (() => Effect.succeed(null));
  const revokeTerminalAgentMcpCredential =
    options.revokeTerminalAgentMcpCredential ?? (() => Effect.void);
  const touchTerminalAgentMcpCredential =
    options.touchTerminalAgentMcpCredential ?? (() => Effect.void);
  const terminalAgentLauncherDirectory = path.join(logsDir, ".agent-launchers");
  const grokTerminalConfigPath = path.join(terminalAgentLauncherDirectory, "grok-config.toml");

  const listOpenFiles = Effect.fn("terminal.listOpenFiles")(function* (
    processIds: ReadonlyArray<number>,
  ): Effect.fn.Return<ReadonlyArray<string>> {
    const pids = processIds.filter((pid) => Number.isInteger(pid) && pid > 0);
    if (pids.length === 0 || platform === "win32") {
      return [];
    }
    const result = yield* processRunner
      .run({
        command: "lsof",
        args: ["-Fn", "-p", pids.join(",")],
        timeout: "1 second",
        maxOutputBytes: 262_144,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (result === null || result.code !== 0) {
      return [];
    }
    return parseLsofNameLines(result.stdout);
  });

  const defaultResolveAgentCliSessionId = Effect.fn("terminal.defaultResolveAgentCliSessionId")(
    function* (input: {
      readonly command: string;
      readonly processIds: ReadonlyArray<number>;
      readonly processArgs: string | null;
      readonly preferredSessionId?: string | null;
    }): Effect.fn.Return<string | null> {
      const fromArgs = sessionIdFromProcessArgs(input.command, input.processArgs);
      if (fromArgs) {
        return fromArgs;
      }
      const command = input.command.trim().toLowerCase();
      const homeDir = resolveHomeDir(baseEnv);
      if (command === "grok") {
        const grokHome =
          (baseEnv.GROK_HOME ?? "").trim() || (homeDir ? path.join(homeDir, ".grok") : "");
        if (grokHome.length > 0) {
          const raw = yield* fileSystem
            .readFileString(path.join(grokHome, "active_sessions.json"))
            .pipe(Effect.catch(() => Effect.succeed("")));
          const fromActive = sessionIdFromGrokActiveSessions(
            input.processIds,
            parseGrokActiveSessions(raw),
          );
          if (fromActive) {
            return fromActive;
          }
        }
      }
      if (command === "claude") {
        // Claude 2.1 no longer keeps the jsonl transcript as an open fd, so
        // lsof never sees a session id. It does write ~/.claude/sessions/<pid>.json
        // for each live process — the analog of Grok's active_sessions.json.
        const claudeHome =
          (baseEnv.CLAUDE_CONFIG_DIR ?? "").trim() ||
          (homeDir.length > 0 ? path.join(homeDir, ".claude") : "");
        if (claudeHome.length > 0) {
          const entries = yield* Effect.forEach(
            input.processIds.filter((pid) => Number.isInteger(pid) && pid > 0),
            (pid) =>
              fileSystem
                .readFileString(path.join(claudeHome, "sessions", claudeActiveSessionFileName(pid)))
                .pipe(
                  Effect.map(parseClaudeActiveSession),
                  Effect.catch(() => Effect.succeed(null)),
                ),
            { concurrency: "unbounded" },
          );
          const fromActive = sessionIdFromClaudeActiveSessions(
            input.processIds,
            entries.filter((entry): entry is ClaudeActiveSessionEntry => entry !== null),
          );
          if (fromActive) {
            return fromActive;
          }
        }
      }
      const openFiles = yield* listOpenFiles(input.processIds);
      if (command === "claude") {
        const transcripts = yield* Effect.forEach(
          openFiles.filter((filePath) => sessionIdFromClaudeTranscriptPath(filePath) !== null),
          (filePath) =>
            fileSystem.stat(filePath).pipe(
              Effect.map((info) => ({ path: filePath, bytes: Number(info.size) })),
              Effect.catch(() => Effect.succeed({ path: filePath, bytes: 0 })),
            ),
          { concurrency: "unbounded" },
        );
        return selectClaudeSessionId({
          ...(input.preferredSessionId !== undefined
            ? { preferredSessionId: input.preferredSessionId }
            : {}),
          transcripts,
        });
      }
      return sessionIdFromOpenFiles(command, openFiles, input.preferredSessionId);
    },
  );
  const resolveAgentCliSessionId =
    options.resolveAgentCliSessionId ?? defaultResolveAgentCliSessionId;

  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

  let terminalAgentLaunchersReady = false;
  if (options.issueTerminalAgentMcpCredential !== undefined) {
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(terminalAgentLauncherDirectory, { recursive: true });
      yield* fileSystem.writeFileString(grokTerminalConfigPath, GROK_TERMINAL_MCP_OVERLAY);
      if (platform === "win32") {
        yield* fileSystem.writeFileString(
          path.join(terminalAgentLauncherDirectory, "solla-agent-launch.ps1"),
          WINDOWS_TERMINAL_AGENT_LAUNCHER,
        );
        yield* Effect.forEach(
          TERMINAL_AGENT_PROVIDERS,
          (provider) =>
            fileSystem.writeFileString(
              path.join(terminalAgentLauncherDirectory, `${provider}.cmd`),
              windowsTerminalAgentCommandLauncher(provider),
            ),
          { discard: true },
        );
      } else {
        yield* Effect.forEach(
          TERMINAL_AGENT_PROVIDERS,
          (provider) => {
            const launcherPath = path.join(terminalAgentLauncherDirectory, provider);
            return fileSystem
              .writeFileString(launcherPath, POSIX_TERMINAL_AGENT_LAUNCHER)
              .pipe(Effect.andThen(fileSystem.chmod(launcherPath, 0o700)));
          },
          { discard: true },
        );
        yield* fileSystem.chmod(terminalAgentLauncherDirectory, 0o700);
      }
      terminalAgentLaunchersReady = true;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to prepare terminal agent launchers", { error }),
      ),
    );
  }

  const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
    sessions: new Map(),
    killFibers: new Map(),
  });
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  /**
   * Metadata subscribers, addressable outside the TerminalEvent bus. Resize
   * has no wire event (older clients would fail to decode a new union
   * member), so geometry changes push refreshed summaries here directly.
   */
  const terminalMetadataListeners = new Set<
    (event: TerminalMetadataStreamEvent) => Effect.Effect<void>
  >();
  const terminalLayoutListeners = new Set<
    (event: TerminalLayoutStreamEvent) => Effect.Effect<void>
  >();
  const threadLayouts = new Map<string, TerminalThreadLayout>();

  /**
   * Explicitly closed sessions must stay closed: a viewer that still has the
   * pane mounted (or reconnects later) attaches with a cwd, and the attach
   * path would otherwise silently respawn the session — resurrecting a
   * terminal one machine just closed and permanently diverging the pane
   * layout between machines. An explicit open/restart clears the tombstone.
   */
  const closedSessionTombstones = new Set<string>();
  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

  const publishEvent = (event: TerminalEvent) =>
    Effect.gen(function* () {
      for (const listener of terminalEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const historyPath = (threadId: string, terminalId: string) => {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(logsDir, `${threadPart}.log`);
    }
    return path.join(logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  };

  const resumePath = (threadId: string, terminalId: string) =>
    resumeStateFilePath(historyPath(threadId, terminalId));

  const launchPath = (threadId: string, terminalId: string) =>
    launchContextFilePath(historyPath(threadId, terminalId));

  const layoutPath = (threadId: string) =>
    threadLayoutFilePath(historyPath(threadId, DEFAULT_TERMINAL_ID));

  const persistThreadLayoutGroups = Effect.fn("terminal.persistThreadLayoutGroups")(function* (
    threadId: string,
    groups: TerminalThreadLayout["groups"],
    broadcast: boolean,
    forceRevision: boolean = false,
  ) {
    const current = threadLayouts.get(threadId);
    if (!forceRevision && current?.groups === groups) {
      return current;
    }
    const next: TerminalThreadLayout = {
      threadId,
      revision: (current?.revision ?? 0) + 1,
      groups,
      updatedAt: yield* nowIso,
    };
    threadLayouts.set(threadId, next);
    yield* fileSystem.writeFileString(layoutPath(threadId), encodeTerminalThreadLayout(next)).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to persist terminal thread layout", {
          threadId,
          error,
        }),
      ),
    );
    if (broadcast) {
      const event: TerminalLayoutStreamEvent = { type: "layout", layout: next };
      for (const listener of terminalLayoutListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    }
    return next;
  });

  const ensureTerminalInThreadLayout = Effect.fn("terminal.ensureTerminalInThreadLayout")(
    function* (threadId: string, terminalId: string) {
      const current = threadLayouts.get(threadId);
      const terminalIds = current ? terminalIdsInThreadLayout(current.groups) : [];
      if (!terminalIds.includes(terminalId)) {
        terminalIds.push(terminalId);
      }
      const groups = reconcileTerminalThreadLayoutGroups(current?.groups ?? [], terminalIds);
      yield* persistThreadLayoutGroups(threadId, groups, false);
    },
  );

  const removeTerminalFromThreadLayout = Effect.fn("terminal.removeTerminalFromThreadLayout")(
    function* (threadId: string, terminalId: string) {
      const current = threadLayouts.get(threadId);
      if (!current) {
        return;
      }
      const terminalIds = terminalIdsInThreadLayout(current.groups).filter(
        (candidate) => candidate !== terminalId,
      );
      const groups = reconcileTerminalThreadLayoutGroups(current.groups, terminalIds);
      yield* persistThreadLayoutGroups(threadId, groups, false);
    },
  );

  const legacyHistoryPath = (threadId: string) =>
    path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const getThreadSemaphore = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
      const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
        current.get(threadId),
      );
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(threadId, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });

  const withThreadLock = <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
    process: PtyAdapter.PtyProcess | null,
  ) {
    if (!process) return;
    const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
      Option.Option<Fiber.Fiber<void, never>>
    >((state) => {
      const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
        state.killFibers.get(process),
      );
      if (Option.isNone(existing)) {
        return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.delete(process);
      return [existing, { ...state, killFibers }] as const;
    });
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
    }
  });

  const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
    process: PtyAdapter.PtyProcess,
    fiber: Fiber.Fiber<void, never>,
  ) {
    yield* modifyManagerState((state) => {
      const killFibers = new Map(state.killFibers);
      killFibers.set(process, fiber);
      return [undefined, { ...state, killFibers }] as const;
    });
  });

  const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
  ) {
    const terminated = yield* Effect.try({
      try: () => process.kill("SIGTERM"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          cause,
          signal: "SIGTERM",
          terminalPid: process.pid,
        }),
    }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("failed to kill terminal process", {
          threadId,
          terminalId,
          signal: "SIGTERM",
          cause: error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!terminated) {
      return;
    }

    yield* Effect.sleep(processKillGraceMs);

    yield* Effect.try({
      try: () => process.kill("SIGKILL"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          cause,
          signal: "SIGKILL",
          terminalPid: process.pid,
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to force-kill terminal process", {
          threadId,
          terminalId,
          signal: "SIGKILL",
          cause: error,
        }),
      ),
    );
  });

  const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
  ) {
    const fiber = yield* runKillEscalation(process, threadId, terminalId).pipe(
      Effect.ensuring(
        modifyManagerState((state) => {
          if (!state.killFibers.has(process)) {
            return [undefined, state] as const;
          }
          const killFibers = new Map(state.killFibers);
          killFibers.delete(process);
          return [undefined, { ...state, killFibers }] as const;
        }),
      ),
      Effect.forkIn(workerScope),
    );

    yield* registerKillFiber(process, fiber);
  });

  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fnUntraced(function* (sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      const [threadId, terminalId] = sessionKey.split("\u0000");
      if (!threadId || !terminalId) {
        return;
      }

      yield* fileSystem.writeFileString(historyPath(threadId, terminalId), request.history).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to persist terminal history", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
    }),
  });

  const queuePersist = Effect.fnUntraced(function* (
    threadId: string,
    terminalId: string,
    history: string,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: false,
    });
  });

  const flushPersist = Effect.fn("terminal.flushPersist")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* persistWorker.drainKey(toSessionKey(threadId, terminalId));
  });

  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    threadId: string,
    terminalId: string,
    history: string,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: true,
    });
    yield* flushPersist(threadId, terminalId);
  });

  const persistAgentCliResumeState = Effect.fn("terminal.persistAgentCliResumeState")(function* (
    threadId: string,
    terminalId: string,
    state: AgentCliResumeState,
  ) {
    const updatedAt = yield* nowIso;
    yield* fileSystem
      .writeFileString(
        resumePath(threadId, terminalId),
        encodeAgentCliResumeState(state, updatedAt),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to persist terminal CLI resume state", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
  });

  /** A launch file marks a session that should survive a server restart;
      written on spawn, removed when the session ends on purpose. */
  const persistLaunchContext = Effect.fn("terminal.persistLaunchContext")(function* (
    session: TerminalSessionState,
  ) {
    const updatedAt = yield* nowIso;
    yield* fileSystem
      .writeFileString(
        launchPath(session.threadId, session.terminalId),
        encodeTerminalLaunchContext(
          {
            threadId: session.threadId,
            terminalId: session.terminalId,
            cwd: session.cwd,
            worktreePath: session.worktreePath,
            runtimeEnv: session.runtimeEnv,
            cols: session.cols,
            rows: session.rows,
          },
          updatedAt,
        ),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to persist terminal launch context", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            error,
          }),
        ),
      );
  });

  const deleteLaunchContext = Effect.fn("terminal.deleteLaunchContext")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* fileSystem
      .remove(launchPath(threadId, terminalId), { force: true })
      .pipe(Effect.catch(() => Effect.void));
  });

  const readAgentCliResumeState = Effect.fn("terminal.readAgentCliResumeState")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<AgentCliResumeState | null> {
    const raw = yield* fileSystem
      .readFileString(resumePath(threadId, terminalId))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (raw === null) {
      return null;
    }
    return parseAgentCliResumeState(raw);
  });

  const clearSessionHistory = Effect.fn("terminal.clearSessionHistory")(function* (
    session: TerminalSessionState,
  ) {
    session.history = "";
    session.pendingHistoryControlSequence = "";
    session.pendingProcessEvents = [];
    session.pendingProcessEventIndex = 0;
    session.pendingProcessEventBytes = 0;
    session.processEventDrainRunning = false;
    const eventStamp = advanceEventSequence(session);
    yield* persistHistory(session.threadId, session.terminalId, session.history);
    yield* publishEvent({
      type: "cleared",
      threadId: session.threadId,
      terminalId: session.terminalId,
      sequence: eventStamp.sequence,
    });
  });

  const abandonAgentCliResume = Effect.fn("terminal.abandonAgentCliResume")(function* (
    session: TerminalSessionState,
    state: AgentCliResumeState,
  ) {
    yield* persistAgentCliResumeState(session.threadId, session.terminalId, {
      command: state.command,
      sessionId: state.sessionId,
      resumeOnRestore: false,
    });
    if (session.history.length > 0) {
      yield* clearSessionHistory(session);
    }
  });

  const resolveClaudeSessionIdFromProject = Effect.fn("terminal.resolveClaudeSessionIdFromProject")(
    function* (cwd: string, preferredSessionId?: string | null): Effect.fn.Return<string | null> {
      const homeDir = resolveHomeDir(baseEnv);
      const claudeHome =
        (baseEnv.CLAUDE_CONFIG_DIR ?? "").trim() ||
        (homeDir.length > 0 ? path.join(homeDir, ".claude") : "");
      const projectName = claudeProjectDirectoryName(cwd);
      if (claudeHome.length === 0 || projectName.length === 0) {
        return preferredSessionId?.trim() ? preferredSessionId.trim() : null;
      }
      const projectDir = path.join(claudeHome, "projects", projectName);
      const names = yield* fileSystem
        .readDirectory(projectDir)
        .pipe(Effect.catch(() => Effect.succeed([])));
      const transcriptPaths = names
        .map((name) => path.join(projectDir, name))
        .filter((filePath) => sessionIdFromClaudeTranscriptPath(filePath) !== null);
      const transcripts = yield* Effect.forEach(
        transcriptPaths,
        (filePath) =>
          fileSystem.stat(filePath).pipe(
            Effect.map((info) => ({ path: filePath, bytes: Number(info.size) })),
            Effect.catch(() => Effect.succeed({ path: filePath, bytes: 0 })),
          ),
        { concurrency: "unbounded" },
      );
      return selectClaudeSessionId({
        ...(preferredSessionId !== undefined ? { preferredSessionId } : {}),
        transcripts,
      });
    },
  );

  const restoreAgentCliAfterStart = Effect.fn("terminal.restoreAgentCliAfterStart")(function* (
    session: TerminalSessionState,
  ) {
    const state = yield* readAgentCliResumeState(session.threadId, session.terminalId);
    if (!state?.resumeOnRestore) {
      return;
    }
    let sessionId = state.sessionId;
    if (
      state.command.trim().toLowerCase() === "claude" &&
      (sessionId === null || sessionId.length === 0)
    ) {
      sessionId = yield* resolveClaudeSessionIdFromProject(session.cwd, state.sessionId);
    }
    const input = agentCliResumeShellInput(state.command, sessionId);
    if (input === null) {
      yield* abandonAgentCliResume(session, state);
      return;
    }

    let elapsedMs = 0;
    let live = session;
    while (elapsedMs < AGENT_CLI_RESTORE_MAX_WAIT_MS) {
      yield* Effect.sleep(`${AGENT_CLI_RESTORE_POLL_MS} millis`);
      elapsedMs += AGENT_CLI_RESTORE_POLL_MS;
      const current = yield* getSession(session.threadId, session.terminalId);
      if (Option.isNone(current) || current.value.status !== "running" || !current.value.process) {
        yield* abandonAgentCliResume(session, state);
        return;
      }
      live = current.value;
      if (
        !shouldTypeAgentCliResume({
          targetCommand: state.command,
          runningCommand: live.childCommandLabel,
        })
      ) {
        yield* persistAgentCliResumeState(session.threadId, session.terminalId, {
          command: state.command,
          sessionId: state.sessionId,
          resumeOnRestore: false,
        });
        return;
      }
      if (elapsedMs < AGENT_CLI_RESTORE_MIN_DELAY_MS) {
        continue;
      }
      if (historyLooksLikeShellPrompt(live.history) || elapsedMs >= AGENT_CLI_RESTORE_MAX_WAIT_MS) {
        break;
      }
    }

    if (Option.isNone(yield* getSession(session.threadId, session.terminalId))) {
      yield* abandonAgentCliResume(session, state);
      return;
    }
    if (live.status !== "running" || !live.process) {
      yield* abandonAgentCliResume(live, state);
      return;
    }

    const process = live.process;
    const written = yield* Effect.try({
      try: () => {
        process.write(input);
        return true;
      },
      catch: (cause) =>
        new TerminalWriteError({
          threadId: session.threadId,
          terminalId: session.terminalId,
          terminalPid: process.pid,
          cause,
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to restore agent CLI in terminal", {
          threadId: session.threadId,
          terminalId: session.terminalId,
          command: state.command,
          error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!written) {
      yield* abandonAgentCliResume(live, state);
      return;
    }
    yield* persistAgentCliResumeState(session.threadId, session.terminalId, {
      command: state.command,
      sessionId: state.sessionId,
      resumeOnRestore: false,
    });
  });

  const readHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (filePath: string) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(filePath, { flag: "r" });
        const info = yield* file.stat;
        // Read a few extra bytes so a cut through a UTF-8 code point can be
        // skipped without reducing the usable history budget. The allocation
        // stays O(configured history size), even for legacy multi-gigabyte logs.
        const readBudget = BigInt(historyByteLimit + 4);
        const readSize = info.size > readBudget ? readBudget : info.size;
        const fileOffset = info.size - readSize;
        if (fileOffset > 0n) {
          yield* file.seek(fileOffset, "start");
        }

        const chunks: Uint8Array[] = [];
        let remaining = Number(readSize);
        let total = 0;
        while (remaining > 0) {
          const next = yield* file.readAlloc(remaining);
          if (Option.isNone(next)) break;
          chunks.push(next.value);
          total += next.value.byteLength;
          remaining -= next.value.byteLength;
        }
        const bytes = new Uint8Array(total);
        let targetOffset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, targetOffset);
          targetOffset += chunk.byteLength;
        }

        // A tail seek may land inside a multi-byte code point. Continuation
        // bytes cannot begin valid UTF-8, so skip only those leading fragments.
        let decodeOffset = 0;
        if (fileOffset > 0n) {
          while (decodeOffset < bytes.byteLength && (bytes[decodeOffset]! & 0xc0) === 0x80) {
            decodeOffset += 1;
          }
        }
        return {
          history: terminalTextDecoder.decode(bytes.subarray(decodeOffset)),
          sourcePrefixTruncated: fileOffset > 0n,
        } as const;
      }),
    );
  });

  const readHistory = Effect.fn("terminal.readHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    const nextPath = historyPath(threadId, terminalId);
    if (
      yield* fileSystem
        .exists(nextPath)
        .pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
          ),
        )
    ) {
      const loaded = yield* readHistoryTail(nextPath).pipe(
        Effect.mapError(
          (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
        ),
      );
      const capped = capLoadedHistory(
        loaded.history,
        historyLineLimit,
        historyByteLimit,
        loaded.sourcePrefixTruncated,
      );
      if (loaded.sourcePrefixTruncated || capped !== loaded.history) {
        yield* fileSystem
          .writeFileString(nextPath, capped)
          .pipe(
            Effect.mapError(
              (cause) =>
                new TerminalHistoryError({ operation: "truncate", threadId, terminalId, cause }),
            ),
          );
      }
      return capped;
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = legacyHistoryPath(threadId);
    if (
      !(yield* fileSystem
        .exists(legacyPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
          ),
        ))
    ) {
      return "";
    }

    const loaded = yield* readHistoryTail(legacyPath).pipe(
      Effect.mapError(
        (cause) => new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
      ),
    );
    const capped = capLoadedHistory(
      loaded.history,
      historyLineLimit,
      historyByteLimit,
      loaded.sourcePrefixTruncated,
    );
    yield* fileSystem
      .writeFileString(nextPath, capped)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
        ),
      );
    yield* fileSystem.remove(legacyPath, { force: true }).pipe(
      Effect.catch((cleanupError) =>
        Effect.logWarning("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError,
        }),
      ),
    );
    return capped;
  });

  const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* fileSystem.remove(historyPath(threadId, terminalId), { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete terminal history", {
          threadId,
          terminalId,
          error,
        }),
      ),
    );
    yield* fileSystem.remove(resumePath(threadId, terminalId), { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete terminal CLI resume state", {
          threadId,
          terminalId,
          error,
        }),
      ),
    );
    if (terminalId === DEFAULT_TERMINAL_ID) {
      yield* fileSystem.remove(legacyHistoryPath(threadId), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal history", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
    }
  });

  const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
    threadId: string,
  ) {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    const entries = yield* fileSystem
      .readDirectory(logsDir, { recursive: false })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    yield* Effect.forEach(
      entries.filter(
        (name) =>
          name === `${toSafeThreadId(threadId)}.log` ||
          name === `${toSafeThreadId(threadId)}.resume.json` ||
          name === `${legacySafeThreadId(threadId)}.log` ||
          name.startsWith(threadPrefix),
      ),
      (name) =>
        fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal histories for thread", {
              threadId,
              error,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") {
      return yield* new TerminalCwdNotDirectoryError({ cwd });
    }
  });

  const getSession = Effect.fn("terminal.getSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* Effect.map(readManagerState, (state) =>
      Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
    );
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
      Option.match(session, {
        onNone: () =>
          Effect.fail(
            new TerminalSessionLookupError({
              threadId,
              terminalId,
            }),
          ),
        onSome: Effect.succeed,
      }),
    );
  });

  const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
    return yield* readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].filter((session) => session.threadId === threadId),
      ),
    );
  });

  const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
    function* () {
      yield* modifyManagerState((state) => {
        const inactiveSessions = [...state.sessions.values()].filter(
          (session) => session.status !== "running",
        );
        if (inactiveSessions.length <= maxRetainedInactiveSessions) {
          return [undefined, state] as const;
        }

        inactiveSessions.sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.threadId.localeCompare(right.threadId) ||
            left.terminalId.localeCompare(right.terminalId),
        );

        const sessions = new Map(state.sessions);

        const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
        for (const session of inactiveSessions.slice(0, toEvict)) {
          const key = toSessionKey(session.threadId, session.terminalId);
          sessions.delete(key);
        }

        return [undefined, { ...state, sessions }] as const;
      });
    },
  );

  const drainProcessEvents = Effect.fnUntraced(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    while (true) {
      const eventNowMs = yield* nowMillis;
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        if (session.pid !== expectedPid || !session.process || session.status !== "running") {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.pendingProcessEventBytes = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.pendingProcessEventBytes = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        if (nextEvent.type === "output" || nextEvent.type === "truncated") {
          // Coalesce the buffered run of output into one event. A resume or
          // replay flood arrives as thousands of small PTY reads; publishing
          // each one separately makes every attached client pay a full
          // render + history-diff pass per chunk, which turns a large
          // transcript into minutes of visible fast-forwarding.
          let data = "";
          while (session.pendingProcessEventIndex < session.pendingProcessEvents.length) {
            const pending = session.pendingProcessEvents[session.pendingProcessEventIndex];
            if (!pending || (pending.type !== "output" && pending.type !== "truncated")) {
              break;
            }
            if (data.length > 0 && data.length + pending.data.length > MAX_COALESCED_OUTPUT_CHARS) {
              break;
            }
            data += pending.data;
            session.pendingProcessEventIndex += 1;
            session.pendingProcessEventBytes = Math.max(
              0,
              session.pendingProcessEventBytes - terminalUtf8ByteLength(pending.data),
            );
          }
          if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
            session.pendingProcessEvents = [];
            session.pendingProcessEventIndex = 0;
            session.pendingProcessEventBytes = 0;
          }
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            data,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            session.history = capHistory(
              `${session.history}${sanitized.visibleText}`,
              historyLineLimit,
              historyByteLimit,
            );
          }
          session.lastDataAtMs = eventNowMs;
          const workingChanged = sampleSessionWorking(session, eventNowMs);
          const eventStamp = advanceEventSequence(session);

          return {
            type: "output",
            threadId: session.threadId,
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            history: sanitized.visibleText.length > 0 ? session.history : null,
            data,
            workingChanged,
          } as const;
        }

        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.pendingProcessEventBytes = 0;
        }

        const process = session.process;
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.working = false;
        session.workingLastBusyAtMs = null;
        session.workingSince = null;
        session.childCommandLabel = null;
        const agentMcpProviderSessionId = session.agentMcpProviderSessionId;
        session.agentMcpProviderSessionId = null;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.pendingProcessEventBytes = 0;
        session.processEventDrainRunning = false;
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        const eventStamp = advanceEventSequence(session);

        return {
          type: "exit",
          process,
          threadId: session.threadId,
          terminalId: session.terminalId,
          sequence: eventStamp.sequence,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
          agentMcpProviderSessionId,
        } as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "output") {
        if (action.history !== null) {
          yield* queuePersist(action.threadId, action.terminalId, action.history);
        }

        yield* publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          sequence: action.sequence,
          data: action.data,
        });
        if (action.workingChanged) {
          const activity = yield* modifyManagerState((state) => {
            const live = state.sessions.get(toSessionKey(action.threadId, action.terminalId));
            if (!live) {
              return [null, state] as const;
            }
            const eventStamp = advanceEventSequence(live);
            return [
              {
                type: "activity" as const,
                threadId: live.threadId,
                terminalId: live.terminalId,
                sequence: eventStamp.sequence,
                hasRunningSubprocess: live.hasRunningSubprocess,
                label: terminalWireLabel(live),
              },
              state,
            ] as const;
          });
          if (activity) {
            yield* publishEvent(activity);
          }
        }
        continue;
      }

      yield* clearKillFiber(action.process);
      if (action.agentMcpProviderSessionId) {
        yield* revokeTerminalAgentMcpCredential(action.agentMcpProviderSessionId);
      }
      yield* unregisterTerminal({
        threadId: action.threadId,
        terminalId: action.terminalId,
      });
      // The shell ended on its own (user typed exit, process died) — that
      // session must not come back at the next server boot.
      yield* deleteLaunchContext(action.threadId, action.terminalId);
      yield* publishEvent({
        type: "exited",
        threadId: action.threadId,
        terminalId: action.terminalId,
        sequence: action.sequence,
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
      });
      yield* evictInactiveSessionsIfNeeded();
      return;
    }
  });

  const stopProcess = Effect.fn("terminal.stopProcess")(function* (session: TerminalSessionState) {
    const agentMcpProviderSessionId = session.agentMcpProviderSessionId;
    session.agentMcpProviderSessionId = null;
    if (agentMcpProviderSessionId) {
      yield* revokeTerminalAgentMcpCredential(agentMcpProviderSessionId);
    }
    const process = session.process;
    if (!process) return;

    const updatedAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      cleanupProcessHandles(session);
      session.process = null;
      session.pid = null;
      session.hasRunningSubprocess = false;
      session.working = false;
      session.workingLastBusyAtMs = null;
      session.workingSince = null;
      session.childCommandLabel = null;
      session.status = "exited";
      session.pendingHistoryControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.pendingProcessEventBytes = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = updatedAt;
      return [undefined, state] as const;
    });

    yield* clearKillFiber(process);
    yield* unregisterTerminal({
      threadId: session.threadId,
      terminalId: session.terminalId,
    });
    yield* startKillEscalation(process, session.threadId, session.terminalId);
    yield* evictInactiveSessionsIfNeeded();
  });

  const trySpawn = Effect.fn("terminal.trySpawn")(function* (
    shellCandidates: ReadonlyArray<ShellCandidate>,
    spawnEnv: NodeJS.ProcessEnv,
    session: TerminalSessionState,
    index = 0,
    lastError: PtyAdapter.PtySpawnError | null = null,
  ): Effect.fn.Return<
    { process: PtyAdapter.PtyProcess; shellLabel: string },
    PtyAdapter.PtySpawnError
  > {
    if (index >= shellCandidates.length) {
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "terminal-manager",
        attemptedShells: shellCandidates.map((candidate) => formatShellCandidate(candidate)),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-manager",
            attemptedShells: [],
          })
      );
    }

    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: candidate.shell,
        ...(candidate.args ? { args: candidate.args } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: spawnEnv,
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
  });

  const createAgentAwareSpawnEnv = Effect.fn("terminal.createAgentAwareSpawnEnv")(function* (
    session: TerminalSessionState,
  ) {
    const terminalEnv = createTerminalSpawnEnv(baseEnv, session.runtimeEnv);
    if (!terminalAgentLaunchersReady) {
      return terminalEnv;
    }

    const credential = yield* issueTerminalAgentMcpCredential({
      threadId: session.threadId,
      terminalId: session.terminalId,
    });
    if (!credential) {
      return terminalEnv;
    }
    const bearerToken = credential.authorizationHeader.startsWith("Bearer ")
      ? credential.authorizationHeader.slice("Bearer ".length).trim()
      : "";
    if (bearerToken.length === 0) {
      yield* revokeTerminalAgentMcpCredential(credential.providerSessionId);
      yield* Effect.logWarning(
        "terminal agent MCP credential had an invalid authorization header",
        {
          threadId: session.threadId,
          terminalId: session.terminalId,
        },
      );
      return terminalEnv;
    }

    session.agentMcpProviderSessionId = credential.providerSessionId;
    return injectTerminalAgentAwareness({
      environment: terminalEnv,
      platform,
      launcherDirectory: terminalAgentLauncherDirectory,
      grokConfigPath: grokTerminalConfigPath,
      endpoint: credential.endpoint,
      bearerToken,
      threadId: session.threadId,
      terminalId: session.terminalId,
    });
  });

  const startSession = Effect.fn("terminal.startSession")(function* (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
    restoreAgentCli = false,
  ) {
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      "terminal.thread_id": session.threadId,
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    const startingAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      session.status = "starting";
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.working = false;
      session.workingLastBusyAtMs = null;
      session.workingSince = null;
      session.childCommandLabel = null;
      session.agentCliSessionId = null;
      session.agentMcpProviderSessionId = null;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.pendingProcessEventBytes = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = startingAt;
      return [undefined, state] as const;
    });

    let ptyProcess: PtyAdapter.PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates = resolveShellCandidates(shellResolver, platform, baseEnv);
            const terminalEnv = yield* createAgentAwareSpawnEnv(session);
            const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;

            const processPid = ptyProcess.pid;
            const unsubscribeData = ptyProcess.onData((data) => {
              if (
                !enqueueProcessEvent(
                  session,
                  processPid,
                  { type: "output", data },
                  pendingProcessEventByteLimit,
                )
              ) {
                return;
              }
              runFork(drainProcessEvents(session, processPid));
            });
            const unsubscribeExit = ptyProcess.onExit((event) => {
              if (
                !enqueueProcessEvent(
                  session,
                  processPid,
                  { type: "exit", event },
                  pendingProcessEventByteLimit,
                )
              ) {
                return;
              }
              runFork(drainProcessEvents(session, processPid));
            });

            let eventStamp: ReturnType<typeof advanceEventSequence> = {
              updatedAt: session.updatedAt,
              sequence: session.eventSequence,
            };
            yield* modifyManagerState((state) => {
              session.process = ptyProcess;
              session.pid = processPid;
              session.status = "running";
              session.unsubscribeData = unsubscribeData;
              session.unsubscribeExit = unsubscribeExit;
              eventStamp = advanceEventSequence(session);
              return [undefined, state] as const;
            });

            yield* publishEvent({
              type: eventType,
              threadId: session.threadId,
              terminalId: session.terminalId,
              sequence: eventStamp.sequence,
              snapshot: snapshot(session),
            });
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      yield* persistLaunchContext(session);
      // Keep the durable pane document in lockstep with restartable sessions.
      // This write is intentionally silent: metadata already announces the
      // new session, while a client may still be preparing a split-specific
      // layout that should not be overwritten by a default-group broadcast.
      yield* ensureTerminalInThreadLayout(session.threadId, session.terminalId);
      if (restoreAgentCli) {
        runFork(restoreAgentCliAfterStart(session));
      }
      return;
    }

    {
      const error = startResult.failure;
      const agentMcpProviderSessionId = session.agentMcpProviderSessionId;
      session.agentMcpProviderSessionId = null;
      if (agentMcpProviderSessionId) {
        yield* revokeTerminalAgentMcpCredential(agentMcpProviderSessionId);
      }
      if (ptyProcess) {
        yield* startKillEscalation(ptyProcess, session.threadId, session.terminalId);
      }

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.status = "error";
        session.pid = null;
        session.process = null;
        session.hasRunningSubprocess = false;
        session.working = false;
        session.workingLastBusyAtMs = null;
        session.workingSince = null;
        session.childCommandLabel = null;
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.pendingProcessEventBytes = 0;
        session.processEventDrainRunning = false;
        advanceEventSequence(session);
        return [undefined, state] as const;
      });
      yield* unregisterTerminal({
        threadId: session.threadId,
        terminalId: session.terminalId,
      });

      yield* evictInactiveSessionsIfNeeded();

      const message = error.message;
      yield* publishEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        sequence: session.eventSequence,
        message,
      });
      yield* Effect.logError("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        cause: error,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  });

  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistoryOnClose: boolean,
  ) {
    const key = toSessionKey(threadId, terminalId);
    closedSessionTombstones.add(key);
    const session = yield* getSession(threadId, terminalId);
    const closedEventSequence = Option.isSome(session) ? session.value.eventSequence + 1 : 0;

    if (Option.isSome(session)) {
      yield* stopProcess(session.value);
      yield* unregisterTerminal({ threadId, terminalId });
      yield* persistHistory(threadId, terminalId, session.value.history);
    }

    yield* flushPersist(threadId, terminalId);

    const removed = yield* modifyManagerState((state) => {
      if (!state.sessions.has(key)) {
        return [false, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [true, { ...state, sessions }] as const;
    });

    if (removed) {
      yield* publishEvent({
        type: "closed",
        threadId,
        terminalId,
        sequence: closedEventSequence,
      });
    }

    // Explicitly closed sessions never come back at boot, whether or not the
    // caller also wanted the history gone.
    yield* deleteLaunchContext(threadId, terminalId);
    yield* removeTerminalFromThreadLayout(threadId, terminalId);
    if (deleteHistoryOnClose) {
      yield* deleteHistory(threadId, terminalId);
    }
  });

  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );

    if (runningSessions.length === 0) {
      return;
    }

    yield* Effect.forEach(
      runningSessions,
      (session) =>
        session.agentMcpProviderSessionId
          ? touchTerminalAgentMcpCredential(session.agentMcpProviderSessionId)
          : Effect.void,
      { discard: true },
    );

    const applySubprocessInspect = Effect.fn("terminal.applySubprocessInspect")(function* (
      session: TerminalSessionState & { pid: number },
      inspectResult: Option.Option<TerminalSubprocessInspectResult>,
    ) {
      if (Option.isNone(inspectResult)) {
        return;
      }

      const terminalPid = session.pid;
      const next = inspectResult.value;
      const previousAgentCommand = isAgentCliCommand(session.childCommandLabel)
        ? session.childCommandLabel
        : null;
      const previousWasRunningAgent = session.hasRunningSubprocess && previousAgentCommand !== null;
      yield* registerTerminalProcesses({
        threadId: session.threadId,
        terminalId: session.terminalId,
        processIds: next.processIds,
      });
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const inspectNowMs = yield* nowMillis;
      const event = yield* modifyManagerState((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel &&
            !sampleSessionWorking(liveSession.value, inspectNowMs))
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        sampleSessionWorking(liveSession.value, inspectNowMs);
        const eventStamp = advanceEventSequence(liveSession.value);

        return [
          Option.some({
            type: "activity" as const,
            threadId: liveSession.value.threadId,
            terminalId: liveSession.value.terminalId,
            sequence: eventStamp.sequence,
            hasRunningSubprocess: next.hasRunningSubprocess,
            label: terminalWireLabel(liveSession.value),
          }),
          state,
        ] as const;
      });

      if (Option.isSome(event)) {
        yield* publishEvent(event.value);
      }

      const nextIsAgent = next.hasRunningSubprocess && isAgentCliCommand(next.childCommand);
      const previousSessionId = session.agentCliSessionId;
      const sessionId = nextIsAgent
        ? ((yield* resolveAgentCliSessionId({
            command: next.childCommand,
            processIds: next.processIds,
            processArgs: next.processArgs ?? null,
            preferredSessionId: previousSessionId,
          })) ?? previousSessionId)
        : null;
      if (
        nextIsAgent &&
        (next.childCommand !== previousAgentCommand || sessionId !== previousSessionId)
      ) {
        session.agentCliSessionId = sessionId;
        yield* persistAgentCliResumeState(session.threadId, session.terminalId, {
          command: next.childCommand,
          sessionId,
          resumeOnRestore: shouldMarkAgentResumeOnRestore(next.childCommand, sessionId),
        });
      } else if (previousWasRunningAgent && !next.hasRunningSubprocess) {
        yield* persistAgentCliResumeState(session.threadId, session.terminalId, {
          command: previousAgentCommand,
          sessionId: previousSessionId,
          resumeOnRestore: false,
        });
      }
    });

    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      session: TerminalSessionState & { pid: number },
    ) {
      const inspectResult = yield* subprocessInspector(session.pid).pipe(
        Effect.map(Option.some),
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            terminalPid: session.pid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );
      yield* applySubprocessInspect(session, inspectResult);
    });

    if (platform === "win32" && options.subprocessInspector === undefined) {
      const snapshot = yield* captureWindowsProcessSnapshot(
        runningSessions.map((session) => session.pid),
      ).pipe(
        Effect.map(Option.some),
        Effect.catch((reason) =>
          Effect.logWarning("failed to snapshot Windows terminal processes", { reason }).pipe(
            Effect.as(Option.none<ReadonlyArray<WindowsCimProcessRow>>()),
          ),
        ),
      );
      if (Option.isNone(snapshot)) {
        return;
      }
      yield* Effect.forEach(
        runningSessions,
        (session) =>
          applySubprocessInspect(
            session,
            Option.some(
              truncateWindowsInspectResult(
                inspectWindowsSubprocessFromRows(session.pid, snapshot.value),
              ),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );
      return;
    }

    if (options.subprocessInspector === undefined) {
      const snapshot = yield* capturePosixProcessSnapshot(runningSessions[0]?.pid ?? 0).pipe(
        Effect.map(Option.some),
        Effect.catch((reason) =>
          Effect.logWarning("failed to snapshot terminal processes", { reason }).pipe(
            Effect.as(Option.none<ReadonlyArray<PosixProcessRow>>()),
          ),
        ),
      );
      if (Option.isNone(snapshot)) {
        return;
      }
      yield* Effect.forEach(
        runningSessions,
        (session) =>
          applySubprocessInspect(
            session,
            Option.some(inspectPosixSubprocessFromRows(session.pid, snapshot.value)),
          ),
        { concurrency: "unbounded", discard: true },
      );
      return;
    }

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some((session) => session.status === "running"),
    ),
  );

  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs)),
            )
          : Effect.sleep(subprocessPollIntervalMs),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      // Capture a CLI that started after the last periodic scan. Without this
      // final bounded pass, a fast app shutdown can preserve the shell launch
      // context but miss the provider session ID needed to resume its TUI.
      const finalPoll = yield* pollSubprocessActivity().pipe(
        Effect.timeoutOption(FINAL_SUBPROCESS_POLL_TIMEOUT_MS),
      );
      if (Option.isNone(finalPoll)) {
        yield* Effect.logWarning("timed out capturing terminal subprocesses during shutdown", {
          timeoutMs: FINAL_SUBPROCESS_POLL_TIMEOUT_MS,
        });
      }

      const sessions = yield* modifyManagerState(
        (state) =>
          [
            [...state.sessions.values()],
            {
              ...state,
              sessions: new Map(),
            },
          ] as const,
      );

      yield* Effect.forEach(
        sessions,
        (session) => {
          if (session.hasRunningSubprocess && isAgentCliCommand(session.childCommandLabel)) {
            return persistAgentCliResumeState(session.threadId, session.terminalId, {
              command: session.childCommandLabel,
              sessionId: session.agentCliSessionId,
              resumeOnRestore: shouldMarkAgentResumeOnRestore(
                session.childCommandLabel,
                session.agentCliSessionId,
              ),
            });
          }
          return Effect.void;
        },
        { discard: true },
      );

      const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
        session: TerminalSessionState,
      ) {
        const agentMcpProviderSessionId = session.agentMcpProviderSessionId;
        session.agentMcpProviderSessionId = null;
        if (agentMcpProviderSessionId) {
          yield* revokeTerminalAgentMcpCredential(agentMcpProviderSessionId);
        }
        cleanupProcessHandles(session);
        if (!session.process) return;
        yield* clearKillFiber(session.process);
        yield* runKillEscalation(session.process, session.threadId, session.terminalId);
      });

      yield* Effect.forEach(sessions, cleanupSession, {
        concurrency: "unbounded",
        discard: true,
      });
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const openLocked = Effect.fn("terminal.openLocked")(function* (input: TerminalOpenInput) {
    const terminalId = input.terminalId;
    yield* assertValidCwd(input.cwd);

    const sessionKey = toSessionKey(input.threadId, terminalId);
    const existing = yield* getSession(input.threadId, terminalId);
    if (Option.isNone(existing)) {
      yield* flushPersist(input.threadId, terminalId);
      const resumeState = yield* readAgentCliResumeState(input.threadId, terminalId);
      const restoreAgentCli = canResumeAgentCli(resumeState);
      let history = yield* readHistory(input.threadId, terminalId);
      // Old TUI frames look like a prompt (`>`), so keeping them makes
      // restore type `claude --resume` before the new shell is ready.
      if (restoreAgentCli || shouldClearHistoryOnFailedResume(resumeState)) {
        history = "";
        yield* persistHistory(input.threadId, terminalId, history);
        if (!restoreAgentCli && resumeState) {
          yield* persistAgentCliResumeState(input.threadId, terminalId, {
            command: resumeState.command,
            sessionId: resumeState.sessionId,
            resumeOnRestore: false,
          });
        }
      }
      const cols =
        input.cols !== undefined && input.cols >= MIN_PTY_RESIZE_COLS
          ? input.cols
          : DEFAULT_OPEN_COLS;
      const rows =
        input.rows !== undefined && input.rows >= MIN_PTY_RESIZE_ROWS
          ? input.rows
          : DEFAULT_OPEN_ROWS;
      const session: TerminalSessionState = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        history,
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        pendingProcessEventBytes: 0,
        processEventDrainRunning: false,
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        cols,
        rows,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        working: false,
        workingLastBusyAtMs: null,
        workingSince: null,
        lastDataAtMs: null,
        geometryOwnerClientId: input.clientId ?? null,
        geometryOwnerActiveAtMs: input.clientId !== undefined ? yield* nowMillis : null,
        childCommandLabel: null,
        agentCliSessionId: null,
        agentMcpProviderSessionId: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
      };

      const createdSession = session;
      yield* modifyManagerState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, createdSession);
        return [undefined, { ...state, sessions }] as const;
      });

      yield* evictInactiveSessionsIfNeeded();
      yield* startSession(
        session,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
        restoreAgentCli,
      );
      return snapshot(session);
    }

    const liveSession = existing.value;
    const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
    const currentRuntimeEnv = liveSession.runtimeEnv;
    const targetCols =
      input.cols !== undefined && input.cols >= MIN_PTY_RESIZE_COLS ? input.cols : liveSession.cols;
    const targetRows =
      input.rows !== undefined && input.rows >= MIN_PTY_RESIZE_ROWS ? input.rows : liveSession.rows;
    const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
    const nextWorktreePath =
      input.worktreePath !== undefined ? (input.worktreePath ?? null) : liveSession.worktreePath;
    const launchContextChanged =
      liveSession.cwd !== input.cwd ||
      runtimeEnvChanged ||
      liveSession.worktreePath !== nextWorktreePath;

    if (launchContextChanged) {
      yield* stopProcess(liveSession);
      liveSession.cwd = input.cwd;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.history = "";
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.pendingProcessEventBytes = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    } else if (liveSession.status === "exited" || liveSession.status === "error") {
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.history = "";
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.pendingProcessEventBytes = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    }

    if (!liveSession.process) {
      const resumeState = yield* readAgentCliResumeState(input.threadId, terminalId);
      const restoreAgentCli = canResumeAgentCli(resumeState);
      if (restoreAgentCli || shouldClearHistoryOnFailedResume(resumeState)) {
        liveSession.history = "";
        liveSession.pendingHistoryControlSequence = "";
        yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
      }
      // The respawner's grid is what the new process starts at; it owns it.
      claimGeometryOwner(liveSession, input.clientId, yield* nowMillis);
      yield* startSession(
        liveSession,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          worktreePath: liveSession.worktreePath,
          cols: targetCols,
          rows: targetRows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
        restoreAgentCli,
      );
      return snapshot(liveSession);
    }

    if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
      // Re-opening an existing session must not stomp the grid a machine the
      // user is actively on has established; same arbitration as resize().
      const openNowMs = yield* nowMillis;
      if (geometryOwnerAllowsResize(liveSession, input.clientId, openNowMs)) {
        claimGeometryOwner(liveSession, input.clientId, openNowMs);
        yield* resizePtyProcess(liveSession, liveSession.process, targetCols, targetRows);
        liveSession.cols = targetCols;
        liveSession.rows = targetRows;
        liveSession.updatedAt = yield* nowIso;
      }
    }

    return snapshot(liveSession);
  });

  const open: TerminalManager["Service"]["open"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.suspend(() => {
        // An explicit open is user intent to have the session; a prior
        // explicit close must not keep it dead.
        closedSessionTombstones.delete(toSessionKey(input.threadId, input.terminalId));
        return openLocked(input);
      }),
    );

  /**
   * Bring back every session that was still running when the server last
   * went down. Without this, panes stayed blank (and agent CLIs unresumed)
   * until a client happened to focus each one — and clients that never
   * focused a pane disagreed about which terminals existed at all.
   */
  const restorePersistedSessions = Effect.fn("terminal.restorePersistedSessions")(function* () {
    const names = yield* fileSystem
      .readDirectory(logsDir)
      .pipe(Effect.catch(() => Effect.succeed<string[]>([])));
    const launchFiles = names.filter(isLaunchContextFileName);
    yield* Effect.forEach(
      launchFiles,
      (name) =>
        Effect.gen(function* () {
          const filePath = path.join(logsDir, name);
          const raw = yield* fileSystem
            .readFileString(filePath)
            .pipe(Effect.catch(() => Effect.succeed("")));
          const context = raw.length > 0 ? parseTerminalLaunchContext(raw) : null;
          if (context === null) {
            yield* fileSystem
              .remove(filePath, { force: true })
              .pipe(Effect.catch(() => Effect.void));
            return;
          }
          const existing = yield* getSession(context.threadId, context.terminalId);
          if (Option.isSome(existing)) {
            return;
          }
          yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              const current = yield* getSession(context.threadId, context.terminalId);
              if (Option.isSome(current)) {
                return;
              }
              yield* openLocked({
                threadId: context.threadId,
                terminalId: context.terminalId,
                cwd: context.cwd,
                worktreePath: context.worktreePath,
                cols: context.cols,
                rows: context.rows,
                ...(context.runtimeEnv ? { env: context.runtimeEnv } : {}),
              });
            }),
          ).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("failed to restore persisted terminal session", {
                  threadId: context.threadId,
                  terminalId: context.terminalId,
                  cwd: context.cwd,
                  error,
                });
                // A vanished cwd will fail every boot; drop the marker so
                // the session stops resurrecting as an error.
                if (
                  typeof error === "object" &&
                  error !== null &&
                  "_tag" in error &&
                  (error as { _tag: string })._tag === "TerminalCwdNotFoundError"
                ) {
                  yield* fileSystem
                    .remove(filePath, { force: true })
                    .pipe(Effect.catch(() => Effect.void));
                }
              }),
            ),
          );
        }),
      { concurrency: 3, discard: true },
    );
  });

  const loadPersistedThreadLayouts = Effect.fn("terminal.loadPersistedThreadLayouts")(function* () {
    const names = yield* fileSystem
      .readDirectory(logsDir)
      .pipe(Effect.catch(() => Effect.succeed<string[]>([])));
    for (const name of names.filter(isThreadLayoutFileName)) {
      const raw = yield* fileSystem
        .readFileString(path.join(logsDir, name))
        .pipe(Effect.catch(() => Effect.succeed("")));
      const layout = raw.length > 0 ? parseTerminalThreadLayout(raw) : null;
      if (layout !== null) {
        threadLayouts.set(layout.threadId, layout);
      }
    }
  });

  const reconcilePersistedThreadLayouts = Effect.fn("terminal.reconcilePersistedThreadLayouts")(
    function* () {
      const state = yield* readManagerState;
      const terminalIdsByThread = new Map<string, string[]>();
      for (const session of state.sessions.values()) {
        const terminalIds = terminalIdsByThread.get(session.threadId) ?? [];
        terminalIds.push(session.terminalId);
        terminalIdsByThread.set(session.threadId, terminalIds);
      }

      const threadIds = new Set([...threadLayouts.keys(), ...terminalIdsByThread.keys()]);
      for (const threadId of threadIds) {
        const current = threadLayouts.get(threadId);
        const groups = reconcileTerminalThreadLayoutGroups(
          current?.groups ?? [],
          terminalIdsByThread.get(threadId) ?? [],
        );
        yield* persistThreadLayoutGroups(threadId, groups, false);
      }
    },
  );

  yield* loadPersistedThreadLayouts();
  // Restore runs in the background, but session listings must not observe the
  // half-restored world: clients reconcile their pane layout against the
  // metadata list and would read a not-yet-restored terminal as "closed on
  // another machine" and drop its pane.
  const persistedSessionsRestored = yield* Deferred.make<void>();
  yield* restorePersistedSessions().pipe(
    Effect.andThen(reconcilePersistedThreadLayouts()),
    Effect.ensuring(Deferred.succeed(persistedSessionsRestored, undefined)),
    Effect.forkIn(workerScope),
  );
  const awaitPersistedSessionsRestored = Deferred.await(persistedSessionsRestored).pipe(
    // A hung restore (stuck PTY spawn) must not starve clients of terminal
    // metadata forever; after the cap the listing is served as-is.
    Effect.timeoutOption("15 seconds"),
    Effect.asVoid,
  );

  const openOrAttachForStream = (input: TerminalAttachInput) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const existing = yield* getSession(input.threadId, terminalId);

        if (Option.isNone(existing)) {
          // Attaching is viewing, not creating: a pane that outlived an
          // explicit close on another machine must not resurrect the session.
          if (!input.cwd || closedSessionTombstones.has(toSessionKey(input.threadId, terminalId))) {
            return yield* new TerminalSessionLookupError({
              threadId: input.threadId,
              terminalId,
            });
          }

          return yield* openLocked({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
        }

        const session = existing.value;

        if (!session.process && input.cwd && input.restartIfNotRunning === true) {
          return yield* openLocked({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
        }

        // Attach streams output to another viewer. Do not let that viewer's
        // grid (a phone, a narrow pane) resize the shared PTY — desktop
        // geometry stays authoritative until something calls resize().
        return snapshot(session);
      }),
    );

  const readAllTerminalMetadata = () =>
    readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()]
          .map(summary)
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          ),
      ),
    );

  const readTerminalMetadata = (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) =>
    getSession(input.threadId, input.terminalId).pipe(
      Effect.map((session) => (Option.isSome(session) ? summary(session.value) : null)),
    );

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      return () => {
        terminalEventListeners.delete(listener);
      };
    });

  const attachStream: TerminalManager["Service"]["attachStream"] = (input, listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }

        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        return attachEvent ? listener(attachEvent) : Effect.void;
      });

      const initialSnapshot = yield* openOrAttachForStream(input);

      yield* listener({
        type: "snapshot",
        snapshot: initialSnapshot,
      });

      for (const event of bufferedEvents) {
        if (isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        if (attachEvent) {
          yield* listener(attachEvent);
        }
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const metadataEventFromTerminalEvent = (
    event: TerminalEvent,
  ): Effect.Effect<TerminalMetadataStreamEvent | null> => {
    if (!shouldPublishTerminalMetadataEvent(event)) {
      return Effect.succeed(null);
    }

    if (event.type === "closed") {
      return Effect.succeed({
        type: "remove" as const,
        threadId: event.threadId,
        terminalId: event.terminalId,
      });
    }

    return readTerminalMetadata({
      threadId: event.threadId,
      terminalId: event.terminalId,
    }).pipe(
      Effect.map((terminal) =>
        terminal
          ? {
              type: "upsert" as const,
              terminal,
            }
          : null,
      ),
    );
  };

  const offerMetadataEvent = (
    listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    event: TerminalEvent,
  ) =>
    metadataEventFromTerminalEvent(event).pipe(
      Effect.flatMap((metadataEvent) => (metadataEvent ? listener(metadataEvent) : Effect.void)),
    );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      const unsubscribeEvents = yield* subscribe((event) => {
        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        return offerMetadataEvent(listener, event);
      });
      // Direct-notify channel for changes without a wire event (resize).
      const directListener = (event: TerminalMetadataStreamEvent) =>
        deliverLive ? listener(event) : Effect.void;
      terminalMetadataListeners.add(directListener);
      unsubscribe = () => {
        unsubscribeEvents();
        terminalMetadataListeners.delete(directListener);
      };

      yield* awaitPersistedSessionsRestored;
      const terminals = yield* readAllTerminalMetadata();
      yield* listener({
        type: "snapshot",
        terminals,
      });

      for (const event of bufferedEvents) {
        yield* offerMetadataEvent(listener, event);
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const getLayout: TerminalManager["Service"]["getLayout"] = Effect.fn("terminal.getLayout")(
    (input) => Effect.succeed({ layout: threadLayouts.get(input.threadId) ?? null }),
  );

  const setLayout: TerminalManager["Service"]["setLayout"] = (input) =>
    // The boot repair owns persisted documents until all restartable
    // sessions have been restored. Wait before taking the per-thread lock,
    // since restore itself needs that lock to recreate each session.
    awaitPersistedSessionsRestored.pipe(
      Effect.andThen(
        withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            // A delayed focused client must not put an explicitly closed pane
            // back into the durable document. Explicit open clears the tombstone.
            const terminalIds = terminalIdsInThreadLayout(input.groups).filter(
              (terminalId) =>
                !closedSessionTombstones.has(toSessionKey(input.threadId, terminalId)),
            );
            const groups = reconcileTerminalThreadLayoutGroups(input.groups, terminalIds);
            return yield* persistThreadLayoutGroups(input.threadId, groups, true, true);
          }),
        ),
      ),
    );

  const subscribeLayouts: TerminalManager["Service"]["subscribeLayouts"] = (listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const buffered: TerminalLayoutStreamEvent[] = [];
      let deliverLive = false;
      const bufferingListener = (event: TerminalLayoutStreamEvent) => {
        if (!deliverLive) {
          buffered.push(event);
          return Effect.void;
        }
        return listener(event);
      };
      terminalLayoutListeners.add(bufferingListener);
      unsubscribe = () => {
        terminalLayoutListeners.delete(bufferingListener);
      };

      yield* listener({
        type: "snapshot",
        layouts: [...threadLayouts.values()],
      });
      for (const event of buffered) {
        yield* listener(event);
      }
      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const list: TerminalManager["Service"]["list"] = Effect.fn("terminal.list")(function* (input) {
    yield* awaitPersistedSessionsRestored;
    const terminals = yield* readAllTerminalMetadata();
    if (input.threadId === undefined) {
      return terminals;
    }
    return terminals.filter((terminal) => terminal.threadId === input.threadId);
  });

  const read: TerminalManager["Service"]["read"] = Effect.fn("terminal.read")(function* (input) {
    const session = yield* requireSession(input.threadId, input.terminalId);
    return snapshot(session);
  });

  const write: TerminalManager["Service"]["write"] = Effect.fn("terminal.write")(function* (input) {
    const terminalId = input.terminalId;
    const session = yield* requireSession(input.threadId, terminalId);
    const process = session.process;
    if (!process || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId,
      });
    }
    yield* Effect.try({
      try: () => process.write(input.data),
      catch: (cause) =>
        new TerminalWriteError({
          threadId: input.threadId,
          terminalId,
          terminalPid: process.pid,
          cause,
        }),
    });
    // Typing is the strongest signal of which machine the user is on: the
    // writer becomes the geometry owner so its next fit wins over passive
    // viewers. Broadcast only actual transfers, not every keystroke.
    const ownerChanged = claimGeometryOwner(session, input.clientId, yield* nowMillis);
    if (ownerChanged) {
      const upsert: TerminalMetadataStreamEvent = {
        type: "upsert",
        terminal: summary(session),
      };
      for (const listener of terminalMetadataListeners) {
        yield* listener(upsert).pipe(Effect.ignoreCause({ log: true }));
      }
    }
  });

  const resizeLocked = Effect.fn("terminal.resize")(function* (input: TerminalResizeInput) {
    const session = yield* getSession(input.threadId, input.terminalId);
    // ResizeObserver traffic can already be in flight when the UI closes the session.
    if (Option.isNone(session)) {
      return;
    }
    const process = session.value.process;
    if (!process || session.value.status !== "running") {
      return;
    }
    // A degenerate grid only ever comes from a mid-animation client layout
    // (a pane splitting, a drawer opening). Applying it is destructive on
    // Windows — ConPTY rewraps its whole buffer to the new width and
    // re-emits it into shared history — so keep the last sane size instead.
    if (input.cols < MIN_PTY_RESIZE_COLS || input.rows < MIN_PTY_RESIZE_ROWS) {
      return;
    }
    // Only the geometry owner may resize; see TERMINAL_GEOMETRY_OWNER_STALE_MS.
    const resizeNowMs = yield* nowMillis;
    if (!geometryOwnerAllowsResize(session.value, input.clientId, resizeNowMs)) {
      return;
    }
    claimGeometryOwner(session.value, input.clientId, resizeNowMs);
    const geometryChanged = session.value.cols !== input.cols || session.value.rows !== input.rows;
    // Same-size re-asserts must not reach the PTY: POSIX would swallow them,
    // but ConPTY re-renders on every resize call regardless of the size.
    if (!geometryChanged) {
      return;
    }
    yield* resizePtyProcess(session.value, process, input.cols, input.rows);
    session.value.cols = input.cols;
    session.value.rows = input.rows;
    session.value.updatedAt = yield* nowIso;
    if (geometryChanged) {
      // Passive viewers must adopt the new grid or absolute cursor
      // addressing from full-screen programs lands on the wrong rows.
      const upsert: TerminalMetadataStreamEvent = {
        type: "upsert",
        terminal: summary(session.value),
      };
      for (const listener of terminalMetadataListeners) {
        yield* listener(upsert).pipe(Effect.ignoreCause({ log: true }));
      }
    }
  });

  const resize: TerminalManager["Service"]["resize"] = (input) =>
    withThreadLock(input.threadId, resizeLocked(input));

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const session = yield* requireSession(input.threadId, terminalId);
        yield* clearSessionHistory(session);
      }),
    );

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        yield* increment(terminalRestartsTotal, { scope: "thread" });
        const terminalId = input.terminalId;
        yield* assertValidCwd(input.cwd);

        const sessionKey = toSessionKey(input.threadId, terminalId);
        closedSessionTombstones.delete(sessionKey);
        const existingSession = yield* getSession(input.threadId, terminalId);
        let session: TerminalSessionState;
        if (Option.isNone(existingSession)) {
          const cols = input.cols ?? DEFAULT_OPEN_COLS;
          const rows = input.rows ?? DEFAULT_OPEN_ROWS;
          session = {
            threadId: input.threadId,
            terminalId,
            cwd: input.cwd,
            worktreePath: input.worktreePath ?? null,
            status: "starting",
            pid: null,
            history: "",
            pendingHistoryControlSequence: "",
            pendingProcessEvents: [],
            pendingProcessEventIndex: 0,
            pendingProcessEventBytes: 0,
            processEventDrainRunning: false,
            exitCode: null,
            exitSignal: null,
            updatedAt: yield* nowIso,
            eventSequence: 0,
            cols,
            rows,
            process: null,
            unsubscribeData: null,
            unsubscribeExit: null,
            hasRunningSubprocess: false,
            working: false,
            workingLastBusyAtMs: null,
            workingSince: null,
            lastDataAtMs: null,
            geometryOwnerClientId: null,
            geometryOwnerActiveAtMs: null,
            childCommandLabel: null,
            agentCliSessionId: null,
            agentMcpProviderSessionId: null,
            runtimeEnv: normalizedRuntimeEnv(input.env),
          };
          const createdSession = session;
          yield* modifyManagerState((state) => {
            const sessions = new Map(state.sessions);
            sessions.set(sessionKey, createdSession);
            return [undefined, { ...state, sessions }] as const;
          });
          yield* evictInactiveSessionsIfNeeded();
        } else {
          session = existingSession.value;
          yield* stopProcess(session);
          session.cwd = input.cwd;
          session.worktreePath = input.worktreePath ?? null;
          session.runtimeEnv = normalizedRuntimeEnv(input.env);
        }

        const cols = input.cols ?? session.cols;
        const rows = input.rows ?? session.rows;

        session.history = "";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.pendingProcessEventBytes = 0;
        session.processEventDrainRunning = false;
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* startSession(
          session,
          {
            threadId: input.threadId,
            terminalId,
            cwd: input.cwd,
            ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
            cols,
            rows,
            ...(input.env ? { env: input.env } : {}),
          },
          "restarted",
        );
        return snapshot(session);
      }),
    );

  const close: TerminalManager["Service"]["close"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.terminalId) {
          yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
          return;
        }

        const threadSessions = yield* sessionsForThread(input.threadId);
        yield* Effect.forEach(
          threadSessions,
          (session) => closeSession(input.threadId, session.terminalId, false),
          { discard: true },
        );

        if (input.deleteHistory) {
          yield* deleteAllHistoryForThread(input.threadId);
        }
      }),
    );

  return TerminalManager.of({
    open,
    attachStream,
    list,
    read,
    write,
    resize,
    clear,
    restart,
    close,
    subscribe,
    subscribeMetadata,
    getLayout,
    setLayout,
    subscribeLayouts,
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));

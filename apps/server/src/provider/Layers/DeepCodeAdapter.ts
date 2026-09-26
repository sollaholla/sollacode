import {
  EventId,
  RuntimeItemId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventBase,
  type ProviderSession,
  type ThreadId,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { collaborationModePrompt } from "../collaborationMode.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  DEEPCODE_PROGRESS_TIMEOUT_MESSAGE,
  buildDeepCodeExecArgs,
  buildDeepCodeTurnEnvironment,
  deepCodeHomeDir,
  deepCodeSessionMessagesPath,
  deepCodeSessionsIndexPath,
  isDeepCodeEffort,
  newDeepCodeSessionMessages,
  parseDeepCodeSessionMessages,
  parseDeepCodeSessionsIndex,
  pickDeepCodeSessionId,
  sessionIdFromCursor,
  type DeepCodeSessionIndexEntry,
  type DeepCodeSessionMessage,
} from "../deepcodeProtocol.ts";
import {
  deepCodeContinuationPrompt,
  inspectDeepCodeContext,
  isDeepCodeContextOverflow,
} from "../deepcodeContext.ts";
import { DEEPCODE_DRIVER_KIND } from "../deepcodeRuntime.ts";

interface ActiveTurn {
  readonly id: TurnId;
  fiber?: Fiber.Fiber<void>;
  interrupted: boolean;
}

const isAdapterRequestError = Schema.is(ProviderAdapterRequestError);

interface SessionContext {
  session: ProviderSession;
  active?: ActiveTurn | undefined;
  effort?: string | undefined;
}

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const TOOL_DETAIL_MAX_CHARS = 400;
const TOOL_RESULT_MAX_CHARS = 2_000;
/**
 * A thought is prose, not a tool label, so it gets a far larger budget.
 *
 * Kept at the ingestion layer's reasoning bound: a tighter value here would
 * silently become the real cap and re-introduce the mid-sentence "..." that
 * raising the ingestion limit was meant to remove.
 */
const REASONING_MAX_CHARS = 16_000;
/**
 * How often the running turn re-reads the session JSONL. The file is appended
 * per message, not per token, so a step lands whole; this only has to be short
 * enough that the work log feels live.
 */
const ACTIVITY_POLL_INTERVAL = "400 millis";
/**
 * How long the session JSONL may sit unchanged before the turn is declared
 * stalled. `--exec` prints nothing but the final reply, so the file the CLI
 * appends every message to is the only liveness signal; five quiet minutes
 * means the request is wedged, not thinking.
 */
const PROGRESS_STALL_LIMIT_MS = 5 * 60 * 1000;
/** How often the follower stats the session file for the stall check. */
const PROGRESS_STALL_POLL_MS = 30 * 1000;

function boundDeepCodeText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Map a Deep Code tool name to the canonical lifecycle type the timeline uses.
 *
 * Deep Code names tools the way Claude Code does (`bash`, `read`, `edit`,
 * `mcp__…`), so the same coarse classification applies. Read and search calls
 * have no dedicated lifecycle type, so they stay `dynamic_tool_call` rather
 * than pretending a file changed or a command ran.
 */
function classifyDeepCodeToolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("agent") || normalized.includes("subagent"))
    return "collab_agent_tool_call";
  if (
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("terminal") ||
    normalized.includes("command") ||
    normalized.includes("exec")
  )
    return "command_execution";
  if (
    normalized.includes("websearch") ||
    normalized.includes("web_search") ||
    normalized.includes("web search")
  )
    return "web_search";
  if (normalized.includes("image")) return "image_view";
  if (
    normalized.includes("read") ||
    normalized.includes("cat") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("find") ||
    normalized.includes("search") ||
    normalized.includes("list")
  )
    return "dynamic_tool_call";
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete") ||
    normalized.includes("move")
  )
    return "file_change";
  return "dynamic_tool_call";
}

function deepCodeToolTitle(itemType: ToolLifecycleItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    default:
      return "Tool call";
  }
}

function parseDeepCodeToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function deepCodeToolRequestDetail(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue.trim() : "";
  if (command.length > 0)
    return `${toolName}: ${boundDeepCodeText(command, TOOL_DETAIL_MAX_CHARS)}`;
  const pathValue = input.path ?? input.file_path ?? input.filePath ?? input.relativePath;
  const path = typeof pathValue === "string" ? pathValue.trim() : "";
  if (path.length > 0) return `${toolName}: ${boundDeepCodeText(path, TOOL_DETAIL_MAX_CHARS)}`;
  const descriptionValue = input.description ?? input.prompt;
  const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";
  if (description.length > 0)
    return `${toolName}: ${boundDeepCodeText(description, TOOL_DETAIL_MAX_CHARS)}`;
  const serialized = JSON.stringify(input);
  return serialized === "{}"
    ? toolName
    : `${toolName}: ${boundDeepCodeText(serialized, TOOL_DETAIL_MAX_CHARS)}`;
}

/**
 * Keep tool input small enough to travel in a thread activity.
 *
 * A Deep Code `edit` argument can hold a whole file, and activity payloads are
 * persisted and sent to every client. Preserve short primitives so the display
 * can still name a command or path, and drop the rest.
 */
function boundDeepCodeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(input).length <= TOOL_RESULT_MAX_CHARS) return input;
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") bounded[key] = boundDeepCodeText(value, TOOL_DETAIL_MAX_CHARS);
    else if (typeof value === "number" || typeof value === "boolean") bounded[key] = value;
  }
  return bounded;
}

/** Each turn owns a scoped `--exec` process; later turns resume the native session. */
export const makeDeepCodeAdapter = Effect.fn("makeDeepCodeAdapter")(function* (config: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly resolveEnvironment?: Effect.Effect<NodeJS.ProcessEnv, Error>;
  /** Where the server persisted this turn's image attachments. */
  readonly attachmentsDir?: string;
  /** Test-only override for the progress watchdog silence budget. */
  readonly progressStallLimitMs?: number;
  /** Test-only override for the watchdog's session-file stat cadence. */
  readonly progressStallPollMs?: number;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const events = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const sessions = new Map<ThreadId, SessionContext>();
  const stallLimitMs = config.progressStallLimitMs ?? PROGRESS_STALL_LIMIT_MS;
  const stallPollMs = config.progressStallPollMs ?? PROGRESS_STALL_POLL_MS;
  let sequence = 0;
  const now = () => DateTime.formatIso(DateTime.nowUnsafe());
  const base = (threadId: ThreadId, turnId?: TurnId): ProviderRuntimeEventBase => ({
    eventId: EventId.make(`deepcode:${config.instanceId}:${now()}:${++sequence}`),
    provider: DEEPCODE_DRIVER_KIND,
    providerInstanceId: config.instanceId,
    threadId,
    createdAt: now(),
    ...(turnId ? { turnId } : {}),
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publishUnsafe(events, event);
  const error = (method: string, detail: string) =>
    new ProviderAdapterRequestError({
      provider: DEEPCODE_DRIVER_KIND,
      method,
      detail,
    });
  const unsupported = (method: string) =>
    Effect.fail(error(method, `Deep Code headless mode does not support ${method}.`));

  const readSessionIndex = (cwd: string) =>
    fs.readFileString(deepCodeSessionsIndexPath(deepCodeHomeDir(config.environment), cwd)).pipe(
      Effect.map(parseDeepCodeSessionsIndex),
      Effect.orElseSucceed((): ReadonlyArray<DeepCodeSessionIndexEntry> => []),
    );

  const readSessionMessages = (sessionId: string, cwd: string) =>
    fs
      .readFileString(
        deepCodeSessionMessagesPath(deepCodeHomeDir(config.environment), cwd, sessionId),
      )
      .pipe(
        Effect.map(parseDeepCodeSessionMessages),
        Effect.orElseSucceed((): ReadonlyArray<DeepCodeSessionMessage> => []),
      );

  /**
   * The stall probe: the session JSONL is append-only, so a changed size is
   * progress and a missing file is silence, never an error.
   */
  const sessionFileSize = (sessionId: string, cwd: string) =>
    fs.stat(deepCodeSessionMessagesPath(deepCodeHomeDir(config.environment), cwd, sessionId)).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed((): number | null => null),
    );

  /**
   * Incremental publisher for one turn's reasoning and tool activity.
   *
   * `deepcode --exec` prints nothing but the final reply, so a turn used to run
   * silent for minutes. The CLI does append every message to the session JSONL
   * as it happens, so following that file is what turns the turn into a live
   * work log.
   *
   * `drain` is safe to call repeatedly, and from both the follower and the
   * final post-exit flush: it remembers what it has already published, so
   * nothing is emitted twice. `previousLastMessageId` fences a resumed session
   * to the messages this turn appended, since its JSONL already holds every
   * earlier turn.
   */
  const makeSessionActivityPublisher = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly cwd: string;
    readonly previousLastMessageId: string | null;
  }) => {
    const pending = new Map<
      string,
      {
        readonly itemType: ToolLifecycleItemType;
        readonly title: string;
        readonly detail: string;
      }
    >();
    const startedCalls = new Set<string>();
    const completedCalls = new Set<string>();
    const publishedReasoning = new Set<string>();

    const drain = (sessionId: string) =>
      Effect.gen(function* () {
        const messages = newDeepCodeSessionMessages(
          yield* readSessionMessages(sessionId, input.cwd),
          input.previousLastMessageId,
        );
        for (const message of messages) {
          if (message.role === "assistant") {
            // One row per thinking step, keyed by the message id. Ingestion
            // gives each distinct item id its own reasoning row, so the log
            // reads as a sequence of thoughts rather than one line that keeps
            // overwriting itself. Left untitled on purpose: a provider title
            // marks reasoning as a bridge narrating its own state, and the
            // client keeps those inline in the work group. An untitled row is
            // the model thinking, drawn as a thought between the tool calls it
            // narrates.
            const reasoning = message.reasoning?.trim() ?? "";
            if (
              reasoning.length > 0 &&
              message.id.length > 0 &&
              !publishedReasoning.has(message.id)
            ) {
              publishedReasoning.add(message.id);
              emit({
                ...base(input.threadId, input.turnId),
                itemId: RuntimeItemId.make(message.id),
                type: "item.updated",
                payload: {
                  itemType: "reasoning",
                  detail: boundDeepCodeText(reasoning, REASONING_MAX_CHARS),
                },
              });
            }
            for (const call of message.toolCalls) {
              if (startedCalls.has(call.id)) continue;
              startedCalls.add(call.id);
              const toolInput = parseDeepCodeToolArguments(call.arguments);
              const itemType = classifyDeepCodeToolItemType(call.name);
              const title = deepCodeToolTitle(itemType);
              const detail = deepCodeToolRequestDetail(call.name, toolInput);
              pending.set(call.id, { itemType, title, detail });
              emit({
                ...base(input.threadId, input.turnId),
                itemId: RuntimeItemId.make(call.id),
                type: "item.started",
                payload: {
                  itemType,
                  status: "inProgress",
                  title,
                  detail,
                  data: { toolName: call.name, input: boundDeepCodeToolInput(toolInput) },
                },
              });
            }
            continue;
          }
          if (message.role !== "tool" || message.toolCallId === null) continue;
          if (completedCalls.has(message.toolCallId)) continue;
          completedCalls.add(message.toolCallId);
          const call = pending.get(message.toolCallId);
          const itemType =
            call?.itemType ?? classifyDeepCodeToolItemType(message.toolName ?? "tool");
          emit({
            ...base(input.threadId, input.turnId),
            itemId: RuntimeItemId.make(message.toolCallId),
            type: "item.completed",
            payload: {
              itemType,
              status: "completed",
              title: call?.title ?? deepCodeToolTitle(itemType),
              ...(call ? { detail: call.detail } : {}),
              data: {
                ...(message.toolName ? { toolName: message.toolName } : {}),
                ...(message.paramsMd
                  ? { params: boundDeepCodeText(message.paramsMd, TOOL_RESULT_MAX_CHARS) }
                  : {}),
                ...(message.resultMd
                  ? { result: boundDeepCodeText(message.resultMd, TOOL_RESULT_MAX_CHARS) }
                  : {}),
              },
            },
          });
          pending.delete(message.toolCallId);
        }
      });

    /**
     * A call with no persisted result still completes, so the timeline never
     * leaves a tool entry spinning after the turn is over.
     */
    const settle = () =>
      Effect.sync(() => {
        for (const [itemId, call] of pending) {
          emit({
            ...base(input.threadId, input.turnId),
            itemId: RuntimeItemId.make(itemId),
            type: "item.completed",
            payload: {
              itemType: call.itemType,
              status: "completed",
              title: call.title,
              detail: call.detail,
            },
          });
        }
        pending.clear();
      });

    return { drain, settle } as const;
  };

  /**
   * Follow the session JSONL while the CLI is still running.
   *
   * A brand-new session has no id until the CLI writes its index entry, so the
   * loop re-reads the index until that entry appears and only then starts
   * draining. It runs until the turn interrupts it; the caller drains once more
   * afterwards to catch whatever landed between the last poll and process exit.
   *
   * The same loop is the progress watchdog: when the session file sits
   * unchanged past the stall limit it kills the wedged CLI and reports the
   * stall, so the turn fails over instead of spinning forever.
   */
  const followSessionActivity = (input: {
    readonly publisher: ReturnType<typeof makeSessionActivityPublisher>;
    readonly previousIndex: ReadonlyArray<DeepCodeSessionIndexEntry>;
    readonly resumeSessionId: string | undefined;
    readonly cwd: string;
    /** Fired when the stall limit trips; the waiter races on the report. */
    readonly onStalled: () => void;
    readonly startedAtMs: number;
  }) =>
    Effect.gen(function* () {
      let sessionId = input.resumeSessionId;
      let lastStatAtMs = 0;
      let lastSize = -1;
      let lastProgressAtMs = input.startedAtMs;
      while (true) {
        yield* Effect.sleep(ACTIVITY_POLL_INTERVAL);
        if (sessionId === undefined) {
          sessionId = pickDeepCodeSessionId({
            previous: input.previousIndex,
            next: yield* readSessionIndex(input.cwd),
            ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
          });
        }
        if (sessionId !== undefined) yield* input.publisher.drain(sessionId);
        const nowMs = yield* Clock.currentTimeMillis;
        if (nowMs - lastStatAtMs < stallPollMs) continue;
        lastStatAtMs = nowMs;
        if (sessionId !== undefined) {
          const size = yield* sessionFileSize(sessionId, input.cwd);
          if (size !== null && size !== lastSize) {
            lastSize = size;
            lastProgressAtMs = nowMs;
          }
        }
        // A CLI that never writes its index entry stalls against the spawn
        // clock: no session file is also no progress.
        if (nowMs - lastProgressAtMs < stallLimitMs) continue;
        // Report, don't kill: the waiter fails the turn with the stall marker
        // and scope teardown reaps the wedged CLI (the spawn-time
        // `forceKillAfter` escalates past a SIGTERM trap). Killing here would
        // race the exit-code waiter and let the kill's own noise win over the
        // marker.
        input.onStalled();
        return;
      }
    });

  const startSession: ProviderAdapterShape<ProviderAdapterRequestError>["startSession"] = Effect.fn(
    "DeepCodeAdapter.startSession",
  )(function* (input) {
    const existing = sessions.get(input.threadId);
    if (existing) return existing.session;
    if (input.resumeCursor != null && !sessionIdFromCursor(input.resumeCursor)) {
      return yield* error("startSession", "The Deep Code session cursor is invalid.");
    }
    const timestamp = now();
    const session: ProviderSession = {
      provider: DEEPCODE_DRIVER_KIND,
      providerInstanceId: config.instanceId,
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
      status: "ready",
      cwd: input.cwd ?? config.cwd,
      ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
      ...(input.resumeCursor ? { resumeCursor: input.resumeCursor } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    sessions.set(input.threadId, {
      session,
      effort: getModelSelectionStringOptionValue(input.modelSelection, "effort"),
    });
    return session;
  });

  const sendTurn: ProviderAdapterShape<ProviderAdapterRequestError>["sendTurn"] = Effect.fn(
    "DeepCodeAdapter.sendTurn",
  )(function* (input, options) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const context = sessions.get(input.threadId);
        if (!context) return yield* error("sendTurn", "Session not found.");
        if (context.active || input.liveSteerTarget)
          return yield* error(
            "sendTurn",
            "Deep Code cannot steer an active turn. Wait for it to finish or stop it.",
          );
        if (!input.input?.trim()) return yield* error("sendTurn", "A text prompt is required.");
        // `--exec` takes one text prompt, so an image can never go inline.
        // Rejecting the turn instead threw the person's screenshot away. The
        // server already persisted each attachment under the state directory
        // before this send, so hand the agent the on-disk path and let it read
        // the file with its own tools.
        const attachmentPaths = (input.attachments ?? []).flatMap((attachment) => {
          if (config.attachmentsDir === undefined) return [];
          const path = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          return path ? [path] : [];
        });
        const promptBody =
          attachmentPaths.length === 0
            ? input.input
            : [
                input.input,
                "",
                attachmentPaths.length === 1
                  ? "The user attached an image. Read it from this path:"
                  : `The user attached ${attachmentPaths.length} images. Read them from these paths:`,
                ...attachmentPaths.map((path) => `- ${path}`),
              ].join("\n");
        // Build/Plan/Agent. `--exec` takes one text prompt and offers no
        // system-prompt channel, so the mode leads the prompt - it has to be
        // in force before the request is read. Agent mode especially: the
        // block is where `AGENT_STOP` is stated, and without it the server's
        // continuation loop has nothing to stop on.
        const modeInstructions = collaborationModePrompt(input.interactionMode);
        const prompt =
          modeInstructions === undefined ? promptBody : `${modeInstructions}\n\n${promptBody}`;
        const model = input.modelSelection?.model ?? context.session.model;
        const selectedEffort =
          getModelSelectionStringOptionValue(input.modelSelection, "effort") ??
          (input.modelSelection ? undefined : context.effort);
        if (selectedEffort !== undefined && !isDeepCodeEffort(selectedEffort)) {
          return yield* error("sendTurn", "Deep Code effort must be low, high, or max.");
        }
        const currentEnvironment = config.resolveEnvironment
          ? yield* config.resolveEnvironment.pipe(
              Effect.mapError(() =>
                error(
                  "sendTurn",
                  "The selected API key could not be loaded. Check Providers settings.",
                ),
              ),
            )
          : config.environment;
        const active: ActiveTurn = {
          id: TurnId.make(`deepcode-${config.instanceId}-${now()}-${++sequence}`),
          interrupted: false,
        };
        context.active = active;
        const ready = yield* Deferred.make<void, ProviderAdapterRequestError>();
        let terminal: ProviderRuntimeEvent | undefined;
        let stderr = "";
        const cwd = context.session.cwd ?? config.cwd;
        let resumeSessionId = sessionIdFromCursor(context.session.resumeCursor);
        let attemptPrompt = prompt;
        let recoveredContext = false;
        const prepareContinuation = Effect.fn("DeepCodeAdapter.prepareContinuation")(function* (
          sessionId: string,
          force: boolean,
        ) {
          const transcriptPath = deepCodeSessionMessagesPath(
            deepCodeHomeDir(config.environment),
            cwd,
            sessionId,
          );
          const raw = yield* fs.readFileString(transcriptPath).pipe(Effect.orElseSucceed(() => ""));
          const history = inspectDeepCodeContext(raw);
          if (!force && !history.oversized) return false;
          attemptPrompt = deepCodeContinuationPrompt({
            prompt,
            transcriptPath,
            excerpts: history.excerpts,
          });
          resumeSessionId = undefined;
          // Deliberately silent: shrinking the working context is routine
          // recovery, not news. The user only ever sees an error if the
          // retried turn itself fails.
          yield* Effect.logDebug("DeepCode continuing with a smaller working context.", {
            threadId: input.threadId,
            turnId: active.id,
            transcriptPath,
          });
          return true;
        });
        if (resumeSessionId) yield* prepareContinuation(resumeSessionId, false);
        // Fence the post-turn tool read to this turn's messages. A resumed
        // session's JSONL already holds every earlier turn, and replaying it
        // would duplicate their tool calls.
        let previousLastMessageId = resumeSessionId
          ? ((yield* readSessionMessages(resumeSessionId, cwd)).at(-1)?.id ?? null)
          : null;
        const environment = buildDeepCodeTurnEnvironment(currentEnvironment, {
          model,
          effort: selectedEffort,
        });
        let publisher: ReturnType<typeof makeSessionActivityPublisher> | undefined;
        let previousIndex: ReadonlyArray<DeepCodeSessionIndexEntry> = [];
        /**
         * Record the native session and flush its activity, exactly once.
         *
         * `interruptTurn` interrupts the run fiber outright, so anything left
         * in the fiber body is skipped when a turn is stopped — and stopping a
         * turn is precisely how a queued message reaches a provider that cannot
         * steer. Running this from the finalizer too is what keeps that path
         * from starting the next turn in a brand-new session with no memory of
         * the one it just replaced, and from leaving a tool row spinning.
         */
        const finalizeSessionActivity = Effect.gen(function* () {
          const active = publisher;
          if (active === undefined) return;
          publisher = undefined;
          const sessionId = pickDeepCodeSessionId({
            previous: previousIndex,
            next: yield* readSessionIndex(cwd),
            resumeSessionId,
          });
          const activitySessionId = sessionId ?? resumeSessionId;
          if (activitySessionId) yield* active.drain(activitySessionId);
          yield* active.settle();
          if (sessionId) {
            context.session = {
              ...context.session,
              resumeCursor: { sessionId },
            };
          }
        });
        let dispatched = false;
        const runAttempt = Effect.fn("DeepCodeAdapter.runAttempt")(function* () {
          previousIndex = yield* readSessionIndex(cwd);
          const args = buildDeepCodeExecArgs({ resumeSessionId });
          const command = yield* resolveSpawnCommand(config.binaryPath, args, { env: environment });
          const handle = yield* spawner.spawn(
            ChildProcess.make(command.command, command.args, {
              shell: command.shell,
              cwd,
              env: environment,
              extendEnv: false,
              // Deep Code reads stdin through EOF and appends it to --prompt.
              // Keep the request out of argv: npm's Windows .cmd shim has a
              // much smaller command-line limit than a normal thread handoff.
              stdin: Stream.make(new TextEncoder().encode(attemptPrompt)),
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "2 seconds",
            }),
          );
          if (active.interrupted) return;
          context.effort = selectedEffort;
          context.session = {
            ...context.session,
            status: "running",
            model,
            activeTurnId: active.id,
            updatedAt: now(),
          };
          if (!dispatched) {
            emit({
              ...base(input.threadId, active.id),
              type: "turn.started",
              payload: model ? { model } : {},
            });
            yield* options?.onNativeDispatch ?? Effect.void;
            if (input.messageId)
              emit({
                ...base(input.threadId, active.id),
                type: "message.delivered",
                payload: { messageId: input.messageId },
              });
            dispatched = true;
          }
          // Publish reasoning and tool calls while the CLI runs. The follower
          // is forked after `turn.started` so every item it emits belongs to a
          // turn the timeline already knows about, and it shares its cursors
          // with the final flush so the two cannot publish the same item twice.
          publisher = makeSessionActivityPublisher({
            threadId: input.threadId,
            turnId: active.id,
            cwd,
            previousLastMessageId,
          });
          let watchdogTripped = false;
          const stalled = yield* Deferred.make<void, ProviderAdapterRequestError>();
          const follower = yield* Effect.forkChild(
            followSessionActivity({
              publisher,
              previousIndex,
              resumeSessionId,
              cwd,
              onStalled: () => {
                watchdogTripped = true;
                Deferred.doneUnsafe(stalled, Effect.void);
              },
              startedAtMs: yield* Clock.currentTimeMillis,
            }),
          );
          const stallFailure = Effect.fail(error("run", DEEPCODE_PROGRESS_TIMEOUT_MESSAGE));
          const [stdout, stderrText, code] = yield* Effect.all(
            [
              collectUint8StreamText({ stream: handle.stdout, maxBytes: MAX_STDOUT_BYTES }),
              collectUint8StreamText({ stream: handle.stderr, maxBytes: 16_384 }),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.raceFirst(Deferred.await(stalled).pipe(Effect.andThen(() => stallFailure))),
            // A crash landing in the same instant as the trip still reports
            // the stall: five silent minutes already decided what this was.
            // Interrupts pass through untouched so Stop always wins the race.
            Effect.catchCause((cause) =>
              watchdogTripped && !Cause.hasInterruptsOnly(cause)
                ? stallFailure
                : Effect.failCause(cause),
            ),
            Effect.onExit(() => Fiber.interrupt(follower)),
          );
          stderr = stderrText.text;
          // Ahead of the interrupt and exit-code checks: work the model already
          // did is worth showing even when the turn was stopped or the CLI
          // exited non-zero.
          yield* finalizeSessionActivity;
          if (active.interrupted) return;
          // An exit landing in the same instant as the trip still reports the
          // stall: the marker is what moves the turn, not the exit code.
          if (watchdogTripped) return yield* stallFailure;
          if (code !== 0) {
            const failedSessionId = sessionIdFromCursor(context.session.resumeCursor);
            if (!recoveredContext && failedSessionId && isDeepCodeContextOverflow(stderr)) {
              recoveredContext = true;
              yield* prepareContinuation(failedSessionId, true);
              previousLastMessageId = null;
              return true;
            }
            return yield* error(
              "run",
              stderr.trim() || `Deep Code exited ${code} without a successful terminal result.`,
            );
          }
          const reply = stdout.text.replace(/\s+$/u, "");
          if (reply.length > 0) {
            emit({
              ...base(input.threadId, active.id),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: `${reply}\n` },
            });
          }
          terminal = {
            ...base(input.threadId, active.id),
            type: "turn.completed",
            payload: { state: "completed" },
          };
          Deferred.doneUnsafe(ready, Effect.void);
          return false;
        });
        const run = Effect.gen(function* () {
          if (yield* runAttempt()) yield* runAttempt();
        }).pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              // An interrupt is an outcome, not an error. Stopping a turn is
              // how Stop works and how a queued message reaches a provider
              // that cannot steer; reporting it as a failed send makes the
              // reactor record a turn failure and re-dispatch the very prompt
              // it deliberately stopped. The `interrupted` turn.completed event
              // below is what reports this.
              if (active.interrupted) {
                Deferred.doneUnsafe(ready, Effect.void);
                return;
              }
              const underlying = Cause.squash(cause);
              const failure = isAdapterRequestError(underlying)
                ? underlying
                : error("run", stderr.trim() || String(cause));
              yield* Deferred.fail(ready, failure);
              terminal = {
                ...base(input.threadId, active.id),
                type: "turn.completed",
                payload: { state: "failed", errorMessage: failure.detail },
              };
            }),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              // No-op when the body already ran it; the only caller left is an
              // interrupted turn, whose fiber never reached that point. It has
              // to be uninterruptible: the fiber is already interrupted by the
              // time this runs, so an interruptible read would be cancelled at
              // its first yield and the session would be lost anyway.
              yield* finalizeSessionActivity.pipe(Effect.uninterruptible, Effect.ignore);
              // Same reasoning as the interrupt guard above: a hard fiber
              // interrupt skips `catchCause` entirely, so settle the send here
              // too rather than letting the fallback failure escape.
              if (active.interrupted) Deferred.doneUnsafe(ready, Effect.void);
              yield* Deferred.fail(
                ready,
                error("sendTurn", "Deep Code stopped before consuming the prompt."),
              );
              context.active = undefined;
              context.session = {
                ...context.session,
                status: "ready",
                activeTurnId: undefined,
                updatedAt: now(),
              };
              if (active.interrupted)
                emit({
                  ...base(input.threadId, active.id),
                  type: "turn.completed",
                  payload: { state: "interrupted" },
                });
              else if (terminal) {
                if (terminal.type === "turn.completed" && terminal.payload.state === "failed")
                  emit({
                    ...base(input.threadId, active.id),
                    type: "runtime.error",
                    payload: {
                      message: terminal.payload.errorMessage ?? "Deep Code turn failed.",
                    },
                  });
                emit(terminal);
              }
            }),
          ),
        );
        active.fiber = yield* restore(run).pipe(Effect.forkIn(scope));
        yield* restore(Deferred.await(ready));
        return {
          threadId: input.threadId,
          turnId: active.id,
          resumeCursor: context.session.resumeCursor,
        };
      }),
    );
  });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterRequestError>["interruptTurn"] =
    Effect.fn("DeepCodeAdapter.interruptTurn")(function* (threadId, turnId) {
      const active = sessions.get(threadId)?.active;
      if (!active || (turnId && turnId !== active.id)) return;
      active.interrupted = true;
      if (active.fiber) yield* Fiber.interrupt(active.fiber);
    });
  const stopSession = Effect.fn("DeepCodeAdapter.stopSession")(function* (threadId: ThreadId) {
    yield* interruptTurn(threadId);
    if (sessions.delete(threadId))
      emit({
        ...base(threadId),
        type: "session.exited",
        payload: { reason: "Session stopped.", recoverable: true, exitKind: "graceful" },
      });
  });
  const stopAll = () => Effect.forEach([...sessions.keys()], stopSession, { discard: true });
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));
  return {
    provider: DEEPCODE_DRIVER_KIND,
    capabilities: {
      sessionModelSwitch: "in-session",
      // `--exec` runs one prompt per process and reads no steering channel, so
      // a mid-turn message cannot join the running turn.
      liveSteering: "unsupported",
      taskStop: false,
      threadRollback: false,
      threadFork: false,
      textGeneration: false,
      messageDeliveryReceipts: true,
    },
    startSession,
    sendTurn,
    interruptTurn,
    stopSession,
    stopAll,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    respondToRequest: () => unsupported("interactive approval"),
    respondToUserInput: () => unsupported("structured user input"),
    readThread: () => unsupported("native transcript read"),
    rollbackThread: () => unsupported("rollback"),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterRequestError>;
});

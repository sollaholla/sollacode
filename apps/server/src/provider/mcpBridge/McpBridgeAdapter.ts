// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { setTimeout as delay } from "node:timers/promises";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import type { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { isMcpBridgeTransportCause, type McpBridgeClient } from "./McpBridgeConnection.ts";
import {
  MCP_BRIDGE_PROTOCOL_VERSION,
  decodeMcpBridgeEventsPage,
  type McpBridgeEvent,
} from "./McpBridgeProtocol.ts";

export const MCP_BRIDGE_DRIVER_KIND = ProviderDriverKind.make("mcpBridge");
const MAX_DEDUP_EVENT_IDS = 4_096;
const MAX_TERMINAL_TURN_IDS = 1_024;
/**
 * Consecutive transport failures tolerated before an in-flight turn is
 * declared lost. A dropped stdio pipe says nothing about the conversation the
 * bridge is driving: it keeps its session, keeps answering, and replays from
 * the event cursor once the host reconnects. Failing the turn on the first
 * drop threw away answers that had already been produced, and — because the
 * turn id was then remembered as terminal — silently discarded the real
 * terminal event when it did arrive. Waiting instead matches the rule that a
 * recoverable wait is never reported as a failure until retries are spent.
 */
export const MAX_TRANSPORT_FAILURES_BEFORE_TURN_LOSS = 5;

function nowIsoUnsafe(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

interface SessionContext {
  session: ProviderSession;
  readonly workspace: string;
  model: string;
  readonly runtimeMode: ProviderSessionStartInput["runtimeMode"];
  resumeCursor: unknown;
  afterSequence: number;
  active: boolean;
  recovering: boolean;
  activeTurnId?: TurnId | undefined;
  readonly seenEventIds: Set<string>;
  readonly seenEventOrder: string[];
  readonly terminalTurnIds: Set<string>;
  readonly terminalTurnOrder: string[];
  pump?: Promise<void> | undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function assertSessionResponse(
  response: Readonly<Record<string, unknown>>,
  sessionId: ThreadId,
  operation: string,
): void {
  const received = stringValue(response.sessionId);
  if (received !== String(sessionId)) {
    throw new Error(`${operation} returned session '${received ?? "missing"}' for '${sessionId}'.`);
  }
}

function requestTypeForTool(
  toolName: unknown,
): "exec_command_approval" | "file_read_approval" | "file_change_approval" | "dynamic_tool_call" {
  switch (toolName) {
    case "exec_command":
      return "exec_command_approval";
    case "read_file":
    case "list_files":
    case "search_text":
      return "file_read_approval";
    case "replace_text":
    case "write_file":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

function itemTypeForTool(
  toolName: unknown,
): "command_execution" | "file_change" | "dynamic_tool_call" {
  if (toolName === "exec_command") return "command_execution";
  if (toolName === "replace_text" || toolName === "write_file") return "file_change";
  return "dynamic_tool_call";
}

const BRIDGE_TOOL_TITLES: Record<string, string> = {
  exec_command: "Ran command",
  replace_text: "File change",
  write_file: "File change",
  read_file: "Read file",
  read_image: "Read image",
  list_files: "Listed files",
  search_text: "Searched text",
};

const BRIDGE_DETAIL_MAX_CHARS = 4_000;

function clipDetail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > BRIDGE_DETAIL_MAX_CHARS
    ? `${trimmed.slice(0, BRIDGE_DETAIL_MAX_CHARS)}…`
    : trimmed;
}

/**
 * Detail prefix for a value the row already summarizes. A missing value drops
 * the prefix entirely rather than substituting a placeholder word, so the row
 * reads `14 entries` instead of `. · 14 entries`.
 */
function detailPrefix(value: string | undefined): string {
  return value ? `${value} · ` : "";
}

/**
 * `.`, `./` and an empty string all name the workspace root, which carries no
 * information next to the entry count, so treat them as an absent path.
 */
function displayDirectory(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const trimmed = path.trim();
  return trimmed === "" || trimmed === "." || trimmed === "./" ? undefined : path;
}

/**
 * Rebuild the payload shape the work-log expansion already understands for
 * native providers: `title` as the heading, `detail` as the expandable body,
 * `data.item.command`/`data.item.path` for command and changed-file chips, and
 * `data.rawOutput` for output summaries. The bridge itself only ships raw
 * `arguments`/`result` records, which the client deliberately does not walk.
 */
function describeBridgeToolItem(
  payload: Readonly<Record<string, unknown>>,
  completed: boolean,
): {
  title: string;
  detail?: string;
  item?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
} {
  const toolName = stringValue(payload.name) ?? "Tool call";
  const title = BRIDGE_TOOL_TITLES[toolName] ?? toolName;
  const args = record(payload.arguments);
  const result = record(payload.result);
  const value = record(result.value);
  const failure = completed && result.ok === false ? stringValue(result.error) : undefined;
  const path = stringValue(args.path) ?? stringValue(value.path);

  if (toolName === "exec_command") {
    const command = stringValue(args.command) ?? stringValue(value.command);
    const item = command ? { command, ...(path ? { path } : {}) } : path ? { path } : undefined;
    if (!completed) {
      return {
        title,
        ...(command ? { detail: clipDetail(command) } : {}),
        ...(item ? { item } : {}),
      };
    }
    if (failure !== undefined) {
      return { title, detail: clipDetail(failure), ...(item ? { item } : {}) };
    }
    const stdout = stringValue(value.stdout);
    const stderr = stringValue(value.stderr);
    const output = stdout ?? stderr;
    const exitCode = typeof value.exit_code === "number" ? value.exit_code : undefined;
    const flags = [
      value.timed_out === true ? "timed out" : undefined,
      value.cancelled === true ? "cancelled" : undefined,
      value.truncated === true ? "output truncated" : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    const body = [
      output !== undefined ? clipDetail(output) : undefined,
      flags.length > 0 ? `(${flags.join(", ")})` : undefined,
      exitCode !== undefined ? `<exited with exit code ${exitCode}>` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n");
    return {
      title,
      ...(body ? { detail: body } : {}),
      ...(item ? { item } : {}),
      rawOutput: {
        ...(output !== undefined ? { stdout: output } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      },
    };
  }

  const item = path ? { path } : undefined;
  if (failure !== undefined) {
    return { title, detail: clipDetail(failure), ...(item ? { item } : {}) };
  }

  switch (toolName) {
    case "replace_text":
    case "write_file": {
      const summary = completed
        ? typeof value.replacements === "number"
          ? `${detailPrefix(path)}${value.replacements} replacement${value.replacements === 1 ? "" : "s"}`
          : value.created === true
            ? `${detailPrefix(path)}created`
            : path
        : path;
      return {
        title,
        ...(summary ? { detail: clipDetail(summary) } : {}),
        ...(item ? { item } : {}),
      };
    }
    case "read_file": {
      const range =
        typeof value.start_line === "number" && typeof value.end_line === "number"
          ? ` · lines ${value.start_line}-${value.end_line}`
          : "";
      return {
        title,
        ...(path ? { detail: clipDetail(`${path}${range}`) } : {}),
        ...(item ? { item } : {}),
        ...(completed && stringValue(value.content)
          ? { rawOutput: { content: stringValue(value.content) } }
          : {}),
      };
    }
    case "read_image":
      return { title, ...(path ? { detail: clipDetail(path) } : {}), ...(item ? { item } : {}) };
    case "list_files": {
      const entries = Array.isArray(value.entries) ? value.entries.length : undefined;
      const detail =
        completed && entries !== undefined
          ? `${detailPrefix(displayDirectory(path))}${entries} entr${entries === 1 ? "y" : "ies"}${value.truncated === true ? "+" : ""}`
          : (path ?? stringValue(args.path));
      return {
        title,
        ...(detail ? { detail: clipDetail(detail) } : {}),
        ...(item ? { item } : {}),
        ...(entries !== undefined
          ? { rawOutput: { totalFiles: entries, truncated: value.truncated === true } }
          : {}),
      };
    }
    case "search_text": {
      const pattern = stringValue(args.pattern) ?? stringValue(args.query);
      const matches = Array.isArray(value.matches) ? value.matches.length : undefined;
      const detail =
        completed && matches !== undefined
          ? `${detailPrefix(pattern)}${matches} match${matches === 1 ? "" : "es"}${value.truncated === true ? "+" : ""}`
          : pattern;
      return {
        title,
        ...(detail ? { detail: clipDetail(detail) } : {}),
        ...(item ? { item } : {}),
      };
    }
    default: {
      const argsPreview = Object.keys(args).length > 0 ? JSON.stringify(args) : undefined;
      return {
        title,
        ...(argsPreview ? { detail: clipDetail(argsPreview) } : {}),
        ...(item ? { item } : {}),
      };
    }
  }
}

function eventBase(
  event: McpBridgeEvent,
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    eventId: EventId.make(event.eventId),
    provider: MCP_BRIDGE_DRIVER_KIND,
    providerInstanceId: instanceId,
    threadId,
    createdAt: event.timestamp,
    ...(event.turnId ? { turnId: TurnId.make(event.turnId) } : {}),
    ...(event.itemId ? { itemId: RuntimeItemId.make(event.itemId) } : {}),
    ...(event.requestId ? { requestId: RuntimeRequestId.make(event.requestId) } : {}),
  };
}

export function mapMcpBridgeEvent(
  event: McpBridgeEvent,
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
): ProviderRuntimeEvent {
  const base = eventBase(event, instanceId, threadId);
  const payload = event.payload;
  switch (event.type) {
    case "session.started":
      return {
        ...base,
        type: "session.started",
        payload: {
          message: `External provider session started${
            stringValue(payload.model) ? ` with ${stringValue(payload.model)}` : ""
          }.`,
          resume: payload.resumeCursor,
        },
      };
    case "session.stopped":
      return {
        ...base,
        type: "session.exited",
        payload: {
          reason: "External provider session stopped.",
          recoverable: true,
          exitKind: "graceful",
        },
      };
    case "turn.started":
      return {
        ...base,
        type: "turn.started",
        payload: { ...(stringValue(payload.model) ? { model: stringValue(payload.model) } : {}) },
      };
    case "turn.completed":
      return {
        ...base,
        type: "turn.completed",
        payload: { state: "completed", stopReason: stringValue(payload.finishReason) ?? "stop" },
      };
    case "turn.interrupted":
      return {
        ...base,
        type: "turn.completed",
        payload: { state: "interrupted", stopReason: "interrupted" },
      };
    case "turn.failed":
      return {
        ...base,
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: stringValue(payload.error) ?? "External provider turn failed.",
        },
      };
    case "content.delta":
      return {
        ...base,
        type: "content.delta",
        payload: {
          streamKind:
            payload.kind === "reasoning" || payload.kind === "reasoning_text"
              ? "reasoning_text"
              : "assistant_text",
          // Browser-backed bridges publish one authoritative completed
          // snapshot here. Solla receives it once as a single delta and never
          // sees both fragments and cumulative snapshots.
          delta: typeof payload.text === "string" ? payload.text : "",
        },
      };
    case "reasoning.status":
    case "runtime.status":
      return {
        ...base,
        itemId: base.itemId ?? RuntimeItemId.make(`${event.turnId ?? event.sessionId}:status`),
        type: "item.updated",
        payload: {
          itemType: "reasoning",
          status: "inProgress",
          detail: stringValue(payload.text) ?? stringValue(payload.phase) ?? "Provider is working.",
          data: payload,
        },
      };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      // An assistant-message item is not a tool item. The bridge emits one to
      // close a tool-loop round's prose so the next round's narration starts a
      // new message; without it the host reuses one message for the whole turn
      // and every round's prose lands as a single wall of paragraphs. Mapping
      // it through itemTypeForTool would force it to a tool type and the host
      // would never release the active message.
      if (payload.itemType === "assistant_message") {
        const detail = stringValue(payload.text);
        return {
          ...base,
          type: event.type,
          payload: {
            itemType: "assistant_message",
            status: event.type === "item.completed" ? "completed" : "inProgress",
            title: "Assistant message",
            ...(detail ? { detail } : {}),
          },
        };
      }
      const toolName = payload.name;
      const completed = event.type === "item.completed";
      const described = describeBridgeToolItem(payload, completed);
      return {
        ...base,
        type: event.type,
        payload: {
          itemType: itemTypeForTool(toolName),
          status: completed
            ? record(payload.result).ok === false
              ? "failed"
              : "completed"
            : "inProgress",
          title: described.title,
          ...(described.detail ? { detail: described.detail } : {}),
          data: {
            ...payload,
            ...(event.itemId ? { toolCallId: event.itemId } : {}),
            ...(described.item ? { item: described.item } : {}),
            ...(described.rawOutput ? { rawOutput: described.rawOutput } : {}),
          },
        },
      };
    }
    case "request.opened":
      return {
        ...base,
        type: "request.opened",
        payload: {
          requestType: requestTypeForTool(payload.toolName),
          ...(stringValue(payload.toolName)
            ? { detail: `Approve ${stringValue(payload.toolName)}` }
            : {}),
          args: payload.arguments,
        },
      };
    case "request.resolved":
      return {
        ...base,
        type: "request.resolved",
        payload: {
          requestType: "unknown",
          decision: payload.approved === true ? "accept" : "decline",
          resolution: payload.response,
        },
      };
    case "user-input.requested":
      return {
        ...base,
        type: "user-input.requested",
        payload: { questions: Array.isArray(payload.questions) ? payload.questions : [] },
      } as ProviderRuntimeEvent;
    case "user-input.resolved":
      return {
        ...base,
        type: "user-input.resolved",
        payload: { answers: record(payload.answers ?? payload.response) },
      };
    case "message.delivered":
      return {
        ...base,
        type: "message.delivered",
        payload: { messageId: stringValue(payload.messageId) ?? "unknown" },
      } as ProviderRuntimeEvent;
    case "runtime.warning":
      return {
        ...base,
        type: "runtime.warning",
        payload: {
          message: stringValue(payload.message) ?? "External provider warning.",
          detail: payload,
        },
      };
    case "runtime.error":
      return {
        ...base,
        type: "runtime.error",
        payload: {
          message:
            stringValue(payload.message) ??
            stringValue(payload.error) ??
            "External provider error.",
          class: "provider_error",
          detail: payload,
        },
      };
  }
}

function adapterError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: MCP_BRIDGE_DRIVER_KIND,
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export const makeMcpBridgeAdapter = Effect.fn("makeMcpBridgeAdapter")(function* (input: {
  readonly connection: McpBridgeClient;
  readonly instanceId: ProviderInstanceId;
  readonly serverConfig: ServerConfig["Service"];
}) {
  const runtimeEvents = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const sessions = new Map<ThreadId, SessionContext>();

  const emit = (event: ProviderRuntimeEvent): void => {
    Effect.runFork(PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid));
  };

  const requireSession = (threadId: ThreadId): SessionContext => {
    const context = sessions.get(threadId);
    if (!context || !context.active) {
      throw new ProviderAdapterSessionNotFoundError({
        provider: MCP_BRIDGE_DRIVER_KIND,
        threadId,
      });
    }
    return context;
  };

  const bridgeSessionArguments = (context: SessionContext) => ({
    protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
    sessionId: String(context.session.threadId),
    model: context.model,
    workspace: context.workspace,
    runtimeMode: context.runtimeMode,
    resumeCursor: context.resumeCursor,
  });

  const recoverSession = async (context: SessionContext): Promise<void> => {
    if (context.recovering || !context.active) return;
    context.recovering = true;
    try {
      const response = await input.connection.call(
        "provider_bridge.session_start",
        bridgeSessionArguments(context),
        60_000,
      );
      assertSessionResponse(
        response,
        context.session.threadId,
        "provider_bridge.session_start recovery",
      );
      context.resumeCursor = response.resumeCursor ?? context.resumeCursor;
      context.afterSequence = 0;
    } finally {
      context.recovering = false;
    }
  };

  const rememberEvent = (context: SessionContext, eventId: string): boolean => {
    if (context.seenEventIds.has(eventId)) return false;
    context.seenEventIds.add(eventId);
    context.seenEventOrder.push(eventId);
    if (context.seenEventOrder.length > MAX_DEDUP_EVENT_IDS) {
      const removed = context.seenEventOrder.shift();
      if (removed) context.seenEventIds.delete(removed);
    }
    return true;
  };

  const rememberTerminalTurn = (context: SessionContext, turnId: TurnId): void => {
    const value = String(turnId);
    if (context.terminalTurnIds.has(value)) return;
    context.terminalTurnIds.add(value);
    context.terminalTurnOrder.push(value);
    if (context.terminalTurnOrder.length > MAX_TERMINAL_TURN_IDS) {
      const removed = context.terminalTurnOrder.shift();
      if (removed) context.terminalTurnIds.delete(removed);
    }
  };

  const failActiveTurn = (context: SessionContext, cause: unknown): void => {
    const turnId = context.activeTurnId;
    if (!turnId || context.terminalTurnIds.has(String(turnId))) return;
    rememberTerminalTurn(context, turnId);
    context.activeTurnId = undefined;
    const createdAt = nowIsoUnsafe();
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: createdAt,
    };
    emit({
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: MCP_BRIDGE_DRIVER_KIND,
      providerInstanceId: input.instanceId,
      threadId: context.session.threadId,
      turnId,
      createdAt,
      type: "turn.completed",
      payload: {
        state: "failed",
        errorMessage: `External provider bridge failed or disconnected during the active turn: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      },
    });
  };

  const startEventPump = (threadId: ThreadId, context: SessionContext): void => {
    if (context.pump) return;
    const descriptorLimits = input.connection.descriptor?.limits;
    const pollTimeoutMs = Math.max(
      0,
      Math.min(25_000, descriptorLimits?.eventsNextTimeoutMs ?? 25_000),
    );
    const maxEvents = Math.max(1, Math.min(200, descriptorLimits?.maxEventsPerPoll ?? 100));
    context.pump = (async () => {
      let failures = 0;
      while (context.active) {
        try {
          const page = decodeMcpBridgeEventsPage(
            await input.connection.call(
              "provider_bridge.events_next",
              {
                protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
                sessionId: String(threadId),
                afterSequence: context.afterSequence,
                maxEvents,
                timeoutMs: pollTimeoutMs,
              },
              Math.max(5_000, pollTimeoutMs + 5_000),
            ),
          );
          failures = 0;
          if (page.sessionId !== String(threadId)) {
            throw new Error(`events_next returned session '${page.sessionId}' for '${threadId}'.`);
          }
          const firstSequence = page.events[0]?.sequence;
          const lastSequence = page.events.at(-1)?.sequence;
          if (
            !page.gap &&
            firstSequence !== undefined &&
            firstSequence !== context.afterSequence + 1
          ) {
            throw new Error(
              `events_next returned sequence ${firstSequence} after ${context.afterSequence}; expected ${context.afterSequence + 1}.`,
            );
          }
          if (lastSequence !== undefined && page.nextSequence < lastSequence) {
            throw new Error(
              `events_next nextSequence ${page.nextSequence} precedes event ${lastSequence}.`,
            );
          }
          if (page.nextSequence < context.afterSequence) {
            throw new Error(
              `events_next regressed from ${context.afterSequence} to ${page.nextSequence}.`,
            );
          }
          if (
            !page.gap &&
            page.events.length === 0 &&
            page.nextSequence !== context.afterSequence
          ) {
            throw new Error(
              `events_next advanced an empty page from ${context.afterSequence} to ${page.nextSequence}.`,
            );
          }
          if (page.gap) {
            const snapshot = await input.connection.call(
              "provider_bridge.thread_read",
              { protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION, sessionId: String(threadId) },
              15_000,
            );
            assertSessionResponse(snapshot, threadId, "provider_bridge.thread_read recovery");
            context.afterSequence = page.nextSequence;
            emit({
              eventId: EventId.make(NodeCrypto.randomUUID()),
              provider: MCP_BRIDGE_DRIVER_KIND,
              providerInstanceId: input.instanceId,
              threadId,
              createdAt: nowIsoUnsafe(),
              type: "runtime.warning",
              payload: {
                message:
                  "External provider event cursor expired; transcript state was resynchronized.",
                detail: { oldestSequence: page.oldestSequence, nextSequence: page.nextSequence },
              },
            });
            continue;
          }
          for (const event of page.events) {
            if (event.sessionId !== String(threadId)) {
              throw new Error(`External event '${event.eventId}' crossed session boundaries.`);
            }
            if (!rememberEvent(context, event.eventId)) continue;
            const isTerminal =
              event.type === "turn.completed" ||
              event.type === "turn.interrupted" ||
              event.type === "turn.failed";
            if (event.turnId && context.terminalTurnIds.has(event.turnId)) continue;
            if (event.turnId && !isTerminal) context.activeTurnId = TurnId.make(event.turnId);
            if (isTerminal) {
              const terminalTurnId = event.turnId
                ? TurnId.make(event.turnId)
                : context.activeTurnId;
              if (terminalTurnId) rememberTerminalTurn(context, terminalTurnId);
              context.activeTurnId = undefined;
              context.session = {
                ...context.session,
                status: "ready",
                activeTurnId: undefined,
                updatedAt: event.timestamp,
              };
            }
            emit(mapMcpBridgeEvent(event, input.instanceId, threadId));
          }
          context.afterSequence = page.nextSequence;
        } catch (cause) {
          if (!context.active) break;
          failures += 1;
          // Only a broken pipe is retryable. A contract violation (out-of-order
          // sequences, a crossed session boundary) is a real defect in what the
          // bridge sent, and retrying it forever would hide it.
          const transport = isMcpBridgeTransportCause(cause);
          const givingUp = !transport || failures > MAX_TRANSPORT_FAILURES_BEFORE_TURN_LOSS;
          // Reconnecting is internal. The turn is still running and the pipe is
          // expected to come back, so there is nothing here for the user to act
          // on — and anything published lands in the work log with an error
          // tone, which is how "the turn is still running" came to be rendered
          // as a red failure while the turn was, in fact, still running.
          // Nothing is emitted until the retries are actually exhausted.
          if (givingUp) {
            failActiveTurn(context, cause);
            emit({
              eventId: EventId.make(NodeCrypto.randomUUID()),
              provider: MCP_BRIDGE_DRIVER_KIND,
              providerInstanceId: input.instanceId,
              threadId,
              createdAt: nowIsoUnsafe(),
              type: failures >= 3 ? "runtime.error" : "runtime.warning",
              payload: {
                message: `External provider event stream interrupted: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
                ...(failures >= 3 ? { class: "transport_error" as const } : {}),
              },
            } as ProviderRuntimeEvent);
          }
          await delay(Math.min(4_000, 250 * 2 ** failures));
          if (!context.active) break;
          try {
            await recoverSession(context);
          } catch {
            // The next bounded iteration reports and retries. This loop never
            // launches or signals any process outside this instance transport.
          }
        }
      }
    })().finally(() => {
      context.pump = undefined;
    });
  };

  const startSession: ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterValidationError
    | ProviderAdapterSessionNotFoundError
  >["startSession"] = Effect.fn("McpBridgeAdapter.startSession")(function* (sessionInput) {
    const existing = sessions.get(sessionInput.threadId);
    if (existing?.active) return existing.session;
    const descriptor = yield* Effect.tryPromise({
      try: () => input.connection.describe(),
      catch: (cause) => adapterError("provider_bridge.describe", cause),
    });
    const model = sessionInput.modelSelection?.model ?? descriptor.defaultModel;
    if (!descriptor.models.some((candidate) => candidate.id === model)) {
      return yield* new ProviderAdapterValidationError({
        provider: MCP_BRIDGE_DRIVER_KIND,
        operation: "session_start",
        issue: `Model '${model}' is not advertised by the external bridge.`,
      });
    }
    const workspace = sessionInput.cwd ?? input.serverConfig.cwd;
    const response = yield* Effect.tryPromise({
      try: () =>
        input.connection.call(
          "provider_bridge.session_start",
          {
            protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
            sessionId: String(sessionInput.threadId),
            model,
            workspace,
            runtimeMode: sessionInput.runtimeMode,
            resumeCursor: sessionInput.resumeCursor,
          },
          60_000,
        ),
      catch: (cause) => adapterError("provider_bridge.session_start", cause),
    });
    try {
      assertSessionResponse(response, sessionInput.threadId, "provider_bridge.session_start");
    } catch (cause) {
      return yield* new ProviderAdapterValidationError({
        provider: MCP_BRIDGE_DRIVER_KIND,
        operation: "session_start",
        issue: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const session: ProviderSession = {
      provider: MCP_BRIDGE_DRIVER_KIND,
      providerInstanceId: input.instanceId,
      status: "ready",
      runtimeMode: sessionInput.runtimeMode,
      cwd: workspace,
      model,
      threadId: sessionInput.threadId,
      resumeCursor: response.resumeCursor,
      createdAt: now,
      updatedAt: now,
    };
    const context: SessionContext = {
      session,
      workspace,
      model,
      runtimeMode: sessionInput.runtimeMode,
      resumeCursor: response.resumeCursor ?? sessionInput.resumeCursor,
      afterSequence: 0,
      active: true,
      recovering: false,
      seenEventIds: new Set(),
      seenEventOrder: [],
      terminalTurnIds: new Set(),
      terminalTurnOrder: [],
    };
    sessions.set(sessionInput.threadId, context);
    startEventPump(sessionInput.threadId, context);
    return session;
  });

  const sendTurn: ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterValidationError
    | ProviderAdapterSessionNotFoundError
  >["sendTurn"] = Effect.fn("McpBridgeAdapter.sendTurn")(function* (turnInput) {
    const context = requireSession(turnInput.threadId);
    const requestedModel = turnInput.modelSelection?.model;
    const modelSwitchRequiresNewThread =
      input.connection.descriptor?.capabilities.modelSwitchRequiresNewThread ?? true;
    if (requestedModel && requestedModel !== context.model && modelSwitchRequiresNewThread) {
      return yield* new ProviderAdapterValidationError({
        provider: MCP_BRIDGE_DRIVER_KIND,
        operation: "turn_start",
        issue: `This external bridge requires a new thread to switch from '${context.model}' to '${requestedModel}'.`,
      });
    }
    const attachments: string[] = [];
    for (const attachment of turnInput.attachments ?? []) {
      const path = resolveAttachmentPath({
        attachmentsDir: input.serverConfig.attachmentsDir,
        attachment,
      });
      if (!path) {
        return yield* new ProviderAdapterValidationError({
          provider: MCP_BRIDGE_DRIVER_KIND,
          operation: "turn_start",
          issue: `Attachment '${attachment.id}' does not resolve to a safe local path.`,
        });
      }
      attachments.push(path);
    }
    const activeTurnId = context.activeTurnId;
    if (context.session.status === "running" && activeTurnId !== undefined) {
      // Attachments ride the follow-up like any other message content. The
      // bridge queues a follow-up it cannot deliver immediately and hands the
      // whole batch — text and files together — to the browser at its next
      // safe boundary, so refusing them here only lost the user's images.
      if (input.connection.descriptor?.capabilities.turnSteering !== true) {
        return yield* new ProviderAdapterValidationError({
          provider: MCP_BRIDGE_DRIVER_KIND,
          operation: "turn_steer",
          issue: "This external bridge does not support mid-turn steering.",
        });
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          input.connection.call(
            "provider_bridge.turn_steer",
            {
              protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
              sessionId: String(turnInput.threadId),
              expectedTurnId: String(activeTurnId),
              ...(turnInput.messageId ? { messageId: String(turnInput.messageId) } : {}),
              // An attachment-only follow-up carries no prose, and the bridge
              // requires a message, so name what was sent instead of dropping
              // it for being "empty".
              message:
                turnInput.input?.trim() ||
                (attachments.length > 0
                  ? "Please review the attached file(s)."
                  : "Continue with this follow-up."),
              attachments,
            },
            30_000,
          ),
        catch: (cause) => adapterError("provider_bridge.turn_steer", cause),
      });
      try {
        assertSessionResponse(response, turnInput.threadId, "provider_bridge.turn_steer");
        const returnedTurnId = stringValue(response.turnId);
        if (returnedTurnId !== String(activeTurnId) || response.accepted !== true) {
          throw new Error(
            `provider_bridge.turn_steer did not acknowledge active turn '${activeTurnId}'.`,
          );
        }
      } catch (cause) {
        return yield* new ProviderAdapterValidationError({
          provider: MCP_BRIDGE_DRIVER_KIND,
          operation: "turn_steer",
          issue: cause instanceof Error ? cause.message : String(cause),
        });
      }
      context.resumeCursor = response.resumeCursor ?? context.resumeCursor;
      context.session = {
        ...context.session,
        resumeCursor: response.resumeCursor ?? context.session.resumeCursor,
        updatedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      };
      return {
        threadId: turnInput.threadId,
        turnId: activeTurnId,
        resumeCursor: response.resumeCursor,
      };
    }
    const response = yield* Effect.tryPromise({
      try: () =>
        input.connection.call(
          "provider_bridge.turn_start",
          {
            protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
            sessionId: String(turnInput.threadId),
            ...(turnInput.messageId ? { messageId: String(turnInput.messageId) } : {}),
            message: turnInput.input ?? "Please review the attached image.",
            model: requestedModel ?? context.model,
            runtimeMode: context.runtimeMode,
            interactionMode: turnInput.interactionMode ?? "default",
            attachments,
          },
          30_000,
        ),
      catch: (cause) => adapterError("provider_bridge.turn_start", cause),
    });
    try {
      assertSessionResponse(response, turnInput.threadId, "provider_bridge.turn_start");
    } catch (cause) {
      return yield* new ProviderAdapterValidationError({
        provider: MCP_BRIDGE_DRIVER_KIND,
        operation: "turn_start",
        issue: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const rawTurnId = stringValue(response.turnId);
    if (!rawTurnId) {
      return yield* new ProviderAdapterValidationError({
        provider: MCP_BRIDGE_DRIVER_KIND,
        operation: "turn_start",
        issue: "External bridge returned no turnId.",
      });
    }
    const turnId = TurnId.make(rawTurnId);
    const alreadyTerminal = context.terminalTurnIds.has(rawTurnId);
    context.model = requestedModel ?? context.model;
    context.activeTurnId = alreadyTerminal ? undefined : turnId;
    context.session = {
      ...context.session,
      model: context.model,
      status: alreadyTerminal ? "ready" : "running",
      activeTurnId: alreadyTerminal ? undefined : turnId,
      resumeCursor: response.resumeCursor ?? context.session.resumeCursor,
      updatedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    };
    context.resumeCursor = response.resumeCursor ?? context.resumeCursor;
    return {
      threadId: turnInput.threadId,
      turnId,
      resumeCursor: response.resumeCursor,
    };
  });

  const interruptTurn = (threadId: ThreadId, turnId?: TurnId) =>
    Effect.tryPromise({
      try: async () => {
        const context = requireSession(threadId);
        const activeTurnId = turnId ?? context.activeTurnId;
        if (!activeTurnId) return;
        const response = await input.connection.call(
          "provider_bridge.turn_interrupt",
          {
            protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
            sessionId: String(threadId),
            turnId: String(activeTurnId),
          },
          20_000,
        );
        assertSessionResponse(response, threadId, "provider_bridge.turn_interrupt");
      },
      catch: (cause) => adapterError("provider_bridge.turn_interrupt", cause),
    });

  const respondToRequest = (
    threadId: ThreadId,
    requestId: Parameters<ProviderAdapterShape<never>["respondToRequest"]>[1],
    decision: ProviderApprovalDecision,
  ) =>
    Effect.tryPromise({
      try: async () => {
        requireSession(threadId);
        const response = await input.connection.call(
          "provider_bridge.request_respond",
          {
            protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
            sessionId: String(threadId),
            requestId: String(requestId),
            decision,
          },
          15_000,
        );
        assertSessionResponse(response, threadId, "provider_bridge.request_respond");
      },
      catch: (cause) => adapterError("provider_bridge.request_respond", cause),
    });

  const respondToUserInput = (
    threadId: ThreadId,
    requestId: Parameters<ProviderAdapterShape<never>["respondToUserInput"]>[1],
    answers: ProviderUserInputAnswers,
  ) =>
    Effect.tryPromise({
      try: async () => {
        requireSession(threadId);
        const response = await input.connection.call(
          "provider_bridge.user_input_respond",
          {
            protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
            sessionId: String(threadId),
            requestId: String(requestId),
            response: answers,
          },
          15_000,
        );
        assertSessionResponse(response, threadId, "provider_bridge.user_input_respond");
      },
      catch: (cause) => adapterError("provider_bridge.user_input_respond", cause),
    });

  const stopSession = (threadId: ThreadId) =>
    Effect.tryPromise({
      try: async () => {
        const context = requireSession(threadId);
        // Stop the event pump before asking the bridge to tear the session down.
        // Otherwise a poll that races the remote removal can interpret the
        // expected "unknown session" response as a crash and recreate the tab.
        context.active = false;
        try {
          const response = await input.connection.call(
            "provider_bridge.session_stop",
            { protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION, sessionId: String(threadId) },
            20_000,
          );
          assertSessionResponse(response, threadId, "provider_bridge.session_stop");
        } finally {
          context.activeTurnId = undefined;
          context.session = {
            ...context.session,
            status: "closed",
            activeTurnId: undefined,
            updatedAt: nowIsoUnsafe(),
          };
          sessions.delete(threadId);
        }
      },
      catch: (cause) => adapterError("provider_bridge.session_stop", cause),
    });

  const readThread = (threadId: ThreadId) =>
    Effect.tryPromise({
      try: async (): Promise<ProviderThreadSnapshot> => {
        requireSession(threadId);
        const response = await input.connection.call(
          "provider_bridge.thread_read",
          { protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION, sessionId: String(threadId) },
          15_000,
        );
        assertSessionResponse(response, threadId, "provider_bridge.thread_read");
        const messages = Array.isArray(response.messages) ? response.messages : [];
        const turns = new Map<string, unknown[]>();
        messages.forEach((message, index) => {
          const entry = record(message);
          const turn = stringValue(entry.turnId) ?? `bridge-turn-${index + 1}`;
          const items = turns.get(turn) ?? [];
          items.push(entry);
          turns.set(turn, items);
        });
        return {
          threadId,
          turns: [...turns].map(([turnId, items]) => ({ id: TurnId.make(turnId), items })),
        };
      },
      catch: (cause) => adapterError("provider_bridge.thread_read", cause),
    });

  const rollbackThread = (threadId: ThreadId, _numTurns: number) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: MCP_BRIDGE_DRIVER_KIND,
        operation: "rollbackThread",
        issue: `External provider session '${threadId}' does not support thread rollback.`,
      }),
    );

  const stopAll = () =>
    Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId).pipe(Effect.ignore), {
      discard: true,
      concurrency: "unbounded",
    });

  return {
    provider: MCP_BRIDGE_DRIVER_KIND,
    capabilities: {
      get sessionModelSwitch() {
        return input.connection.descriptor?.capabilities.modelSwitchRequiresNewThread === false
          ? "in-session"
          : "unsupported";
      },
      get taskStop() {
        return input.connection.descriptor?.capabilities.taskStop ?? false;
      },
      get threadRollback() {
        return false;
      },
      get threadFork() {
        return false;
      },
      get textGeneration() {
        return input.connection.descriptor?.capabilities.textGeneration ?? false;
      },
    },
    startSession,
    sendTurn,
    interruptTurn,
    stopTask: (threadId) => interruptTurn(threadId),
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () => Effect.succeed([...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.succeed(sessions.get(threadId)?.active === true),
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEvents),
  } satisfies ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterValidationError
    | ProviderAdapterSessionNotFoundError
  >;
});

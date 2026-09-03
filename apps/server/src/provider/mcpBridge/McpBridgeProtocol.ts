/** Application-level contract layered on top of MCP stdio. */
export const MCP_BRIDGE_PROTOCOL_VERSION = "solla.provider-bridge/1" as const;

export const MCP_BRIDGE_TOOL_NAMES = [
  "provider_bridge.describe",
  "provider_bridge.session_start",
  "provider_bridge.turn_start",
  "provider_bridge.turn_steer",
  "provider_bridge.events_next",
  "provider_bridge.turn_interrupt",
  "provider_bridge.request_respond",
  "provider_bridge.user_input_respond",
  "provider_bridge.session_stop",
  "provider_bridge.sessions_list",
  "provider_bridge.thread_read",
  "provider_bridge.generate_text",
  "provider_bridge.shutdown",
] as const;

export type McpBridgeToolName = (typeof MCP_BRIDGE_TOOL_NAMES)[number];

export interface McpBridgeDescriptor {
  readonly protocolVersion: typeof MCP_BRIDGE_PROTOCOL_VERSION;
  readonly provider: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
  };
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly provider?: string | undefined;
  }>;
  readonly defaultModel: string;
  readonly capabilities: {
    readonly taskStop: boolean;
    readonly textGeneration: boolean;
    readonly threadRollback: boolean;
    readonly threadFork: boolean;
    readonly modelSwitchRequiresNewThread: boolean;
    readonly turnSteering?: boolean | undefined;
  };
  readonly limits: {
    readonly eventRetention?: number | undefined;
    readonly eventsNextTimeoutMs?: number | undefined;
    readonly maxEventsPerPoll?: number | undefined;
  };
  readonly health: {
    readonly status: string;
    readonly detail?: string | null | undefined;
    readonly [key: string]: unknown;
  };
}

export const MCP_BRIDGE_EVENT_TYPES = [
  "session.started",
  "session.stopped",
  "turn.started",
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "reasoning.status",
  "runtime.status",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "message.delivered",
  "runtime.warning",
  "runtime.error",
] as const;

export type McpBridgeEventType = (typeof MCP_BRIDGE_EVENT_TYPES)[number];

export interface McpBridgeEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly type: McpBridgeEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface McpBridgeEventsPage {
  readonly protocolVersion: typeof MCP_BRIDGE_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly gap: boolean;
  readonly oldestSequence?: number | undefined;
  readonly nextSequence: number;
  readonly events: ReadonlyArray<McpBridgeEvent>;
}

export class McpBridgeProtocolError extends Error {
  override readonly name = "McpBridgeProtocolError";
}

const MAX_EVENT_PAYLOAD_CHARACTERS = 2 * 1024 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpBridgeProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string, maximum = 1_000): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new McpBridgeProtocolError(`${label} must be a non-empty string.`);
  }
  if (value.length > maximum) {
    throw new McpBridgeProtocolError(`${label} exceeds ${maximum} characters.`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new McpBridgeProtocolError(`${label} must be a boolean.`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new McpBridgeProtocolError(`${label} must be a bounded non-negative integer.`);
  }
  return value as number;
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new McpBridgeProtocolError(`${label} must be a string when present.`);
  }
  if (value.length > maximum) {
    throw new McpBridgeProtocolError(`${label} exceeds ${maximum} characters.`);
  }
  return value;
}

/**
 * Replace an oversized event payload with a bounded stand-in.
 *
 * Rejecting the event used to be fatal for the whole session: the adapter's
 * pump re-reads the same sequence on every poll, fails on it again, and the
 * thread fills with "External provider event stream interrupted:
 * event.payload exceeds 2097152 characters" every few seconds until the app
 * is relaunched (observed live 2026-09-02 on a preview_snapshot tool result
 * of ~2 MB). One over-large work-log row is not worth a dead session: keep
 * the fields the work log keys on, drop the bulk, and say so in the row.
 */
function boundedEventPayload(
  type: McpBridgeEventType,
  payload: Record<string, unknown>,
  serializedLength: number,
): Record<string, unknown> {
  const keep: Record<string, unknown> = {};
  for (const key of ["kind", "itemType", "name", "phase", "code"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length <= 1_000) keep[key] = value;
  }
  const note = `event payload of ${serializedLength} characters exceeded the ${MAX_EVENT_PAYLOAD_CHARACTERS} character limit and was reduced by the host; the provider kept the full content.`;
  switch (type) {
    case "content.delta":
      return { ...keep, text: note };
    case "turn.failed":
      return { ...keep, error: note };
    case "item.started":
    case "item.updated":
    case "item.completed":
      return { ...keep, result: { ok: true, truncated: true, value: note } };
    default:
      return { ...keep, message: note };
  }
}

function validateEventPayload(
  type: McpBridgeEventType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (cause) {
    throw new McpBridgeProtocolError(
      `event.payload must be JSON-serializable: ${cause instanceof Error ? cause.message : String(cause)}.`,
    );
  }
  if (serialized.length > MAX_EVENT_PAYLOAD_CHARACTERS) {
    payload = boundedEventPayload(type, payload, serialized.length);
  }

  switch (type) {
    case "content.delta": {
      optionalBoundedString(payload.kind, "event.payload.kind", 128);
      optionalBoundedString(payload.finishReason, "event.payload.finishReason", 128);
      if (typeof payload.text !== "string") {
        throw new McpBridgeProtocolError("content.delta payload.text must be a string.");
      }
      if (payload.text.length > MAX_EVENT_PAYLOAD_CHARACTERS) {
        throw new McpBridgeProtocolError("content.delta payload.text is too large.");
      }
      if (payload.authoritative !== undefined) {
        booleanValue(payload.authoritative, "event.payload.authoritative");
      }
      return payload;
    }
    case "turn.failed":
      nonEmptyString(payload.error, "event.payload.error", 100_000);
      return payload;
    case "item.started":
    case "item.updated":
    case "item.completed":
      nonEmptyString(payload.kind, "event.payload.kind", 128);
      optionalBoundedString(payload.name, "event.payload.name", 512);
      return payload;
    case "reasoning.status":
    case "runtime.status":
      if (
        optionalBoundedString(payload.text, "event.payload.text", 100_000) === undefined &&
        optionalBoundedString(payload.phase, "event.payload.phase", 256) === undefined
      ) {
        throw new McpBridgeProtocolError(`${type} requires payload.text or payload.phase.`);
      }
      return payload;
    case "request.opened":
      nonEmptyString(payload.kind, "event.payload.kind", 128);
      optionalBoundedString(payload.toolName, "event.payload.toolName", 512);
      return payload;
    case "request.resolved":
      booleanValue(payload.approved, "event.payload.approved");
      return payload;
    case "user-input.requested":
      if (!Array.isArray(payload.questions) || payload.questions.length > 100) {
        throw new McpBridgeProtocolError(
          "user-input.requested payload.questions must be an array containing at most 100 entries.",
        );
      }
      return payload;
    case "user-input.resolved":
      record(payload.answers ?? payload.response, "event.payload.answers");
      return payload;
    case "message.delivered":
      nonEmptyString(payload.messageId, "event.payload.messageId", 512);
      return payload;
    case "runtime.warning":
      nonEmptyString(payload.message, "event.payload.message", 100_000);
      return payload;
    case "runtime.error":
      if (
        optionalBoundedString(payload.message, "event.payload.message", 100_000) === undefined &&
        optionalBoundedString(payload.error, "event.payload.error", 100_000) === undefined
      ) {
        throw new McpBridgeProtocolError(
          "runtime.error requires payload.message or payload.error.",
        );
      }
      return payload;
    case "session.started":
    case "session.stopped":
    case "turn.started":
    case "turn.completed":
    case "turn.interrupted":
      optionalBoundedString(payload.model, "event.payload.model", 256);
      optionalBoundedString(payload.finishReason, "event.payload.finishReason", 128);
      return payload;
  }
}

export function assertMcpBridgeProtocolVersion(value: unknown): asserts value is {
  readonly protocolVersion: typeof MCP_BRIDGE_PROTOCOL_VERSION;
} {
  const input = record(value, "bridge response");
  const version = nonEmptyString(input.protocolVersion, "protocolVersion", 128);
  const expectedMajor = MCP_BRIDGE_PROTOCOL_VERSION.split("/").at(-1);
  const receivedMajor = version.split("/").at(-1);
  if (version !== MCP_BRIDGE_PROTOCOL_VERSION) {
    const mismatch =
      receivedMajor !== expectedMajor ? "major-version mismatch" : "version mismatch";
    throw new McpBridgeProtocolError(
      `Provider bridge ${mismatch}: expected ${MCP_BRIDGE_PROTOCOL_VERSION}, received ${version}.`,
    );
  }
}

export function decodeMcpBridgeDescriptor(value: unknown): McpBridgeDescriptor {
  assertMcpBridgeProtocolVersion(value);
  const input = record(value, "provider_bridge.describe response");
  const provider = record(input.provider, "provider");
  const capabilities = record(input.capabilities, "capabilities");
  const limits = record(input.limits ?? {}, "limits");
  const health = record(input.health, "health");
  if (!Array.isArray(input.models) || input.models.length > 256) {
    throw new McpBridgeProtocolError("models must be an array containing at most 256 entries.");
  }
  const models = input.models.map((candidate, index) => {
    const model = record(candidate, `models[${index}]`);
    return {
      id: nonEmptyString(model.id, `models[${index}].id`, 256),
      name: nonEmptyString(model.name, `models[${index}].name`, 256),
      ...(typeof model.provider === "string" && model.provider.trim().length > 0
        ? { provider: model.provider.slice(0, 256) }
        : {}),
    };
  });
  const ids = new Set(models.map((model) => model.id));
  if (ids.size !== models.length) {
    throw new McpBridgeProtocolError("models contains duplicate ids.");
  }
  const defaultModel = nonEmptyString(input.defaultModel, "defaultModel", 256);
  if (!ids.has(defaultModel)) {
    throw new McpBridgeProtocolError("defaultModel must reference a described model.");
  }
  const threadRollback = booleanValue(capabilities.threadRollback, "capabilities.threadRollback");
  const threadFork = booleanValue(capabilities.threadFork, "capabilities.threadFork");
  if (threadRollback || threadFork) {
    throw new McpBridgeProtocolError(
      `${MCP_BRIDGE_PROTOCOL_VERSION} does not define rollback or fork operations; capabilities.threadRollback and capabilities.threadFork must both be false.`,
    );
  }
  return {
    protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
    provider: {
      id: nonEmptyString(provider.id, "provider.id", 256),
      name: nonEmptyString(provider.name, "provider.name", 256),
      version: nonEmptyString(provider.version, "provider.version", 128),
    },
    models,
    defaultModel,
    capabilities: {
      taskStop: booleanValue(capabilities.taskStop, "capabilities.taskStop"),
      textGeneration: booleanValue(capabilities.textGeneration, "capabilities.textGeneration"),
      threadRollback,
      threadFork,
      modelSwitchRequiresNewThread: booleanValue(
        capabilities.modelSwitchRequiresNewThread,
        "capabilities.modelSwitchRequiresNewThread",
      ),
      ...(capabilities.turnSteering === undefined
        ? {}
        : {
            turnSteering: booleanValue(capabilities.turnSteering, "capabilities.turnSteering"),
          }),
    },
    limits: {
      ...(limits.eventRetention === undefined
        ? {}
        : { eventRetention: boundedInteger(limits.eventRetention, "limits.eventRetention") }),
      ...(limits.eventsNextTimeoutMs === undefined
        ? {}
        : {
            eventsNextTimeoutMs: boundedInteger(
              limits.eventsNextTimeoutMs,
              "limits.eventsNextTimeoutMs",
              25_000,
            ),
          }),
      ...(limits.maxEventsPerPoll === undefined
        ? {}
        : {
            maxEventsPerPoll: boundedInteger(
              limits.maxEventsPerPoll,
              "limits.maxEventsPerPoll",
              10_000,
            ),
          }),
    },
    health: {
      ...health,
      status: nonEmptyString(health.status, "health.status", 128),
      ...(health.detail === null || typeof health.detail === "string"
        ? { detail: health.detail as string | null }
        : {}),
    },
  };
}

export function decodeMcpBridgeEvent(value: unknown): McpBridgeEvent {
  const input = record(value, "provider bridge event");
  const type = nonEmptyString(input.type, "event.type", 128);
  if (!(MCP_BRIDGE_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new McpBridgeProtocolError(`Unsupported provider bridge event type: ${type}.`);
  }
  const timestamp = nonEmptyString(input.timestamp, "event.timestamp", 128);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new McpBridgeProtocolError("event.timestamp must be an ISO-compatible timestamp.");
  }
  const sequence = boundedInteger(input.sequence, "event.sequence");
  if (sequence === 0) {
    throw new McpBridgeProtocolError("event.sequence must be greater than zero.");
  }
  const payload = validateEventPayload(
    type as McpBridgeEventType,
    record(input.payload ?? {}, "event.payload"),
  );
  return {
    eventId: nonEmptyString(input.eventId, "event.eventId", 256),
    sequence,
    timestamp,
    sessionId: nonEmptyString(input.sessionId, "event.sessionId", 256),
    ...(input.turnId === undefined
      ? {}
      : { turnId: nonEmptyString(input.turnId, "event.turnId", 256) }),
    ...(input.itemId === undefined
      ? {}
      : { itemId: nonEmptyString(input.itemId, "event.itemId", 256) }),
    ...(input.requestId === undefined
      ? {}
      : { requestId: nonEmptyString(input.requestId, "event.requestId", 256) }),
    type: type as McpBridgeEventType,
    payload,
  };
}

export function decodeMcpBridgeEventsPage(value: unknown): McpBridgeEventsPage {
  assertMcpBridgeProtocolVersion(value);
  const input = record(value, "provider_bridge.events_next response");
  if (!Array.isArray(input.events) || input.events.length > 200) {
    throw new McpBridgeProtocolError("events must be an array containing at most 200 entries.");
  }
  const events = input.events.map(decodeMcpBridgeEvent);
  const sessionId = nonEmptyString(input.sessionId, "sessionId", 256);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence !== events[index - 1]!.sequence + 1) {
      throw new McpBridgeProtocolError(
        "events must be contiguous and strictly ordered by sequence.",
      );
    }
  }
  if (events.some((event) => event.sessionId !== sessionId)) {
    throw new McpBridgeProtocolError("events must match the enclosing sessionId.");
  }
  const gap = booleanValue(input.gap, "gap");
  if (gap && events.length > 0) {
    throw new McpBridgeProtocolError("a cursor-gap page must not contain events.");
  }
  const nextSequence = boundedInteger(input.nextSequence, "nextSequence");
  const lastSequence = events.at(-1)?.sequence;
  if (lastSequence !== undefined && nextSequence !== lastSequence) {
    throw new McpBridgeProtocolError("nextSequence must equal the final returned event sequence.");
  }
  if (gap && input.oldestSequence === undefined) {
    throw new McpBridgeProtocolError("a cursor-gap page must include oldestSequence.");
  }
  if (!gap && input.oldestSequence !== undefined) {
    throw new McpBridgeProtocolError("oldestSequence is only valid on a cursor-gap page.");
  }
  const oldestSequence =
    input.oldestSequence === undefined
      ? undefined
      : boundedInteger(input.oldestSequence, "oldestSequence");
  if (gap && oldestSequence === 0) {
    throw new McpBridgeProtocolError("oldestSequence must be greater than zero.");
  }
  if (gap && oldestSequence !== undefined && nextSequence < oldestSequence - 1) {
    throw new McpBridgeProtocolError("nextSequence must not precede the retained event window.");
  }
  return {
    protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
    sessionId,
    gap,
    ...(oldestSequence === undefined ? {} : { oldestSequence }),
    nextSequence,
    events,
  };
}

/** One literal argv entry per non-empty line; no trimming or shell parsing. */
export function parseMcpBridgeArguments(value: string): string[] {
  return value.split(/\r?\n/u).filter((line) => line.length > 0);
}

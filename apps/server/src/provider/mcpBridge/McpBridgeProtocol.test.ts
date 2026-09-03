import { describe, expect, it } from "vite-plus/test";

import {
  MCP_BRIDGE_PROTOCOL_VERSION,
  McpBridgeProtocolError,
  decodeMcpBridgeDescriptor,
  decodeMcpBridgeEventsPage,
  parseMcpBridgeArguments,
} from "./McpBridgeProtocol.ts";

const descriptor = {
  protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
  provider: { id: "test", name: "Test Bridge", version: "1.2.3" },
  models: [{ id: "model-a", name: "Model A" }],
  defaultModel: "model-a",
  capabilities: {
    taskStop: true,
    textGeneration: false,
    threadRollback: false,
    threadFork: false,
    modelSwitchRequiresNewThread: true,
    turnSteering: true,
  },
  limits: { eventsNextTimeoutMs: 25000 },
  health: { status: "ready" },
};

describe("solla.provider-bridge/1 validation", () => {
  it("accepts a valid descriptor and rejects version or model inconsistencies", () => {
    const decoded = decodeMcpBridgeDescriptor(descriptor);
    expect(decoded.provider.name).toBe("Test Bridge");
    expect(decoded.capabilities.turnSteering).toBe(true);
    expect(() =>
      decodeMcpBridgeDescriptor({ ...descriptor, protocolVersion: "solla.provider-bridge/2" }),
    ).toThrow(/major-version mismatch/u);
    expect(() => decodeMcpBridgeDescriptor({ ...descriptor, defaultModel: "missing" })).toThrow(
      /defaultModel/u,
    );
    expect(() =>
      decodeMcpBridgeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, threadRollback: true },
      }),
    ).toThrow(/does not define rollback or fork operations/u);
    expect(() =>
      decodeMcpBridgeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, threadFork: true },
      }),
    ).toThrow(/does not define rollback or fork operations/u);
    expect(() =>
      decodeMcpBridgeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, turnSteering: "yes" },
      }),
    ).toThrow(/capabilities.turnSteering must be a boolean/u);
  });

  it("preserves one literal argument per non-empty line", () => {
    expect(parseMcpBridgeArguments("--flag\nvalue with spaces\n*literal*\n\n")).toEqual([
      "--flag",
      "value with spaces",
      "*literal*",
    ]);
  });

  it("validates event ordering, explicit sessions, and the 25 second poll bound", () => {
    const first = {
      eventId: "event-a",
      sequence: 1,
      timestamp: "2026-08-13T12:00:00.000Z",
      sessionId: "session-a",
      type: "turn.started",
      payload: { model: "model-a" },
    };
    expect(
      decodeMcpBridgeEventsPage({
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        sessionId: "session-a",
        gap: false,
        nextSequence: 1,
        events: [first],
      }).events,
    ).toHaveLength(1);
    expect(() =>
      decodeMcpBridgeEventsPage({
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        sessionId: "session-a",
        gap: false,
        nextSequence: 1,
        events: [first, { ...first, eventId: "event-b" }],
      }),
    ).toThrow(/contiguous and strictly ordered/u);
    expect(() =>
      decodeMcpBridgeEventsPage({
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        sessionId: "session-a",
        gap: false,
        nextSequence: 3,
        events: [first, { ...first, eventId: "event-c", sequence: 3 }],
      }),
    ).toThrow(/contiguous/u);
    expect(() =>
      decodeMcpBridgeEventsPage({
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        sessionId: "session-b",
        gap: false,
        nextSequence: 1,
        events: [first],
      }),
    ).toThrow(/enclosing sessionId/u);
    expect(() =>
      decodeMcpBridgeEventsPage({
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        sessionId: "session-a",
        gap: true,
        oldestSequence: 20,
        nextSequence: 20,
        events: [first],
      }),
    ).toThrow(/cursor-gap/u);
    expect(() =>
      decodeMcpBridgeDescriptor({
        ...descriptor,
        limits: { eventsNextTimeoutMs: 25001 },
      }),
    ).toThrow(McpBridgeProtocolError);
  });

  it("rejects malformed or unbounded typed event payloads", () => {
    const base = {
      eventId: "event-content",
      sequence: 1,
      timestamp: "2026-08-13T12:00:00.000Z",
      sessionId: "session-a",
      type: "content.delta",
    };
    expect(() =>
      decodeMcpBridgeEventsPage({
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        sessionId: "session-a",
        gap: false,
        nextSequence: 1,
        events: [{ ...base, payload: { text: 42 } }],
      }),
    ).toThrow(/payload.text must be a string/u);
    expect(() =>
      decodeMcpBridgeEventsPage({
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        sessionId: "session-a",
        gap: false,
        nextSequence: 1,
        events: [{ ...base, sequence: 0, payload: { text: "answer" } }],
      }),
    ).toThrow(/greater than zero/u);
  });

  it("reduces an oversized payload instead of failing the whole stream", () => {
    const base = {
      eventId: "event-content",
      sequence: 1,
      timestamp: "2026-08-13T12:00:00.000Z",
      sessionId: "session-a",
      type: "content.delta",
    };
    // One refused event used to poison every later poll of the session:
    // the pump re-read the same sequence, failed again, and the thread
    // filled with "event stream interrupted" rows until the app relaunched.
    const page = decodeMcpBridgeEventsPage({
      protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
      sessionId: "session-a",
      gap: false,
      nextSequence: 1,
      events: [
        {
          ...base,
          type: "item.completed",
          itemId: "call_1",
          payload: {
            kind: "tool_result",
            name: "preview_snapshot",
            result: { ok: true, value: "x".repeat(2 * 1024 * 1024 + 1) },
          },
        },
      ],
    });
    const payload = page.events[0]!.payload as {
      kind: string;
      name: string;
      result: { ok: boolean; truncated: boolean; value: string };
    };
    expect(payload.kind).toBe("tool_result");
    expect(payload.name).toBe("preview_snapshot");
    expect(payload.result.truncated).toBe(true);
    expect(payload.result.value).toMatch(/exceeded the 2097152 character limit/u);
    expect(JSON.stringify(payload).length).toBeLessThan(4_096);

    const delta = decodeMcpBridgeEventsPage({
      protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
      sessionId: "session-a",
      gap: false,
      nextSequence: 1,
      events: [{ ...base, payload: { text: "x".repeat(2 * 1024 * 1024 + 1) } }],
    });
    expect((delta.events[0]!.payload as { text: string }).text).toMatch(/reduced by the host/u);
  });

  it("rejects impossible cursor windows", () => {
    expect(() =>
      decodeMcpBridgeEventsPage({
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        sessionId: "session-a",
        gap: false,
        oldestSequence: 1,
        nextSequence: 0,
        events: [],
      }),
    ).toThrow(McpBridgeProtocolError);
    expect(() =>
      decodeMcpBridgeEventsPage({
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        sessionId: "session-a",
        gap: true,
        oldestSequence: 0,
        nextSequence: 0,
        events: [],
      }),
    ).toThrow(McpBridgeProtocolError);
    expect(() =>
      decodeMcpBridgeEventsPage({
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        sessionId: "session-a",
        gap: true,
        oldestSequence: 50,
        nextSequence: 12,
        events: [],
      }),
    ).toThrow(McpBridgeProtocolError);
  });
});

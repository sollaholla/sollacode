#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const protocolVersion = process.env.FAKE_BRIDGE_PROTOCOL_VERSION ?? "solla.provider-bridge/1";
const marker = process.env.FAKE_BRIDGE_MARKER;
const crashMarker = process.env.FAKE_BRIDGE_CRASH_ONCE_MARKER;
if (crashMarker && !NodeFS.existsSync(crashMarker)) {
  NodeFS.writeFileSync(crashMarker, "crashed\n");
  process.stderr.write("intentional fake bridge crash\n");
  process.exit(17);
}

if (process.env.FAKE_BRIDGE_STDERR) {
  process.stderr.write(process.env.FAKE_BRIDGE_STDERR);
}
if (process.env.FAKE_BRIDGE_KEEP_ALIVE === "1") {
  setInterval(() => {}, 60_000);
}

const toolNames = [
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
];

const write = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const toolResult = (value, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  isError,
});

const descriptor = () => ({
  protocolVersion,
  provider: { id: "fake-bridge", name: "Fake Provider Bridge", version: "9.8.7" },
  models: [
    { id: "fake-default", name: "Fake Default" },
    { id: "fake-secondary", name: "Fake Secondary" },
  ],
  defaultModel: "fake-default",
  capabilities: {
    taskStop: true,
    textGeneration: true,
    threadRollback: false,
    threadFork: false,
    modelSwitchRequiresNewThread: true,
    turnSteering: true,
  },
  limits: { eventRetention: 100, eventsNextTimeoutMs: 25000, maxEventsPerPoll: 100 },
  health: {
    status: "ready",
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    forwardedEnvironment: process.env.FAKE_BRIDGE_FORWARDED_ENV ?? null,
  },
});

const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!("id" in message)) return;
  const { id, method } = message;
  if (method === "initialize") {
    write(id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "fake-provider-bridge", version: "1.0.0" },
    });
    return;
  }
  if (method === "ping") {
    write(id, {});
    return;
  }
  if (method === "tools/list") {
    write(id, {
      tools: toolNames.map((name) => ({ name, inputSchema: { type: "object" } })),
    });
    return;
  }
  if (method !== "tools/call") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "not found" } })}\n`,
    );
    return;
  }
  const name = message.params?.name;
  if (name === process.env.FAKE_BRIDGE_EXIT_TOOL) {
    const exitMarker = process.env.FAKE_BRIDGE_EXIT_ONCE_MARKER;
    if (!exitMarker || !NodeFS.existsSync(exitMarker)) {
      if (exitMarker) NodeFS.writeFileSync(exitMarker, "exited\n");
      process.exit(23);
    }
  }
  if (name === process.env.FAKE_BRIDGE_RPC_ERROR_TOOL) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "intentional tool error" } })}\n`,
    );
    return;
  }
  if (name === "provider_bridge.describe") {
    write(id, toolResult(descriptor()));
    return;
  }
  if (name === "provider_bridge.shutdown") {
    if (marker) NodeFS.writeFileSync(marker, "shutdown\n");
    write(id, toolResult({ protocolVersion, shutdown: true }));
    return;
  }
  if (name === "provider_bridge.turn_steer") {
    write(
      id,
      toolResult({
        protocolVersion,
        sessionId: String(message.params?.arguments?.sessionId ?? ""),
        turnId: String(message.params?.arguments?.expectedTurnId ?? ""),
        accepted: true,
      }),
    );
    return;
  }
  if (name === process.env.FAKE_BRIDGE_MALFORMED_TOOL) {
    write(id, toolResult({ protocolVersion: "solla.provider-bridge/99" }));
    return;
  }
  write(
    id,
    toolResult({
      protocolVersion,
      ...(message.params?.arguments ?? {}),
    }),
  );
});

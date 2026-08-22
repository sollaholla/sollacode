// @effect-diagnostics nodeBuiltinImport:off
import * as NodeTimersPromises from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  MCP_BRIDGE_PROTOCOL_VERSION,
  MCP_BRIDGE_TOOL_NAMES,
  type McpBridgeToolName,
  assertMcpBridgeProtocolVersion,
  decodeMcpBridgeDescriptor,
  type McpBridgeDescriptor,
} from "./McpBridgeProtocol.ts";
import * as DateTime from "effect/DateTime";

const STDERR_LIMIT = 32 * 1024;
const MAX_RESTART_BACKOFF_MS = 4_000;

export interface McpBridgeConnectionOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly sensitiveValues?: ReadonlyArray<string> | undefined;
}

export interface McpBridgeClient {
  readonly descriptor: McpBridgeDescriptor | null;
  readonly pid: number | null;
  readonly stderr: string;
  call(
    tool: McpBridgeToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  describe(): Promise<McpBridgeDescriptor>;
  shutdown(): Promise<void>;
}

export class McpBridgeRemoteToolError extends Error {
  override readonly name = "McpBridgeRemoteToolError";
}

/**
 * The stdio child was replaced, timed out, or could not be initialized. The
 * conversation on the other side of the bridge is unaffected by any of those:
 * external bridges persist their sessions across stdio replacement, so a
 * reconnect resumes the same turn from the same event cursor. Callers use this
 * class to tell "the pipe broke, poll again" apart from "the request itself
 * was answered with a failure", which is the difference between waiting out a
 * reconnect and killing a turn the browser is still working on.
 */
export class McpBridgeTransportError extends Error {
  override readonly name = "McpBridgeTransportError";
}

/** True when `cause`, or anything it wraps, is a bridge transport failure. */
export function isMcpBridgeTransportCause(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof McpBridgeTransportError) return true;
    if (isTransportFailure(current)) return true;
    if (!(current instanceof Error)) return false;
    current = (current as { readonly cause?: unknown }).cause;
    if (current === undefined || current === null) return false;
  }
  return false;
}

function processEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function errorDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return String(cause);
}

function isTransportFailure(cause: unknown): boolean {
  return (
    (cause instanceof McpError &&
      (cause.code === ErrorCode.ConnectionClosed ||
        cause.code === ErrorCode.RequestTimeout ||
        cause.code === ErrorCode.ParseError)) ||
    // StdioClientTransport.send() throws this plain Error when its child has
    // already closed. It is not wrapped as McpError, so omitting this exact
    // transport diagnostic leaves a dead Client cached forever.
    (cause instanceof Error && cause.message === "Not connected")
  );
}

export class McpBridgeConnection {
  private readonly options: McpBridgeConnectionOptions;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connecting: Promise<Client> | null = null;
  private stopped = false;
  private failureCount = 0;
  private nextConnectAt = 0;
  private stderrBuffer = "";
  private descriptorValue: McpBridgeDescriptor | null = null;

  constructor(options: McpBridgeConnectionOptions) {
    this.options = options;
  }

  get pid(): number | null {
    return this.transport?.pid ?? null;
  }

  get stderr(): string {
    let value = this.stderrBuffer;
    for (const sensitive of this.options.sensitiveValues ?? []) {
      if (sensitive.length >= 4) value = value.split(sensitive).join("[REDACTED]");
    }
    return value;
  }

  get descriptor(): McpBridgeDescriptor | null {
    return this.descriptorValue;
  }

  private appendStderr(chunk: unknown): void {
    const next = this.stderrBuffer + String(chunk);
    this.stderrBuffer = next.slice(Math.max(0, next.length - STDERR_LIMIT));
  }

  private async closeCurrent(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (client) {
      await client.close().catch(() => undefined);
    } else if (transport) {
      await transport.close().catch(() => undefined);
    }
  }

  private async retire(client: Client): Promise<void> {
    if (this.client !== client) return;
    await this.closeCurrent();
    this.markFailure();
  }

  private markFailure(): void {
    this.failureCount += 1;
    const backoff = Math.min(MAX_RESTART_BACKOFF_MS, 250 * 2 ** (this.failureCount - 1));
    this.nextConnectAt = DateTime.toEpochMillis(DateTime.nowUnsafe()) + backoff;
  }

  private async makeConnection(): Promise<Client> {
    if (this.stopped) throw new Error("MCP provider bridge connection is closed.");
    const waitMs = Math.max(0, this.nextConnectAt - DateTime.toEpochMillis(DateTime.nowUnsafe()));
    if (waitMs > 0) await NodeTimersPromises.setTimeout(waitMs);

    const parameters: StdioServerParameters = {
      command: this.options.command,
      args: [...this.options.args],
      env: processEnvironment(this.options.env),
      stderr: "pipe",
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    };
    const transport = new StdioClientTransport(parameters);
    transport.stderr?.on("data", (chunk) => this.appendStderr(chunk));
    const client = new Client({ name: "solla-code-provider-bridge", version: "1.0.0" });
    let transportClosed = false;
    client.onclose = () => {
      transportClosed = true;
      // Client.close() is also reported through onclose. closeCurrent clears
      // these identities first, so only an unexpected close retires the live
      // connection and schedules bounded reconnect backoff.
      if (this.client !== client || this.transport !== transport) return;
      this.client = null;
      this.transport = null;
      this.markFailure();
    };
    try {
      await client.connect(transport);
      const listed = await client.listTools(undefined, { timeout: 10_000 });
      const available = new Set(listed.tools.map((tool) => tool.name));
      const missing = MCP_BRIDGE_TOOL_NAMES.filter((tool) => !available.has(tool));
      if (missing.length > 0) {
        throw new Error(`External bridge is missing required MCP tools: ${missing.join(", ")}.`);
      }
      if (this.stopped || transportClosed) {
        await client.close().catch(() => undefined);
        throw new Error(
          this.stopped
            ? "MCP provider bridge connection closed during initialization."
            : "MCP provider bridge process exited during initialization.",
        );
      }
      this.client = client;
      this.transport = transport;
      return client;
    } catch (cause) {
      await client.close().catch(() => transport.close().catch(() => undefined));
      this.markFailure();
      const stderr = this.stderr.trim();
      // A child that cannot be started right now is still a transport
      // condition: the host respawns bridges routinely, and the window where
      // the old process has exited but the new one is not yet accepting stdio
      // is exactly when a poll lands here.
      throw new McpBridgeTransportError(
        `Failed to initialize external MCP provider bridge: ${errorDetail(cause)}${
          stderr ? `\nBridge stderr:\n${stderr}` : ""
        }`,
        { cause },
      );
    }
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.makeConnection().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async call(
    tool: McpBridgeToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const client = await this.ensureConnected();
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await client.callTool({ name: tool, arguments: { ...argumentsValue } }, undefined, {
        timeout: timeoutMs,
      });
    } catch (cause) {
      // JSON-RPC application errors do not prove the child failed. Cycle the
      // instance-owned transport only for SDK transport/timeout/framing
      // failures; the next operation then reconnects after bounded backoff.
      const transport = isTransportFailure(cause);
      if (transport) await this.retire(client);
      const message = `${tool} request failed: ${errorDetail(cause)}${
        this.stderr.trim() ? `\nBridge stderr:\n${this.stderr.trim()}` : ""
      }`;
      throw transport
        ? new McpBridgeTransportError(message, { cause })
        : new Error(message, { cause });
    }

    const callResult = result as {
      readonly isError?: boolean;
      readonly structuredContent?: Record<string, unknown>;
      readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
    };
    const structured =
      callResult.structuredContent ??
      (() => {
        const text = callResult.content?.find((item) => item.type === "text")?.text;
        if (!text) throw new Error(`${tool} returned neither structuredContent nor JSON text.`);
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`${tool} returned a non-object JSON payload.`);
        }
        return parsed as Record<string, unknown>;
      })();
    if (callResult.isError === true) {
      const message = typeof structured.error === "string" ? structured.error : `${tool} failed.`;
      throw new McpBridgeRemoteToolError(message);
    }
    // Contract errors are application failures, not evidence that the stdio
    // process died. Report them without cycling a still-live owned child.
    if (tool !== "provider_bridge.describe") assertMcpBridgeProtocolVersion(structured);
    // A transport is not proven healthy merely because initialization and
    // tools/list completed. Reset crash backoff only after an application
    // request succeeds; otherwise a child that repeatedly exits during its
    // first tool call would reconnect forever at the shortest delay.
    this.failureCount = 0;
    this.nextConnectAt = 0;
    return structured;
  }

  async describe(): Promise<McpBridgeDescriptor> {
    const descriptor = decodeMcpBridgeDescriptor(
      await this.call(
        "provider_bridge.describe",
        { protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION },
        15_000,
      ),
    );
    this.descriptorValue = descriptor;
    return descriptor;
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Initialization owns the child as soon as StdioClientTransport starts it.
    // Wait for that in-flight path to either publish the client or close the
    // child after observing `stopped`, so shutdown cannot orphan a late spawn.
    const connecting = this.connecting;
    if (connecting) await connecting.catch(() => undefined);
    const client = this.client;
    if (client) {
      await this.call(
        "provider_bridge.shutdown",
        { protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION },
        8_000,
      ).catch(() => undefined);
    }
    await this.closeCurrent();
  }
}

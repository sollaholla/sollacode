// @effect-diagnostics nodeBuiltinImport:off
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createMcpShellBridge } from "../../mcp/McpShellBridge.ts";
import * as NodeHttp from "node:http";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { makeMuseAdapter } from "./MuseAdapter.ts";

/**
 * Drives the real `muse serve` host end to end.
 *
 * Opt-in through T3_LIVE_MUSE because it needs the CLI installed. It runs
 * against Muse's built-in `echo` provider, which completes a turn without
 * calling a model. T3_LIVE_MUSE_MODEL=1 additionally enables a real model
 * MCP connection probe, which uses account quota.
 */
const museBinary = NodePath.join(NodeOS.homedir(), ".local", "bin", "muse");
const enabled = process.env["T3_LIVE_MUSE"] === "1" && NodeFS.existsSync(museBinary);

describe.skipIf(!enabled)("Muse adapter against the real CLI", () => {
  describe.skipIf(process.env["T3_LIVE_MUSE_MODEL"] !== "1")("paid model MCP probe", () => {
    it.live(
      "calls authenticated host MCP tools from the real Muse model",
      () =>
        Effect.gen(function* () {
          const discovered = yield* Deferred.make<void>();
          const methods: string[] = [];
          const headers: Array<string | undefined> = [];
          const toolCalls: unknown[] = [];
          const server = yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const server = NodeHttp.createServer(async (request, response) => {
                if (request.method !== "POST") {
                  response.writeHead(405).end();
                  return;
                }
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const message = JSON.parse(Buffer.concat(chunks).toString()) as {
                  id?: string | number;
                  method: string;
                  params?: unknown;
                };
                methods.push(message.method);
                headers.push(request.headers.authorization);
                if (message.id === undefined) {
                  response.writeHead(202).end();
                  return;
                }
                const result =
                  message.method === "initialize"
                    ? {
                        protocolVersion: "2025-03-26",
                        capabilities: { tools: {} },
                        serverInfo: { name: "solla-mcp-test", version: "1" },
                      }
                    : message.method === "tools/call"
                      ? { content: [{ type: "text", text: "SOLLA_MCP_HISTORY_VERIFIED" }] }
                      : message.method === "tools/list"
                        ? {
                            tools: [
                              {
                                name: "thread_history_query",
                                description: "Read this thread's persisted history",
                                inputSchema: { type: "object", properties: {} },
                              },
                            ],
                          }
                        : {};
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
                if (message.method === "tools/call") {
                  toolCalls.push(message.params);
                  Deferred.doneUnsafe(discovered, Effect.void);
                }
              });
              await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
              return server;
            }),
            (server) =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                  }),
              ),
          );
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected TCP address");
          const threadId = ThreadId.make("muse-live-mcp-thread");
          const mcpConfig = {
            environmentId: EnvironmentId.make("muse-live-env"),
            threadId,
            providerInstanceId: ProviderInstanceId.make("muse-live"),
            providerSessionId: "mcp-test",
            endpoint: `http://127.0.0.1:${address.port}/mcp`,
            authorizationHeader: "Bearer isolated-test",
          };
          const tempDir = yield* Effect.acquireRelease(
            Effect.promise(() =>
              import("node:fs/promises").then((fs) =>
                fs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-mcp-live-")),
              ),
            ),
            (dir) =>
              Effect.promise(() =>
                import("node:fs/promises").then((fs) =>
                  fs.rm(dir, { recursive: true, force: true }),
                ),
              ),
          );
          const platform = yield* HostProcessPlatform;
          const instructions = yield* Effect.promise(() =>
            createMcpShellBridge(mcpConfig, tempDir, platform),
          );
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              McpProviderSession.setMcpProviderSession({
                ...mcpConfig,
                shellBridgeInstructions: instructions,
              }),
            ),
            () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
          );
          const adapter = yield* makeMuseAdapter({
            instanceId: ProviderInstanceId.make("muse-live"),
            binaryPath: museBinary,
            cwd: process.cwd(),
            environment: process.env as NodeJS.ProcessEnv,
          });
          yield* adapter.startSession({ threadId, runtimeMode: "auto" });
          yield* adapter.sendTurn({
            threadId,
            input: `Validate only the host-tool connection. Use your shell tool to run the provided client call thread_history_query '{}', then respond only with the returned test marker. Do not inspect or change workspace files.\n${instructions}`,
          });
          yield* Deferred.await(discovered).pipe(Effect.timeout("90 seconds"));
          expect(methods).toContain("initialize");
          expect(methods).toContain("tools/call");
          expect(toolCalls).toContainEqual({ name: "thread_history_query", arguments: {} });
          expect(headers.every((header) => header === "Bearer isolated-test")).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      120_000,
    );
  });
  it.live(
    "starts a session and completes a turn end to end",
    () =>
      Effect.gen(function* () {
        const adapter = yield* makeMuseAdapter({
          instanceId: ProviderInstanceId.make("muse-live"),
          binaryPath: museBinary,
          cwd: process.cwd(),
          providerId: "echo",
          environment: process.env as NodeJS.ProcessEnv,
        });
        const threadId = ThreadId.make("muse-live-thread");
        const events: ProviderRuntimeEvent[] = [];
        const completed = yield* Deferred.make<void>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "turn.completed" || event.type === "turn.aborted") {
                yield* Deferred.succeed(completed, undefined);
              }
            }),
          ),
          Effect.forkScoped,
        );
        // Signed out, the host answers with an empty catalog. That is reported
        // as empty rather than back-filled with guessed slugs.
        const models = yield* adapter.listModels();
        expect(Array.isArray(models)).toBe(true);

        const session = yield* adapter.startSession({ threadId, runtimeMode: "auto" });
        expect(session.resumeCursor).toBeDefined();
        yield* adapter.sendTurn({ threadId, input: "hello from solla" });
        yield* Deferred.await(completed).pipe(Effect.timeout("60 seconds"));
        expect(events.some((event) => event.type === "turn.started")).toBe(true);
        expect(events.some((event) => event.type === "turn.completed")).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );
});

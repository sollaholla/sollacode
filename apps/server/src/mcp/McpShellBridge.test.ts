// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { appendMcpShellBridgeInstructions } from "./McpProviderSession.ts";
import { describe, expect, it } from "vite-plus/test";
import { createMcpShellBridge, removeMcpShellBridge } from "./McpShellBridge.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
describe("provider-independent MCP shell bridge", () => {
  it("preserves native slash commands and annotates ordinary prompts", () => {
    for (const input of [undefined, "/compact", "/model opus", "/mcp list"])
      expect(appendMcpShellBridgeInstructions(input, "host tools")).toBe(input);
    expect(
      appendMcpShellBridgeInstructions("/Users/example/file.ts needs a fix", "host tools"),
    ).toContain("host tools");
    expect(appendMcpShellBridgeInstructions("Read history", "host tools")).toBe(
      "Read history\n\nhost tools",
    );
  });
  it("discovers and calls tools with each thread's own credential without exposing it in prompts", async () => {
    const calls: Array<{ authorization: string | undefined; method: string }> = [];
    const server = NodeHttp.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        method: string;
        id?: number;
      };
      calls.push({ authorization: request.headers.authorization, method: message.method });
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "thread_history_query",
                    description: "Read history",
                    inputSchema: { type: "object" },
                  },
                ],
              }
            : {
                content: [
                  {
                    type: "text",
                    text:
                      request.headers.authorization === "Bearer first-thread"
                        ? "first history"
                        : "second history",
                  },
                ],
              };
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-mcp-bridge-test-"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      for (const thread of ["first", "second"]) {
        const config = {
          environmentId: EnvironmentId.make("test"),
          threadId: ThreadId.make(thread),
          providerInstanceId: ProviderInstanceId.make("new-provider"),
          providerSessionId: thread,
          endpoint: `http://127.0.0.1:${address.port}/mcp`,
          authorizationHeader: `Bearer ${thread}-thread`,
        };
        const instructions = await createMcpShellBridge(config, dir, "linux");
        expect(instructions).not.toContain(`Bearer ${thread}-thread`);
        expect(instructions).toContain("describe thread_history_query");
        const file = NodePath.join(dir, "mcp-tools", `${thread}.cjs`);
        expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
        const list = await exec(process.execPath, [file, "list"]);
        expect(JSON.parse(list.stdout)[0].name).toBe("thread_history_query");
        const result = await exec(process.execPath, [file, "call", "thread_history_query", "{}"]);
        expect(JSON.parse(result.stdout).content[0].text).toBe(`${thread} history`);
        await removeMcpShellBridge(config, dir);
        await expect(NodeFSP.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
        await removeMcpShellBridge(config, dir);
      }
      expect(
        calls.filter((call) => call.method === "tools/call").map((call) => call.authorization),
      ).toEqual(["Bearer first-thread", "Bearer second-thread"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});

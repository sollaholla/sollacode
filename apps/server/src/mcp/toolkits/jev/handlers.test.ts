import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { JevToolkitRegistrationLive } from "../../McpHttpServer.ts";

afterEach(() => vi.unstubAllGlobals());
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "jev-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const layer = JevToolkitRegistrationLive.pipe(Layer.provideMerge(McpServer.McpServer.layer));

it.effect("registers Jev and returns its decisions as structured MCP content", () =>
  Effect.gen(function* () {
    const expected = {
      model: "jev-1.13-free",
      answers: { passed: { type: "noul", noul: 0.98 } },
      usage: { input_tokens: 100, output_tokens: 20 },
      cost: "0",
    };
    const request = vi.fn(async () => Response.json(expected));
    vi.stubGlobal("fetch", request);
    const server = yield* McpServer.McpServer;
    const tool = server.tools.find((entry) => entry.tool.name === "jev_decide");
    expect(tool?.tool.inputSchema.type).toBe("object");
    expect(tool?.tool.annotations?.openWorldHint).toBe(true);
    const result = yield* server.callTool({
      name: "jev_decide",
      arguments: {
        state: "Tests passed",
        questions: { passed: { type: "noul", instructions: "Did tests pass?" } },
      },
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(expected);
    expect(request).toHaveBeenCalledTimes(1);
    const invalid = yield* server.callTool({
      name: "jev_decide",
      arguments: { state: "test", questions: {} },
    });
    expect(invalid.isError).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.provide(layer)),
);

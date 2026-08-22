import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect } from "vite-plus/test";

import type { McpBridgeClient } from "../provider/mcpBridge/McpBridgeConnection.ts";
import {
  MCP_BRIDGE_PROTOCOL_VERSION,
  type McpBridgeDescriptor,
  type McpBridgeToolName,
} from "../provider/mcpBridge/McpBridgeProtocol.ts";
import { makeMcpBridgeTextGeneration } from "./McpBridgeTextGeneration.ts";

const descriptor: McpBridgeDescriptor = {
  protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
  provider: { id: "text-bridge", name: "Text Bridge", version: "1.2.3" },
  models: [{ id: "browser-model", name: "Browser Model" }],
  defaultModel: "browser-model",
  capabilities: {
    taskStop: true,
    textGeneration: true,
    threadRollback: false,
    threadFork: false,
    modelSwitchRequiresNewThread: true,
  },
  limits: {},
  health: { status: "ready" },
};

class FakeTextBridgeClient implements McpBridgeClient {
  readonly descriptor: McpBridgeDescriptor | null;
  readonly pid = 123;
  readonly stderr = "";
  readonly calls: Array<{
    readonly tool: McpBridgeToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly timeoutMs?: number;
  }> = [];

  constructor(descriptorValue: McpBridgeDescriptor | null = descriptor) {
    this.descriptor = descriptorValue;
  }

  async describe(): Promise<McpBridgeDescriptor> {
    if (!this.descriptor) throw new Error("descriptor unavailable");
    return this.descriptor;
  }

  async call(
    tool: McpBridgeToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ tool, arguments: argumentsValue, ...(timeoutMs ? { timeoutMs } : {}) });
    return {
      protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
      text: 'prefix {"title":"  External bridge title  "} suffix',
    };
  }

  async shutdown(): Promise<void> {}
}

describe("McpBridgeTextGeneration", () => {
  it.effect("generates and validates structured text through the external bridge", () =>
    Effect.gen(function* () {
      const connection = new FakeTextBridgeClient();
      const textGeneration = makeMcpBridgeTextGeneration(connection);
      const instanceId = ProviderInstanceId.make("external_text_bridge");

      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/tmp/external-workspace",
        message: "Implement the bridge",
        modelSelection: { instanceId, model: "browser-model" },
      });

      expect(result).toEqual({ title: "External bridge title" });
      expect(connection.calls).toHaveLength(1);
      expect(connection.calls[0]).toMatchObject({
        tool: "provider_bridge.generate_text",
        arguments: {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          model: "browser-model",
          workspace: "/tmp/external-workspace",
          timeoutSeconds: 180,
          maxChars: 20_000,
        },
        timeoutMs: 190_000,
      });
      expect(connection.calls[0]?.arguments.prompt).toContain(
        "You write concise thread titles for coding conversations.",
      );
    }),
  );

  it.effect("fails before generation when the bridge capability is disabled", () =>
    Effect.gen(function* () {
      const connection = new FakeTextBridgeClient({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, textGeneration: false },
      });
      const textGeneration = makeMcpBridgeTextGeneration(connection);

      const result = yield* textGeneration
        .generateThreadTitle({
          cwd: "/tmp/external-workspace",
          message: "Name this thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("external_text_bridge"),
            model: "browser-model",
          },
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(connection.calls).toHaveLength(0);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.detail).toContain("does not advertise textGeneration support");
      }
    }),
  );
});

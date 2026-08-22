import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  filterGrokAcpMcpServers,
  resolveGrokAcpBaseModelId,
  resolveGrokAcpSessionModelId,
} from "./GrokAcpSupport.ts";

const t3HttpMcpServer = {
  type: "http",
  name: "t3-code",
  url: "http://127.0.0.1:8787/mcp",
  headers: [{ name: "Authorization", value: "Bearer test" }],
} satisfies EffectAcpSchema.McpServer;

const localStdioMcpServer = {
  name: "local-stdio",
  command: "mcp-server",
  args: [],
  env: [],
} satisfies EffectAcpSchema.McpServer;

const grokModelConfigSessionSetup = {
  sessionId: "session-1",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "grok-build",
      options: [
        { value: "grok-build", name: "Grok Build" },
        { value: "grok-mock-alt", name: "Grok Alt" },
      ],
    },
  ],
} satisfies EffectAcpSchema.NewSessionResponse;

describe("resolveGrokAcpBaseModelId", () => {
  it("normalizes empty and custom Grok model ids", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("   ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("  grok-test-custom-model  ")).toBe("grok-test-custom-model");
  });
});

describe("buildGrokAcpSpawnInput", () => {
  it("preserves a caller-set Grok OAuth referrer", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "/usr/local/bin/grok" }, "/tmp/project", {
      XAI_API_KEY: "secret",
      GROK_OAUTH2_REFERRER: "other-client",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/grok",
      args: ["agent", "stdio"],
      cwd: "/tmp/project",
      env: {
        XAI_API_KEY: "secret",
        GROK_OAUTH2_REFERRER: "other-client",
        GROK_MCP_STARTUP_TIMEOUT_SECS: "8",
        MCP_TIMEOUT: "8000",
      },
    });
  });

  it("inserts the Solla Code referrer when the env is unset", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "/usr/local/bin/grok" }, "/tmp/project", {
      XAI_API_KEY: "secret",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/grok",
      args: ["agent", "stdio"],
      cwd: "/tmp/project",
      env: {
        XAI_API_KEY: "secret",
        GROK_OAUTH2_REFERRER: "t3code",
        GROK_MCP_STARTUP_TIMEOUT_SECS: "8",
        MCP_TIMEOUT: "8000",
      },
    });
  });

  it("preserves caller-set MCP startup timeouts", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "grok" }, "/tmp/project", {
      GROK_MCP_STARTUP_TIMEOUT_SECS: "30",
      MCP_TIMEOUT: "30000",
    });

    expect(spawn.env).toMatchObject({
      GROK_MCP_STARTUP_TIMEOUT_SECS: "30",
      MCP_TIMEOUT: "30000",
    });
  });
});

describe("filterGrokAcpMcpServers", () => {
  it("drops HTTP MCP servers when the agent does not advertise http", () => {
    expect(
      filterGrokAcpMcpServers([t3HttpMcpServer], { mcpCapabilities: { http: false } }),
    ).toEqual([]);
  });

  it("drops HTTP MCP servers when mcp capabilities are omitted", () => {
    expect(filterGrokAcpMcpServers([t3HttpMcpServer], {})).toEqual([]);
  });

  it("keeps HTTP MCP servers when the agent advertises http", () => {
    expect(filterGrokAcpMcpServers([t3HttpMcpServer], { mcpCapabilities: { http: true } })).toEqual(
      [t3HttpMcpServer],
    );
  });

  it("keeps stdio MCP servers regardless of http capability", () => {
    expect(
      filterGrokAcpMcpServers([localStdioMcpServer, t3HttpMcpServer], {
        mcpCapabilities: { http: false },
      }),
    ).toEqual([localStdioMcpServer]);
  });
});

const liveGrokSessionSetup = {
  sessionId: "session-1",
  models: {
    currentModelId: "grok-4.6",
    availableModels: [
      { modelId: "grok-4.6", name: "Grok 4.6" },
      { modelId: "grok-4.5", name: "Grok 4.5" },
    ],
  },
} satisfies EffectAcpSchema.NewSessionResponse;

describe("resolveGrokAcpSessionModelId", () => {
  it("maps the Solla grok-build slug to the agent's advertised current model", () => {
    expect(
      resolveGrokAcpSessionModelId({
        requestedModelId: "grok-build",
        currentModelId: "grok-4.6",
        sessionSetupResult: liveGrokSessionSetup,
      }),
    ).toBe("grok-4.6");
  });

  it("keeps an advertised model id unchanged", () => {
    expect(
      resolveGrokAcpSessionModelId({
        requestedModelId: "grok-4.5",
        currentModelId: "grok-4.6",
        sessionSetupResult: liveGrokSessionSetup,
      }),
    ).toBe("grok-4.5");
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const modelMetaCalls: Array<Record<string, unknown> | undefined> = [];
    const configCalls: Array<readonly [string, string | boolean]> = [];
    const runtime = {
      setSessionModel: (modelId: string, meta?: Record<string, unknown>) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          modelMetaCalls.push(meta);
          if (failure) return yield* failure;
          return {};
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.gen(function* () {
          configCalls.push([configId, value]);
          if (failure) return yield* failure;
          return { configOptions: [] };
        }),
    };
    return { runtime, modelCalls, modelMetaCalls, configCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["grok-mock-alt"]);
      expect(configCalls).toEqual([]);
      expect(result.modelId).toBe("grok-mock-alt");
    }),
  );

  it.effect("does not send grok-build to an agent that only advertises grok-4.x ids", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-build",
        sessionSetupResult: liveGrokSessionSetup,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([]);
      expect(result.modelId).toBe("grok-4.6");
    }),
  );

  it.effect("prefers session/set_config_option when a model config option is advertised", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        sessionSetupResult: grokModelConfigSessionSetup,
        mapError: (cause) => cause.message,
      });
      expect(configCalls).toEqual([["model", "grok-mock-alt"]]);
      expect(modelCalls).toEqual([]);
      expect(result.modelId).toBe("grok-mock-alt");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([]);
      expect(result.modelId).toBe("grok-build");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([]);
      expect(result.modelId).toBe("grok-build");
    }),
  );

  it.effect("applies a reasoning effort change through set_model metadata", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, modelMetaCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-4.6",
        currentEffort: "high",
        requestedEffort: "low",
        sessionSetupResult: liveGrokSessionSetup,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["grok-4.6"]);
      expect(modelMetaCalls).toEqual([{ reasoningEffort: "low" }]);
      expect(configCalls).toEqual([]);
      expect(result).toEqual({ modelId: "grok-4.6", reasoningEffort: "low" });
    }),
  );

  it.effect("applies model and effort changes in a single set_model call", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, modelMetaCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-4.5",
        currentEffort: undefined,
        requestedEffort: "medium",
        sessionSetupResult: liveGrokSessionSetup,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["grok-4.5"]);
      expect(modelMetaCalls).toEqual([{ reasoningEffort: "medium" }]);
      expect(result).toEqual({ modelId: "grok-4.5", reasoningEffort: "medium" });
    }),
  );

  it.effect("skips set_model when the requested effort is already applied", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-4.6",
        currentEffort: "low",
        requestedEffort: "low",
        sessionSetupResult: liveGrokSessionSetup,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([]);
      expect(result).toEqual({ modelId: "grok-4.6", reasoningEffort: "low" });
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyGrokAcpModelSelection({
          runtime,
          currentModelId: "grok-build",
          requestedModelId: "grok-mock-alt",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

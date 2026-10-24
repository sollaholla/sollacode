// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  filterGrokAcpMcpServers,
  findGrokStoredSignIn,
  type GrokAuthFileStat,
  isGrokAuthenticateFailure,
  resolveGrokAcpBaseModelId,
  resolveGrokAcpSessionEffort,
  resolveGrokAcpSessionModelId,
  selectGrokAuthMethodId,
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

describe("selectGrokAuthMethodId", () => {
  const advertising = (ids: ReadonlyArray<string>, defaultAuthMethodId: string | null = null) => ({
    authMethods: ids.map((id) => ({ id, name: id })),
    _meta: { defaultAuthMethodId },
  });

  it("sends the method this Grok advertises, not the retired cached_token id", () => {
    // Grok 1.0.41 ran its browser login for the unknown id and ignored
    // `headless`, opening an auth.x.ai tab from every background start.
    expect(selectGrokAuthMethodId(advertising(["grok.com"]), {})).toBe("grok.com");
  });

  it("prefers the advertised default, and keeps an id the CLI still lists", () => {
    expect(selectGrokAuthMethodId(advertising(["device", "grok.com"], "grok.com"), {})).toBe(
      "grok.com",
    );
    expect(selectGrokAuthMethodId(advertising(["cached_token", "grok.com"]), {})).toBe(
      "cached_token",
    );
  });

  it("uses an advertised API-key method when XAI_API_KEY is set", () => {
    expect(
      selectGrokAuthMethodId(advertising(["grok.com", "xai.api-key"]), { XAI_API_KEY: "key" }),
    ).toBe("xai.api-key");
  });

  it("falls back to the old ids when the CLI advertises nothing", () => {
    expect(selectGrokAuthMethodId({ authMethods: [] }, {})).toBe("cached_token");
    expect(selectGrokAuthMethodId({ authMethods: [] }, { XAI_API_KEY: "key" })).toBe("xai.api_key");
  });
});

describe("isGrokAuthenticateFailure", () => {
  it("recognises a refused or abandoned sign-in, and nothing else", () => {
    expect(
      isGrokAuthenticateFailure(
        Cause.fail(
          new EffectAcpErrors.AcpTransportError({
            operation: "call-rpc",
            method: "authenticate",
            detail: "authenticate timed out waiting for RPC response",
            cause: undefined,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isGrokAuthenticateFailure(
        Cause.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32000,
            errorMessage: "Authentication required",
            method: "authenticate",
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isGrokAuthenticateFailure(
        Cause.fail(EffectAcpErrors.AcpRequestError.authRequired("Grok CLI is not signed in.")),
      ),
    ).toBe(true);
    expect(
      isGrokAuthenticateFailure(
        Cause.fail(
          new EffectAcpErrors.AcpTransportError({
            operation: "call-rpc",
            method: "initialize",
            cause: undefined,
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isGrokAuthenticateFailure(
        Cause.fail(EffectAcpErrors.AcpRequestError.internalError("boom", undefined, {})),
      ),
    ).toBe(false);
  });
});

describe("findGrokStoredSignIn", () => {
  const files =
    (entries: Record<string, number>): GrokAuthFileStat =>
    (filePath) =>
      filePath in entries ? { mtimeMs: 7, size: entries[filePath]! } : undefined;
  const homeAuth = NodePath.join("/home/dev", ".grok", "auth.json");

  it("finds the auth.json grok login leaves in the home directory", () => {
    expect(findGrokStoredSignIn({ HOME: "/home/dev" }, files({ [homeAuth]: 120 }))).toBe(
      `${homeAuth}:7:120`,
    );
  });

  it("has nothing to offer a home Grok never signed in from", () => {
    expect(findGrokStoredSignIn({ HOME: "/home/dev" }, files({}))).toBeNull();
    expect(findGrokStoredSignIn({ HOME: "/home/dev" }, files({ [homeAuth]: 0 }))).toBeNull();
  });

  it("reads the Windows profile when HOME is unset", () => {
    const profileAuth = NodePath.join("C:/Users/dev", ".grok", "auth.json");
    expect(findGrokStoredSignIn({ USERPROFILE: "C:/Users/dev" }, files({ [profileAuth]: 9 }))).toBe(
      `${profileAuth}:7:9`,
    );
  });

  it("honours GROK_AUTH_PATH and GROK_HOME", () => {
    expect(
      findGrokStoredSignIn(
        { HOME: "/home/dev", GROK_AUTH_PATH: "/secrets/grok.json" },
        files({ "/secrets/grok.json": 5 }),
      ),
    ).toBe("/secrets/grok.json:7:5");
    const grokHomeAuth = NodePath.join("/opt/grok", "auth.json");
    expect(
      findGrokStoredSignIn(
        { HOME: "/home/dev", GROK_HOME: "/opt/grok" },
        files({ [grokHomeAuth]: 5 }),
      ),
    ).toBe(`${grokHomeAuth}:7:5`);
  });

  it("treats an API key or auth provider as a sign-in without touching disk", () => {
    expect(findGrokStoredSignIn({ XAI_API_KEY: "key" }, files({}))).toBe("environment");
    expect(findGrokStoredSignIn({ GROK_AUTH_PROVIDER_COMMAND: "mint" }, files({}))).toBe(
      "environment",
    );
    expect(findGrokStoredSignIn({ HOME: "/home/dev", XAI_API_KEY: "  " }, files({}))).toBeNull();
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
      forceKillAfter: "2 seconds",
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
      forceKillAfter: "2 seconds",
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

const grokEffortMeta = (efforts: ReadonlyArray<string>) => ({
  supportsReasoningEffort: true,
  reasoningEfforts: efforts.map((effort) => ({
    id: effort,
    value: effort,
    label: effort,
    default: effort === "high",
  })),
});

// xAI's catalog after grok-4.6 was retired: a thread still selecting it must
// not send that id, or every turn fails with "Invalid params".
const retiredGrokSessionSetup = {
  sessionId: "session-1",
  models: {
    currentModelId: "grok-4.7",
    availableModels: [
      {
        modelId: "grok-4.7",
        name: "Grok 4.7",
        _meta: grokEffortMeta(["xhigh", "high", "medium", "low"]),
      },
      { modelId: "grok-4.7-mini", name: "Grok 4.7 Mini", _meta: grokEffortMeta(["high", "low"]) },
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

  it("replaces a retired model id with the agent's advertised current model", () => {
    expect(
      resolveGrokAcpSessionModelId({
        requestedModelId: "grok-4.6",
        currentModelId: undefined,
        sessionSetupResult: retiredGrokSessionSetup,
      }),
    ).toBe("grok-4.7");
  });

  it("keeps the session's live model when the requested id was retired", () => {
    expect(
      resolveGrokAcpSessionModelId({
        requestedModelId: "grok-4.6",
        currentModelId: "grok-4.7-mini",
        sessionSetupResult: retiredGrokSessionSetup,
      }),
    ).toBe("grok-4.7-mini");
  });

  it("passes the requested id through when the agent advertises no models", () => {
    expect(
      resolveGrokAcpSessionModelId({
        requestedModelId: "grok-4.6",
        currentModelId: undefined,
        sessionSetupResult: { sessionId: "session-1" },
      }),
    ).toBe("grok-4.6");
  });
});

describe("resolveGrokAcpSessionEffort", () => {
  it("drops an effort the model does not list", () => {
    expect(
      resolveGrokAcpSessionEffort({
        modelId: "grok-4.7-mini",
        requestedEffort: "xhigh",
        sessionSetupResult: retiredGrokSessionSetup,
      }),
    ).toBeUndefined();
  });

  it("keeps an effort the model lists", () => {
    expect(
      resolveGrokAcpSessionEffort({
        modelId: "grok-4.7",
        requestedEffort: "xhigh",
        sessionSetupResult: retiredGrokSessionSetup,
      }),
    ).toBe("xhigh");
  });

  it("leaves the effort to the agent when the model lists no levels", () => {
    expect(
      resolveGrokAcpSessionEffort({
        modelId: "grok-4.6",
        requestedEffort: "xhigh",
        sessionSetupResult: liveGrokSessionSetup,
      }),
    ).toBe("xhigh");
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

  it.effect("sends the live model instead of a retired one, keeping a supported effort", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, modelMetaCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: "grok-4.6",
        requestedEffort: "xhigh",
        sessionSetupResult: retiredGrokSessionSetup,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["grok-4.7"]);
      expect(modelMetaCalls).toEqual([{ reasoningEffort: "xhigh" }]);
      expect(configCalls).toEqual([]);
      expect(result).toEqual({ modelId: "grok-4.7", reasoningEffort: "xhigh" });
    }),
  );

  it.effect("switches models without an effort the target model does not offer", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, modelMetaCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.7",
        requestedModelId: "grok-4.7-mini",
        currentEffort: "high",
        requestedEffort: "xhigh",
        sessionSetupResult: retiredGrokSessionSetup,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["grok-4.7-mini"]);
      expect(modelMetaCalls).toEqual([undefined]);
      expect(result).toEqual({ modelId: "grok-4.7-mini", reasoningEffort: "high" });
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

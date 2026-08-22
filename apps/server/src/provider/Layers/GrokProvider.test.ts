// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";
import { shellQuote } from "../../terminal/agentCliResume.ts";

import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  grokModelStateFromInitializeMeta,
  grokReasoningEffortLevelsFromModelMeta,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBeUndefined();
      expect(snapshot.showInteractionModeToggle).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-success-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );

  it.effect("records SuperGrok weekly billing during ACP discovery so Refresh is not stale", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-billing-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  printf "grok 1.0.5\\n"',
              "  exit 0",
              "fi",
              `exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"`,
              "",
            ].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.accountUsage).toMatchObject({
        config: { creditUsagePercent: 6 },
      });
      expect(snapshot.accountUsageReportedAt).toEqual(expect.any(String));
    }),
  );
});

describe("grokReasoningEffortLevelsFromModelMeta", () => {
  it("maps advertised reasoning efforts to effort levels", () => {
    expect(
      grokReasoningEffortLevelsFromModelMeta({
        supportsReasoningEffort: true,
        reasoningEffort: "xhigh",
        reasoningEfforts: [
          { id: "xhigh", value: "xhigh", label: "Extra High Effort", default: false },
          { id: "high", value: "high", label: "High Effort", default: true },
          { id: "low", value: "low", label: "Low Effort", default: false },
        ],
      }),
    ).toEqual([
      { value: "xhigh", label: "Extra High Effort", isDefault: false },
      { value: "high", label: "High Effort", isDefault: true },
      { value: "low", label: "Low Effort", isDefault: false },
    ]);
  });

  it("returns nothing when the model does not support reasoning effort", () => {
    expect(
      grokReasoningEffortLevelsFromModelMeta({
        supportsReasoningEffort: false,
        reasoningEfforts: [{ id: "high", value: "high", label: "High", default: true }],
      }),
    ).toEqual([]);
    expect(grokReasoningEffortLevelsFromModelMeta(null)).toEqual([]);
    expect(grokReasoningEffortLevelsFromModelMeta({ supportsReasoningEffort: true })).toEqual([]);
  });

  it("drops malformed and duplicate entries", () => {
    expect(
      grokReasoningEffortLevelsFromModelMeta({
        supportsReasoningEffort: true,
        reasoningEfforts: [
          { id: "high", value: "high", label: "High Effort", default: true },
          { id: "high", value: "high", label: "High again" },
          "not-an-object",
          { value: "  " },
          { id: "low" },
        ],
      }),
    ).toEqual([
      { value: "high", label: "High Effort", isDefault: true },
      { value: "low", label: "low", isDefault: false },
    ]);
  });
});

describe("grokModelStateFromInitializeMeta", () => {
  it.effect("decodes the model catalog grok advertises on initialize", () =>
    Effect.gen(function* () {
      const modelState = yield* grokModelStateFromInitializeMeta({
        grokShell: true,
        agentVersion: "1.0.5",
        modelState: {
          currentModelId: "grok-4.6",
          availableModels: [
            {
              modelId: "grok-4.6",
              name: "Grok 4.6",
              description: "Frontier model",
              _meta: {
                supportsReasoningEffort: true,
                reasoningEffort: "high",
                reasoningEfforts: [
                  { id: "high", value: "high", label: "High Effort", default: true },
                  { id: "low", value: "low", label: "Low Effort", default: false },
                ],
              },
            },
          ],
        },
      });
      expect(modelState?.currentModelId).toBe("grok-4.6");
      expect(modelState?.availableModels).toHaveLength(1);
      expect(modelState?.availableModels[0]?.modelId).toBe("grok-4.6");
      expect(modelState?.availableModels[0]?._meta?.["supportsReasoningEffort"]).toBe(true);
    }),
  );

  it.effect("returns undefined when the meta carries no model state", () =>
    Effect.gen(function* () {
      expect(yield* grokModelStateFromInitializeMeta(undefined)).toBeUndefined();
      expect(yield* grokModelStateFromInitializeMeta(null)).toBeUndefined();
      expect(yield* grokModelStateFromInitializeMeta({ grokShell: true })).toBeUndefined();
    }),
  );

  it.effect("returns undefined when the model state does not decode", () =>
    Effect.gen(function* () {
      expect(
        yield* grokModelStateFromInitializeMeta({
          modelState: { currentModelId: 42, availableModels: "nope" },
        }),
      ).toBeUndefined();
    }),
  );
});

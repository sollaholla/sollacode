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
  GROK_NOT_SIGNED_IN_MESSAGE,
  GrokAuthFileStat,
  grokReasoningEffortLevelsFromModelMeta,
} from "../acp/GrokAcpSupport.ts";
import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  grokModelStateFromInitializeMeta,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
/** A Grok home holding a stored sign-in, so ACP discovery is allowed to start. */
const signedInGrokHome: GrokAuthFileStat = () => ({ mtimeMs: 1, size: 1 });
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
  it.effect("detects a disabled installation using only --version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-disabled-" });
      const binaryPath = path.join(dir, "grok");
      const callsPath = path.join(dir, "calls");
      yield* fs.writeFileString(
        binaryPath,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> ${shellQuote(callsPath)}`,
          'printf "grok-cli 0.0.99\\n"',
          "",
        ].join("\n"),
      );
      yield* fs.chmod(binaryPath, 0o755);
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: false, binaryPath }),
      );
      expect(snapshot).toMatchObject({
        enabled: false,
        installed: true,
        version: "0.0.99",
        status: "disabled",
      });
      expect(yield* fs.readFileString(callsPath)).toBe("--version\n");
    }).pipe(Effect.scoped),
  );

  it.effect("still reports a missing disabled binary as not installed", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: false, binaryPath: "/definitely/not/installed/grok-binary" }),
      );
      expect(snapshot).toMatchObject({ enabled: false, installed: false, status: "disabled" });
    }),
  );

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
          ).pipe(Effect.provideService(GrokAuthFileStat, signedInGrokHome));
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
          ).pipe(Effect.provideService(GrokAuthFileStat, signedInGrokHome));
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

  it.effect("never starts Grok without a stored sign-in", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-signed-out-" });
      const binaryPath = path.join(dir, "grok");
      const callsPath = path.join(dir, "calls");
      yield* fs.writeFileString(
        binaryPath,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> ${shellQuote(callsPath)}`,
          'printf "grok 1.0.30\\n"',
          "",
        ].join("\n"),
      );
      yield* fs.chmod(binaryPath, 0o755);

      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: true, binaryPath }),
        { ...process.env, XAI_API_KEY: "" },
      ).pipe(Effect.provideService(GrokAuthFileStat, () => undefined));

      expect(snapshot).toMatchObject({
        status: "error",
        auth: { status: "unauthenticated" },
        message: GROK_NOT_SIGNED_IN_MESSAGE,
      });
      // `grok agent stdio` never ran, so Grok had no chance to open a sign-in page.
      expect(yield* fs.readFileString(callsPath)).toBe("--version\n");
    }).pipe(Effect.scoped),
  );
});

it.live("stops starting Grok once its stored sign-in waits for a person", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-stale-sign-in-" });
    const binaryPath = path.join(dir, "grok");
    const callsPath = path.join(dir, "calls");
    yield* fs.writeFileString(
      binaryPath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${shellQuote(callsPath)}`,
        'if [ "$1" = "--version" ]; then',
        '  printf "grok 1.0.41\\n"',
        "  exit 0",
        "fi",
        `exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(binaryPath, 0o755);
    const authPath = path.join(dir, ".grok", "auth.json");
    let authFile = { mtimeMs: 1, size: 64 };
    const check = checkGrokProviderStatus(
      decodeGrokSettings({ enabled: true, binaryPath }),
      { ...process.env, XAI_API_KEY: "", HOME: dir, T3_ACP_HANG_AUTHENTICATE: "1" },
      { authenticateTimeout: "200 millis" },
    ).pipe(
      Effect.provideService(GrokAuthFileStat, (filePath) =>
        filePath === authPath ? authFile : undefined,
      ),
    );
    const agentStarts = fs
      .readFileString(callsPath)
      .pipe(Effect.map((calls) => calls.split("\n").filter((call) => call.startsWith("agent"))));

    expect(yield* check).toMatchObject({
      auth: { status: "unauthenticated" },
      message: GROK_NOT_SIGNED_IN_MESSAGE,
    });
    expect(yield* agentStarts).toHaveLength(1);

    // Later checks leave Grok alone instead of re-running its sign-in.
    expect(yield* check).toMatchObject({ auth: { status: "unauthenticated" } });
    expect(yield* agentStarts).toHaveLength(1);

    // `grok login` rewrote auth.json: that sign-in is worth one more try.
    authFile = { mtimeMs: 2, size: 64 };
    yield* check;
    expect(yield* agentStarts).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

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

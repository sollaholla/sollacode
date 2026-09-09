// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { layerTest } from "../../config.ts";
import { AntigravityDriver } from "./AntigravityDriver.ts";

it.live.each([
  { mode: "ready", installed: true, status: "ready", version: "1.2.3", models: 1 },
  { mode: "models-fail", installed: true, status: "error", version: "1.2.3", models: 0 },
  { mode: "version-fail", installed: true, status: "error", version: null, models: 1 },
  { mode: "missing", installed: false, status: "error", version: null, models: 0 },
])("reports the Antigravity CLI's $mode state without inferring authentication", (scenario) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-agy-probe-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const binaryPath = NodePath.join(dir, "agy");
    if (scenario.mode !== "missing") {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          binaryPath,
          `#!/usr/bin/env node
const version = process.argv[2] === '--version';
const failed = '${scenario.mode}' === (version ? 'version-fail' : 'models-fail');
// Output alone is not success: even a failed command can print plausible data.
console.log(version ? 'agy 1.2.3' : 'model-one\\tModel One');
process.exit(failed ? 4 : 0);
`,
          { mode: 0o755 },
        ),
      );
    }
    const instance = yield* AntigravityDriver.create({
      instanceId: ProviderInstanceId.make("antigravity-probe"),
      displayName: undefined,
      environment: [],
      enabled: true,
      config: { ...AntigravityDriver.defaultConfig(), binaryPath },
    }).pipe(Effect.provide(layerTest(dir, { prefix: "solla-agy-probe-home-" })));
    const snapshot = yield* instance.snapshot.getSnapshot;
    expect(snapshot).toMatchObject({
      installed: scenario.installed,
      status: scenario.status,
      version: scenario.version,
      auth: { status: "unknown" },
    });
    expect(snapshot.models).toHaveLength(scenario.models);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([0, 4])(
  "checks native authentication exit status %s and groups effort variants",
  (exitCode) =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-agy-auth-probe-")),
        ),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const binaryPath = NodePath.join(dir, "agy");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          binaryPath,
          `#!/usr/bin/env node
const arg = process.argv[2];
if (arg === '--version') console.log('agy 1.1.28');
else if (arg === 'models') console.log('gemini-flash-high\\tGemini Flash (High)\\ngemini-flash-low\\tGemini Flash (Low)');
else {console.log('Gemini Models\\tWeekly Limit Remaining\\t0%\\t2026-09-11T18:30:48Z'); process.exit(${exitCode});}
`,
          { mode: 0o755 },
        ),
      );
      const instance = yield* AntigravityDriver.create({
        instanceId: ProviderInstanceId.make("agy-probe"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: {
          ...AntigravityDriver.defaultConfig(),
          binaryPath,
          customModels: ["gemini-flash", "gemini-flash-low"],
        },
      }).pipe(Effect.provide(layerTest(dir, { prefix: "solla-agy-auth-probe-home-" })));
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.auth.status).toBe(exitCode === 0 ? "authenticated" : "unknown");
      expect(snapshot.models).toHaveLength(1);
      expect(snapshot.models[0]?.slug).toBe("gemini-flash");
      expect(instance.accountAuth).toHaveProperty("switchAccount");
    }).pipe(Effect.provide(NodeServices.layer)),
);

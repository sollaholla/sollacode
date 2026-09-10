// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { layerTest } from "../../config.ts";
import { DeepCodeDriver } from "./DeepCodeDriver.ts";

it.live.each([
  {
    mode: "ready",
    hasKey: true,
    installed: true,
    status: "ready",
    version: "0.4.0",
    auth: "authenticated",
  },
  {
    mode: "ready",
    hasKey: false,
    installed: true,
    status: "ready",
    version: "0.4.0",
    auth: "unauthenticated",
  },
  {
    mode: "version-fail",
    hasKey: true,
    installed: true,
    status: "error",
    version: null,
    auth: "authenticated",
  },
  {
    mode: "missing",
    hasKey: true,
    installed: false,
    status: "error",
    version: null,
    auth: "authenticated",
  },
])("reports the Deep Code CLI's $mode / $auth state without generating", (scenario) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-deepcode-probe-")),
      ),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const binaryPath = NodePath.join(dir, "deepcode");
    if (scenario.mode !== "missing") {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          binaryPath,
          `#!/usr/bin/env node
const failed = '${scenario.mode}' === 'version-fail';
console.log('0.4.0');
process.exit(failed ? 4 : 0);
`,
          { mode: 0o755 },
        ),
      );
    }
    yield* Effect.promise(() =>
      NodeFSP.mkdir(NodePath.join(dir, ".deepcode"), { recursive: true }).then(() =>
        NodeFSP.writeFile(
          NodePath.join(dir, ".deepcode", "settings.json"),
          JSON.stringify({
            env: {
              MODEL: "deepseek-flash",
              ...(scenario.hasKey ? { API_KEY: "sk-fixture" } : {}),
            },
          }),
        ),
      ),
    );
    const instance = yield* DeepCodeDriver.create({
      instanceId: ProviderInstanceId.make("deepcode-probe"),
      displayName: undefined,
      environment: [{ name: "HOME", value: dir, sensitive: false }],
      enabled: true,
      config: { ...DeepCodeDriver.defaultConfig(), binaryPath },
    }).pipe(Effect.provide(layerTest(dir, { prefix: "solla-deepcode-probe-home-" })));
    const snapshot = yield* instance.snapshot.getSnapshot;
    expect(snapshot).toMatchObject({
      installed: scenario.installed,
      status: scenario.status,
      version: scenario.version,
      auth: { status: scenario.auth },
      badgeLabel: "DC",
    });
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    expect(JSON.stringify(snapshot)).not.toContain("sk-fixture");
    expect(snapshot.models.map((model) => model.slug)).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

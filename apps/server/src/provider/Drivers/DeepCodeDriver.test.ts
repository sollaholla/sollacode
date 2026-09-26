// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
const usageTestLayers = Layer.mergeAll(
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  serverSettingsLayerTest(),
);
import { layerTest } from "../../config.ts";
const mockFetch = (
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: () => undefined });
import { DeepCodeDriver } from "./DeepCodeDriver.ts";

const DEEPCODE_CREDENTIAL_KEYS = [
  "DEEPCODE_API_KEY",
  "DEEPCODE_BASE_URL",
  "DEEPCODE_MODEL",
  "DEEPCODE_REASONING_EFFORT",
] as const;

/**
 * A Solla Deep Code agent can launch this suite with its own selected key
 * already in the shell environment, and the driver merges `process.env` into
 * every probe. Clear those variables for the test so the fixture settings file
 * is the only credential source, then restore them.
 */
function withCleanDeepCodeEnvironment<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = DEEPCODE_CREDENTIAL_KEYS.map((key) => [key, process.env[key]] as const);
      for (const key of DEEPCODE_CREDENTIAL_KEYS) delete process.env[key];
      return saved;
    }),
    () => effect,
    (saved) =>
      Effect.sync(() => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );
}

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
  withCleanDeepCodeEnvironment(
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
      }).pipe(
        Effect.provide(
          Layer.merge(usageTestLayers, layerTest(dir, { prefix: "solla-deepcode-probe-home-" })),
        ),
        Effect.provideService(
          FetchHttpClient.Fetch,
          mockFetch(async () =>
            Response.json({
              is_available: true,
              balance_infos: [
                {
                  currency: "USD",
                  total_balance: "12.50",
                  granted_balance: "0",
                  topped_up_balance: "12.50",
                },
              ],
            }),
          ),
        ),
      );
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot).toMatchObject({
        installed: scenario.installed,
        status: scenario.status,
        version: scenario.version,
        auth: { status: scenario.auth },
        badgeLabel: "DC",
      });
      if (scenario.hasKey && scenario.mode === "ready") {
        expect(snapshot.accountUsage).toMatchObject({
          balance_infos: [{ total_balance: "12.50" }],
        });
        const failRefresh = instance.snapshot.refresh.pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            mockFetch(async () => new Response("unavailable", { status: 503 })),
          ),
        );
        const failed = yield* failRefresh;
        expect(failed.accountUsage).toEqual(snapshot.accountUsage);
        expect(failed.accountUsageReportedAt).toBe(snapshot.accountUsageReportedAt);
        expect(failed.accountUsageStatus?.state).toBe("error");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(dir, ".deepcode", "settings.json"),
            '{"env":{"API_KEY":"another-account"}}',
          ),
        );
        const changed = yield* failRefresh;
        expect(changed.accountUsageIdentity).not.toBe(snapshot.accountUsageIdentity);
        expect(changed.accountUsage).toBeUndefined();
        expect(changed.accountUsageReportedAt).toBeUndefined();
        const recovered = yield* instance.snapshot.refresh.pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            mockFetch(async () => Response.json({ is_available: false, balance_infos: [] })),
          ),
        );
        expect(recovered.accountUsageStatus?.state).toBe("available");
        expect(recovered.accountUsage).toEqual({ is_available: false, balance_infos: [] });
      }
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.stringify(snapshot)).not.toContain("sk-fixture");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "deepseek-flash",
        "deepseek-v4-pro",
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

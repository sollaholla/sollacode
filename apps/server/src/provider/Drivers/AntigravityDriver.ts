import { AntigravitySettings, TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ServerConfig } from "../../config.ts";
import { parseGenericCliVersion, spawnAndCollect } from "../providerSnapshot.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { parseAntigravityModelsOutput } from "../antigravityProtocol.ts";
import { ANTIGRAVITY_DRIVER_KIND } from "../antigravityRuntime.ts";
import { makeAntigravityAdapter } from "../Layers/AntigravityAdapter.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);

export type AntigravityDriverEnv = ServerConfig | ChildProcessSpawner.ChildProcessSpawner;
export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: ANTIGRAVITY_DRIVER_KIND,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("AntigravityDriver.create")(function* (input) {
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = mergeProviderInstanceEnvironment(input.environment);
    const binaryPath = input.config.binaryPath || "agy";
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: ANTIGRAVITY_DRIVER_KIND,
      instanceId: input.instanceId,
    });
    const probe = Effect.fn("AntigravityDriver.probe")(
      function* (): Effect.fn.Return<ServerProvider> {
        const runProbe = Effect.fn("AntigravityDriver.runProbe")(function* (args: string[]) {
          const command = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
          return yield* spawnAndCollect(
            binaryPath,
            ChildProcess.make(command.command, command.args, {
              env: environment,
              extendEnv: false,
              shell: command.shell,
              forceKillAfter: "2 seconds",
            }),
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.timeout("15 seconds"),
            Effect.result,
          );
        });
        const results = input.enabled
          ? yield* Effect.all([runProbe(["--version"]), runProbe(["models"])], {
              concurrency: "unbounded",
            })
          : undefined;
        const versionResult = results?.[0];
        const modelsResult = results?.[1];
        const installed = versionResult?._tag === "Success";
        const versionReady = installed && versionResult.success.code === 0;
        const modelsReady = modelsResult?._tag === "Success" && modelsResult.success.code === 0;
        const available = versionReady && modelsReady;
        const models = modelsReady ? parseAntigravityModelsOutput(modelsResult.success.stdout) : [];
        return {
          instanceId: input.instanceId,
          driver: ANTIGRAVITY_DRIVER_KIND,
          displayName: input.displayName ?? "Antigravity",
          ...(input.accentColor ? { accentColor: input.accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          badgeLabel: "AGY",
          enabled: input.enabled,
          installed,
          version: versionReady ? parseGenericCliVersion(versionResult.success.stdout) : null,
          status: !input.enabled ? "disabled" : available ? "ready" : "error",
          auth: { status: "unknown" },
          checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          message: !input.enabled
            ? "Antigravity is disabled in Solla Code settings."
            : available
              ? "Uses your Antigravity CLI sign-in. Headless approvals follow CLI policy; Full access permits all tools."
              : installed
                ? "Antigravity is installed, but its CLI check failed. Run agy --version and agy models in a terminal, then refresh."
                : "Install agy and sign in from a terminal, then refresh.",
          availability: "available",
          showInteractionModeToggle: true,
          requiresNewThreadForModelChange: false,
          models: [
            ...models.map((model, index) => ({
              slug: model.slug,
              name: model.label,
              isCustom: false,
              isDefault: index === 0,
              capabilities: null,
            })),
            ...input.config.customModels
              .filter((slug) => !models.some((model) => model.slug === slug))
              .map((slug) => ({
                slug,
                name: slug,
                isCustom: true,
                isDefault: false,
                capabilities: null,
              })),
          ],
          slashCommands: [],
          skills: [],
          runtimeCapabilities: {
            taskStop: false,
            threadRollback: false,
            threadFork: false,
            textGeneration: false,
            modelSwitchRequiresNewThread: false,
          },
        };
      },
    );
    const snapshotRef = yield* Ref.make(yield* probe());
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const adapter = yield* makeAntigravityAdapter({
      instanceId: input.instanceId,
      binaryPath,
      environment,
      cwd: serverConfig.cwd,
    });
    return {
      instanceId: input.instanceId,
      driverKind: ANTIGRAVITY_DRIVER_KIND,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      adapter,
      textGeneration: {
        generateCommitMessage: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        generatePrContent: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        generateBranchName: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        generateThreadTitle: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        correctVoiceTranscript: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "correctVoiceTranscript",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        generatePlanRefresh: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePlanRefresh",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
        generateVmAgentTaskPrompt: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateVmAgentTaskPrompt",
              detail: "Antigravity auxiliary generation is unavailable.",
            }),
          ),
      },
      snapshot: {
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: ANTIGRAVITY_DRIVER_KIND,
          packageName: null,
        }),
        getSnapshot: Ref.get(snapshotRef),
        refresh: probe().pipe(
          Effect.tap((snapshot) => Ref.set(snapshotRef, snapshot)),
          Effect.tap((snapshot) => PubSub.publish(changes, snapshot)),
        ),
        streamChanges: Stream.fromPubSub(changes),
      },
    };
  }),
};

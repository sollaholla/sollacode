// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  McpBridgeSettings,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ServerProvider,
  type ServerProviderState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makeMcpBridgeTextGeneration } from "../../textGeneration/McpBridgeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import { makeMcpBridgeAdapter, MCP_BRIDGE_DRIVER_KIND } from "../mcpBridge/McpBridgeAdapter.ts";
import { McpBridgeConnection } from "../mcpBridge/McpBridgeConnection.ts";
import {
  parseMcpBridgeArguments,
  type McpBridgeDescriptor,
} from "../mcpBridge/McpBridgeProtocol.ts";

const decodeSettings = Schema.decodeSync(McpBridgeSettings);
const DRIVER_KIND = ProviderDriverKind.make("mcpBridge");
export const SOLLA_PROVIDER_INSTANCE_ID_ENV = "SOLLA_PROVIDER_INSTANCE_ID";

export function makeMcpBridgeProcessEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  instanceId: ProviderInstance["instanceId"],
): NodeJS.ProcessEnv {
  return {
    ...mergeProviderInstanceEnvironment(environment),
    // This reserved host value lets a bridge namespace resumable state without
    // making Solla aware of the bridge's storage format or files.
    [SOLLA_PROVIDER_INSTANCE_ID_ENV]: String(instanceId),
  };
}

function nowIso(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

export type McpBridgeDriverEnv = ServerConfig;

function validateConfiguration(
  config: McpBridgeSettings,
  instanceId: ProviderInstance["instanceId"],
): Effect.Effect<void, ProviderDriverError> {
  if (config.command.length === 0) {
    return Effect.fail(
      new ProviderDriverError({
        driver: DRIVER_KIND,
        instanceId,
        detail: "MCP bridge command is required and must be an absolute path.",
      }),
    );
  }
  if (!NodePath.isAbsolute(config.command)) {
    return Effect.fail(
      new ProviderDriverError({
        driver: DRIVER_KIND,
        instanceId,
        detail: `MCP bridge command must be absolute: '${config.command}'.`,
      }),
    );
  }
  if (config.workingDirectory.length > 0 && !NodePath.isAbsolute(config.workingDirectory)) {
    return Effect.fail(
      new ProviderDriverError({
        driver: DRIVER_KIND,
        instanceId,
        detail: `MCP bridge working directory must be absolute: '${config.workingDirectory}'.`,
      }),
    );
  }
  return Effect.void;
}

function statusFromDescriptor(descriptor: McpBridgeDescriptor): ServerProviderState {
  const health = descriptor.health.status.toLowerCase();
  const harness = typeof descriptor.health.harness === "string" ? descriptor.health.harness : "";
  if (health === "error" || health === "failed" || harness === "conflict") return "error";
  if (health === "warning" || health === "degraded" || harness === "stopped") return "warning";
  return "ready";
}

function descriptorSnapshot(input: {
  readonly descriptor: McpBridgeDescriptor;
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationKey: string;
  readonly enabled: boolean;
}): ServerProvider {
  const { descriptor } = input;
  const detail =
    typeof descriptor.health.detail === "string" && descriptor.health.detail.trim().length > 0
      ? descriptor.health.detail.trim()
      : undefined;
  const descriptorSummary = detail
    ? `${descriptor.provider.name} - ${detail}`
    : descriptor.provider.name;
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    displayName: input.displayName ?? descriptor.provider.name,
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    badgeLabel: "External",
    continuation: { groupKey: input.continuationKey },
    showInteractionModeToggle: true,
    requiresNewThreadForModelChange: descriptor.capabilities.modelSwitchRequiresNewThread,
    enabled: input.enabled,
    installed: true,
    version: descriptor.provider.version,
    status: input.enabled ? statusFromDescriptor(descriptor) : "disabled",
    auth: { status: "unknown", type: "external-mcp" },
    checkedAt: nowIso(),
    message: descriptorSummary,
    availability: "available",
    models: descriptor.models.map((model) => ({
      slug: model.id,
      name: model.name,
      ...(model.provider ? { subProvider: model.provider } : {}),
      isCustom: false,
      isDefault: model.id === descriptor.defaultModel,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
    runtimeCapabilities: descriptor.capabilities,
  };
}

function unavailableSnapshot(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationKey: string;
  readonly enabled: boolean;
  readonly detail?: string | undefined;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    displayName: input.displayName ?? "MCP Provider Bridge",
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    badgeLabel: "External",
    continuation: { groupKey: input.continuationKey },
    showInteractionModeToggle: true,
    requiresNewThreadForModelChange: true,
    enabled: input.enabled,
    installed: false,
    version: null,
    status: input.enabled ? "error" : "disabled",
    auth: { status: "unknown", type: "external-mcp" },
    checkedAt: nowIso(),
    ...(input.detail ? { message: input.detail } : {}),
    availability: "available",
    models: [],
    slashCommands: [],
    skills: [],
    runtimeCapabilities: {
      taskStop: false,
      textGeneration: false,
      threadRollback: false,
      threadFork: false,
      modelSwitchRequiresNewThread: true,
    },
  };
}

export const McpBridgeDriver: ProviderDriver<McpBridgeSettings, McpBridgeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "MCP Provider Bridge",
    supportsMultipleInstances: true,
  },
  configSchema: McpBridgeSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      yield* validateConfiguration(config, instanceId);
      const serverConfig = yield* ServerConfig;
      const processEnv = makeMcpBridgeProcessEnvironment(environment, instanceId);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const connection = new McpBridgeConnection({
        command: config.command,
        args: parseMcpBridgeArguments(config.arguments),
        ...(config.workingDirectory ? { cwd: config.workingDirectory } : {}),
        env: processEnv,
        sensitiveValues: environment
          .filter((variable) => variable.sensitive)
          .map((variable) => variable.value),
      });

      const initialDescriptor = enabled
        ? yield* Effect.tryPromise({
            try: () => connection.describe(),
            catch: (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }).pipe(Effect.result)
        : undefined;
      const initialSnapshot =
        initialDescriptor === undefined
          ? unavailableSnapshot({
              instanceId,
              displayName,
              accentColor,
              continuationKey: continuationIdentity.continuationKey,
              enabled,
            })
          : initialDescriptor._tag === "Success"
            ? descriptorSnapshot({
                descriptor: initialDescriptor.success,
                instanceId,
                displayName,
                accentColor,
                continuationKey: continuationIdentity.continuationKey,
                enabled,
              })
            : unavailableSnapshot({
                instanceId,
                displayName,
                accentColor,
                continuationKey: continuationIdentity.continuationKey,
                enabled,
                detail:
                  initialDescriptor.failure instanceof Error
                    ? initialDescriptor.failure.message
                    : String(initialDescriptor.failure),
              });

      const snapshotRef = yield* Ref.make(initialSnapshot);
      const changes = yield* Effect.acquireRelease(
        PubSub.unbounded<ServerProvider>(),
        PubSub.shutdown,
      );
      const refresh: ServerProviderShape["refresh"] = enabled
        ? Effect.tryPromise({
            try: () => connection.describe(),
            catch: (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }).pipe(
            Effect.result,
            Effect.map((result) =>
              result._tag === "Success"
                ? descriptorSnapshot({
                    descriptor: result.success,
                    instanceId,
                    displayName,
                    accentColor,
                    continuationKey: continuationIdentity.continuationKey,
                    enabled,
                  })
                : unavailableSnapshot({
                    instanceId,
                    displayName,
                    accentColor,
                    continuationKey: continuationIdentity.continuationKey,
                    enabled,
                    detail:
                      result.failure instanceof Error
                        ? result.failure.message
                        : String(result.failure),
                  }),
            ),
            Effect.tap((snapshot) => Ref.set(snapshotRef, snapshot)),
            Effect.tap((snapshot) => PubSub.publish(changes, snapshot)),
          )
        : Ref.get(snapshotRef);

      const snapshot: ServerProviderShape = {
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        }),
        getSnapshot: Ref.get(snapshotRef),
        refresh,
        streamChanges: Stream.fromPubSub(changes),
      };
      const adapter = yield* makeMcpBridgeAdapter({ connection, instanceId, serverConfig });
      const textGeneration = makeMcpBridgeTextGeneration(connection);

      yield* Effect.addFinalizer(() =>
        adapter
          .stopAll()
          .pipe(
            Effect.ignore,
            Effect.andThen(Effect.promise(() => connection.shutdown()).pipe(Effect.ignore)),
          ),
      );

      return {
        instanceId,
        driverKind: MCP_BRIDGE_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};

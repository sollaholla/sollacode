import {
  ClientPresentation,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import { ConnectionBlockedError, Connectivity, Wakeups } from "@t3tools/client-runtime/connection";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Network from "expo-network";
import { AppState } from "react-native";

import { authClientMetadata } from "../lib/authClientMetadata";
import * as Runtime from "../lib/runtime";
import { clearThreadOutboxEnvironment } from "../state/thread-outbox";
import { clearComposerDraftsEnvironment } from "../state/use-composer-drafts";
import { connectionStorageLayer } from "./storage";

function networkStatus(state: Network.NetworkState): "unknown" | "offline" | "online" {
  if (state.isConnected === false) {
    return "offline";
  }
  if (state.isConnected === true) {
    return "online";
  }
  return "unknown";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.tryPromise({
    try: () => Network.getNetworkStateAsync(),
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: () => "unknown" as const,
      onSuccess: networkStatus,
    }),
  ),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Network.addNetworkStateListener((state) => {
          Queue.offerUnsafe(queue, networkStatus(state));
        }),
      ),
      (subscription) => Effect.sync(() => subscription.remove()),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        AppState.addEventListener("change", (state) => {
          if (state === "active") {
            Queue.offerUnsafe(queue, "application-active");
          }
        }),
      ),
      (subscription) => Effect.sync(() => subscription.remove()),
    ).pipe(Effect.asVoid),
  ),
});

const capabilitiesLayer = Layer.effectContext(
  Effect.gen(function* () {
    return Context.make(
      PrimaryEnvironmentAuth,
      PrimaryEnvironmentAuth.of({ bearerToken: Effect.succeedNone }),
    ).pipe(
      Context.add(
        ClientPresentation,
        ClientPresentation.of({
          metadata: authClientMetadata(),
          scopes: AuthStandardClientScopes,
        }),
      ),
      Context.add(
        SshEnvironmentGateway,
        SshEnvironmentGateway.of({
          provision: () =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: "SSH environments are only available in the desktop app.",
              }),
            ),
          prepare: () =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: "SSH environments are only available in the desktop app.",
              }),
            ),
          disconnect: () => Effect.void,
        }),
      ),
    );
  }),
);

const platformConnectionSourceLayer = Layer.succeed(
  PlatformConnectionSource,
  PlatformConnectionSource.of({
    registrations: Stream.empty,
  }),
);

const providedConnectionStorageLayer = connectionStorageLayer.pipe(
  Layer.provide(Runtime.runtimeContextLayer),
);
const providedCapabilitiesLayer = capabilitiesLayer.pipe(
  Layer.provide(Runtime.runtimeContextLayer),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.all(
        [
          Effect.promise(() => clearThreadOutboxEnvironment(environmentId)),
          Effect.promise(() => clearComposerDraftsEnvironment(environmentId)),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not clear mobile environment-owned data.", {
            environmentId,
            cause,
          }),
        ),
      ),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof providedConnectionStorageLayer
  | typeof Runtime.runtimeContextLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | typeof providedCapabilitiesLayer
  | typeof platformConnectionSourceLayer
  | typeof environmentOwnedDataCleanupLayer;

export const connectionPlatformLayer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  providedConnectionStorageLayer,
  Runtime.runtimeContextLayer,
  connectivityLayer,
  wakeupsLayer,
  providedCapabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
);

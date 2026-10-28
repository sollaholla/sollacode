import { type EnvironmentId, type RelayedEnvironmentSource, WS_METHODS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { request, subscribe } from "../rpc/client.ts";
import { BearerConnectionCredential, BearerConnectionProfile } from "./catalog.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { EnvironmentRegistry, type RelayVia } from "./registry.ts";

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

/** Environments this device reaches directly, whose hosts may share others. */
export function relayViasOf(
  entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
): ReadonlyMap<EnvironmentId, RelayVia> {
  const vias = new Map<EnvironmentId, RelayVia>();
  for (const entry of entries.values()) {
    const target = entry.target;
    if (target._tag === "PrimaryConnectionTarget") {
      vias.set(target.environmentId, {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        connectionId: null,
      });
    } else if (
      target._tag === "BearerConnectionTarget" &&
      Option.isSome(entry.profile) &&
      isBearerProfile(entry.profile.value)
    ) {
      vias.set(target.environmentId, {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: entry.profile.value.httpBaseUrl,
        connectionId: target.connectionId,
      });
    }
  }
  return vias;
}

const sameVia = (left: RelayVia, right: RelayVia) =>
  left.label === right.label &&
  left.httpBaseUrl === right.httpBaseUrl &&
  left.connectionId === right.connectionId;

/**
 * Keeps the registry's relayed environments in step with what each directly
 * connected host shares. A host that predates relaying, or refuses this
 * device, simply shares nothing.
 */
export const followRelayedEnvironments = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const followers = yield* FiberMap.make<EnvironmentId>();
  const following = yield* Ref.make<ReadonlyMap<EnvironmentId, RelayVia>>(new Map());

  const follow = (via: RelayVia) =>
    registry
      .followStream(via.environmentId, subscribe(WS_METHODS.subscribeRelayedEnvironments, {}))
      .pipe(
        Stream.runForEach((list) => registry.reconcileRelays(via, list.environments)),
        Effect.catchCause((cause) =>
          Effect.logDebug("This host shares no other machines.", {
            environmentId: via.environmentId,
            cause,
          }),
        ),
      );

  yield* SubscriptionRef.changes(registry.entries).pipe(
    Stream.map(relayViasOf),
    Stream.runForEach((vias) =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(following);
        for (const [environmentId, via] of previous) {
          if (vias.has(environmentId)) continue;
          yield* FiberMap.remove(followers, environmentId);
          yield* registry.reconcileRelays(via, []);
        }
        for (const [environmentId, via] of vias) {
          const known = previous.get(environmentId);
          if (known !== undefined && sameVia(known, via)) continue;
          yield* FiberMap.run(followers, environmentId, follow(via));
        }
        yield* Ref.set(following, vias);
      }),
    ),
  );
}).pipe(Effect.withSpan("clientRuntime.connection.followRelayedEnvironments"));

/** How often the desktop app re-sends its connections, so renewed credentials reach the host. */
const REPUBLISH_INTERVAL = Duration.minutes(10);

/**
 * Run by the host's own desktop app: shares its saved connections with the
 * host, which relays them to its other clients (a phone on the host's
 * Tailscale address). Re-sent when connections change, when the host
 * reconnects (a restarted server forgets them), and periodically.
 */
export const publishRelayableEnvironments = (hostEnvironmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;

    const sources = Effect.gen(function* () {
      const found: Array<RelayedEnvironmentSource> = [];
      for (const entry of (yield* SubscriptionRef.get(registry.entries)).values()) {
        const target = entry.target;
        if (
          target._tag !== "BearerConnectionTarget" ||
          target.environmentId === hostEnvironmentId ||
          Option.isNone(entry.profile) ||
          !isBearerProfile(entry.profile.value)
        ) {
          continue;
        }
        const credential = yield* credentials
          .get(target.connectionId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(credential) || !isBearerCredential(credential.value)) continue;
        found.push({
          environmentId: target.environmentId,
          label: target.label,
          httpBaseUrl: entry.profile.value.httpBaseUrl,
          bearerToken: credential.value.token,
        });
      }
      return found;
    });

    const publish = Effect.gen(function* () {
      const environments = yield* sources;
      yield* registry.run(
        hostEnvironmentId,
        request(WS_METHODS.relayedEnvironmentsPublish, { environments }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("Could not share connections with this machine's server.", { cause }),
      ),
    );

    yield* Stream.mergeAll(
      [
        SubscriptionRef.changes(registry.entries).pipe(Stream.map(() => undefined)),
        registry.stateChanges(hostEnvironmentId).pipe(
          Stream.filter((state) => state.phase === "connected"),
          Stream.map((state) => state.generation),
          Stream.changes,
          Stream.map(() => undefined),
          Stream.catchCause(() => Stream.empty),
        ),
        Stream.tick(REPUBLISH_INTERVAL),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.debounce(Duration.seconds(1)),
      Stream.runForEach(() => publish),
    );
  }).pipe(Effect.withSpan("clientRuntime.connection.publishRelayableEnvironments"));

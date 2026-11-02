import type {
  EnvironmentId,
  RelayedEnvironmentList,
  RelayedEnvironmentSource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerSettingsService } from "../serverSettings.ts";

/**
 * The other machines this host passes through to its clients, with the
 * credential that signs each relayed request. The host's own desktop app
 * publishes them from its saved connections; nothing is written to disk, so a
 * restart forgets them until the desktop app publishes again. Agents on this
 * host reach the same machines with `workspace_consult`. Turning off the
 * `shareConnectedComputers` setting hides and refuses all of them.
 */
export class RelayedEnvironments extends Context.Service<
  RelayedEnvironments,
  {
    /** Replaces every shared environment. */
    readonly publish: (sources: ReadonlyArray<RelayedEnvironmentSource>) => Effect.Effect<void>;
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<RelayedEnvironmentSource>>;
    /** Swaps in a renewed credential, unless a newer publish already replaced it. */
    readonly renewToken: (
      environmentId: EnvironmentId,
      previous: string,
      next: string,
    ) => Effect.Effect<void>;
    /** Every shared environment right now, credentials included: server-side use only. */
    readonly sources: Effect.Effect<ReadonlyArray<RelayedEnvironmentSource>>;
    /** What clients may see: names only, the current list first. */
    readonly list: Stream.Stream<RelayedEnvironmentList>;
  }
>()("t3/relay/RelayedEnvironments") {}

const toList = (
  sources: ReadonlyMap<EnvironmentId, RelayedEnvironmentSource>,
): RelayedEnvironmentList => ({
  environments: [...sources.values()]
    .map(({ environmentId, label }) => ({ environmentId, label }))
    .toSorted((left, right) => left.label.localeCompare(right.label)),
});

const EMPTY: ReadonlyMap<EnvironmentId, RelayedEnvironmentSource> = new Map();

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const sources = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, RelayedEnvironmentSource>>(
    new Map(),
  );
  // Fails closed: a setting that cannot be read shares nothing.
  const sharing = settings.getSettings.pipe(
    Effect.map((current) => current.shareConnectedComputers),
    Effect.orElseSucceed(() => false),
  );
  const sharingChanges = Stream.concat(
    Stream.fromEffect(sharing),
    settings.streamChanges.pipe(Stream.map((current) => current.shareConnectedComputers)),
  );

  return RelayedEnvironments.of({
    publish: (next) =>
      SubscriptionRef.set(
        sources,
        new Map(next.map((source) => [source.environmentId, source] as const)),
      ),
    get: (environmentId) =>
      Effect.gen(function* () {
        if (!(yield* sharing)) return Option.none();
        return Option.fromUndefinedOr((yield* SubscriptionRef.get(sources)).get(environmentId));
      }),
    sources: Effect.gen(function* () {
      if (!(yield* sharing)) return [];
      return [...(yield* SubscriptionRef.get(sources)).values()];
    }),
    renewToken: (environmentId, previous, next) =>
      SubscriptionRef.update(sources, (current) => {
        const source = current.get(environmentId);
        if (source === undefined || source.bearerToken !== previous) return current;
        return new Map(current).set(environmentId, { ...source, bearerToken: next });
      }),
    list: Stream.zipLatest(SubscriptionRef.changes(sources), sharingChanges).pipe(
      Stream.map(([current, enabled]) => toList(enabled ? current : EMPTY)),
      Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
    ),
  });
});

export const layer = Layer.effect(RelayedEnvironments, make);

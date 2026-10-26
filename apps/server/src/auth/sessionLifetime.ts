import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { SessionCredentialChange } from "./SessionStore.ts";

/**
 * A revoked socket must stop owning scoped streams, including preview video
 * watches and desktop hosts. Subscribe before authenticating so revocation
 * during the handshake is queued rather than missed.
 */
export const withSessionLifetime = <A, E, R>(
  sessionId: AuthSessionId,
  changes: PubSub.Subscription<SessionCredentialChange>,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.raceFirst(
    operation,
    Stream.fromSubscription(changes).pipe(
      Stream.filter((event) => event.type === "clientRemoved" && event.sessionId === sessionId),
      Stream.runHead,
      Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: () => Effect.interrupt })),
    ),
  );

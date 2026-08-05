import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

export type ConnectionSupervisorSignal =
  | { readonly _tag: "IntentChanged" }
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "CredentialsChanged" }
  | { readonly _tag: "ApplicationActive" };

export interface ConnectionSignalMailboxSnapshot {
  readonly intentChanged: boolean;
  readonly retryRequested: boolean;
  readonly credentialsChanged: boolean;
  readonly applicationActive: boolean;
}

const EMPTY: ConnectionSignalMailboxSnapshot = {
  intentChanged: false,
  retryRequested: false,
  credentialsChanged: false,
  applicationActive: false,
};

const popNext = (
  pending: ConnectionSignalMailboxSnapshot,
): readonly [Option.Option<ConnectionSupervisorSignal>, ConnectionSignalMailboxSnapshot] => {
  if (pending.intentChanged) {
    return [Option.some({ _tag: "IntentChanged" }), { ...pending, intentChanged: false }];
  }
  if (pending.retryRequested) {
    return [Option.some({ _tag: "RetryRequested" }), { ...pending, retryRequested: false }];
  }
  if (pending.credentialsChanged) {
    return [Option.some({ _tag: "CredentialsChanged" }), { ...pending, credentialsChanged: false }];
  }
  if (pending.applicationActive) {
    return [Option.some({ _tag: "ApplicationActive" }), { ...pending, applicationActive: false }];
  }
  return [Option.none(), pending];
};

/**
 * A bounded semantic mailbox for supervisor wakeups.
 *
 * Connection intent and network values remain in their authoritative refs;
 * this mailbox only records that the latest state must be re-read. Retry and
 * credential edges remain distinct so a noisy application-active stream
 * cannot consume them. One sliding notifier wakes the consumer without
 * allocating one queue node per signal.
 */
export const make = Effect.fn("ConnectionSignalMailbox.make")(function* () {
  const pending = yield* Ref.make<ConnectionSignalMailboxSnapshot>(EMPTY);
  const notifier = yield* Queue.sliding<void>(1);

  const notify = (
    update: (current: ConnectionSignalMailboxSnapshot) => ConnectionSignalMailboxSnapshot,
  ) =>
    Ref.update(pending, update).pipe(
      Effect.andThen(Queue.offer(notifier, undefined)),
      Effect.asVoid,
    );

  const offer = (signal: ConnectionSupervisorSignal): Effect.Effect<void> => {
    switch (signal._tag) {
      case "IntentChanged":
        return notify((current) => ({ ...current, intentChanged: true }));
      case "RetryRequested":
        return notify((current) => ({ ...current, retryRequested: true }));
      case "CredentialsChanged":
        return notify((current) => ({ ...current, credentialsChanged: true }));
      case "ApplicationActive":
        return notify((current) => ({ ...current, applicationActive: true }));
    }
  };

  const take: Effect.Effect<ConnectionSupervisorSignal> = Effect.gen(function* () {
    for (;;) {
      const next = yield* Ref.modify(pending, popNext);
      if (Option.isSome(next)) return next.value;
      yield* Queue.take(notifier);
    }
  });

  return {
    offer,
    take,
    snapshot: Ref.get(pending),
    shutdown: Queue.shutdown(notifier),
  } as const;
});

import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  connectionProjectionPhase,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

/**
 * Ceiling on how long a subscription will wait for a prepared connection before
 * giving up on the HTTP snapshot. The snapshot is only an optimisation — the
 * server embeds one in the subscription's first frame when the client cannot
 * resume — so waiting indefinitely trades a fast path for a thread that never
 * renders at all.
 */
const PREPARED_CONNECTION_WAIT = Duration.seconds(5);

function shouldPersistThread(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  if (status === "starting" || status === "running") return false;
  // A snapshot with a still-streaming bubble is a lie once restored: it
  // re-renders minutes-old mid-turn text as if it were current. Only settled
  // bodies are worth caching.
  return !thread.messages.some((message) => message.streaming === true);
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  // Connection-state delivery and the per-thread stream run on separate
  // fibers. Remember which connection generation actually completed so a
  // delayed `connecting` state from that same generation cannot overwrite a
  // newer completion marker and strand the UI in "Catching up".
  const synchronizedGeneration = yield* Ref.make(Option.none<number>());
  // Cached snapshots written by older builds can contain a mid-turn streaming
  // bubble; resuming by sequence on top of one keeps rendering stale text.
  // Start those threads from a fresh snapshot instead.
  const forceSnapshot = yield* Ref.make(
    Option.match(cachedThread, {
      onNone: () => false,
      onSome: (thread) => thread.messages.some((message) => message.streaming === true),
    }),
  );
  const resubscribeRequests = yield* Queue.sliding<void>(1);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const markCurrentGenerationSynchronized = SubscriptionRef.get(supervisor.state).pipe(
    Effect.flatMap((connectionState) =>
      Ref.set(synchronizedGeneration, Option.some(connectionState.generation)),
    ),
  );
  const setConnectionSynchronizing = (connectionState: SupervisorConnectionState) =>
    Ref.get(synchronizedGeneration).pipe(
      Effect.flatMap((completed) =>
        Option.isSome(completed) && completed.value === connectionState.generation
          ? Effect.void
          : setSynchronizing,
      ),
    );
  const setReady = (connectionState: SupervisorConnectionState) =>
    Ref.get(synchronizedGeneration).pipe(
      Effect.flatMap((completed) =>
        SubscriptionRef.update(state, (current) => {
          if (current.status === "deleted") return current;
          const synchronized =
            Option.isSome(completed) && completed.value === connectionState.generation;
          return {
            ...current,
            status:
              synchronized && Option.isSome(current.data)
                ? ("live" as const)
                : ("synchronizing" as const),
            error: Option.none(),
          };
        }),
      ),
    );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    if (!waiting) {
      yield* markCurrentGenerationSynchronized;
    }
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: waiting ? "synchronizing" : "live",
      error: Option.none(),
    });
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, { snapshotSequence, thread });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    if (item.kind === "resync-required") {
      yield* Ref.set(forceSnapshot, true);
      yield* Ref.set(synchronizedGeneration, Option.none());
      yield* setSynchronizing;
      yield* Queue.offer(resubscribeRequests, undefined);
      return;
    }

    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* markCurrentGenerationSynchronized;
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      yield* Ref.set(forceSnapshot, false);
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* setThread(item.snapshot.thread);
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);

    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    const result = applyThreadDetailEvent(current.data.value, item.event);
    if (result.kind === "updated") {
      yield* setThread(result.thread);
    } else if (result.kind === "deleted") {
      yield* setDeleted();
    }
  });

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach(() =>
      // State changes can queue while the browser is suspended. Apply the
      // latest state when the fiber resumes instead of replaying stale phases.
      SubscriptionRef.get(supervisor.state).pipe(
        Effect.flatMap((connectionState) => {
          switch (connectionProjectionPhase(connectionState)) {
            case "synchronizing":
              return setConnectionSynchronizing(connectionState);
            case "disconnected":
              return setDisconnected;
            case "ready":
              return setReady(connectionState);
          }
        }),
      ),
    ),
    Effect.forkScoped,
  );

  // A zombie server-side subscription (live deltas silently dropped) can only
  // be repaired by resubscribing, so app-foreground wakeups force one — but
  // only while the stream is not demonstrably healthy, so returning to a live
  // thread never thrashes a full snapshot reload and a deleted thread is
  // never resurrected.
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const foregroundResubscriptions: Stream.Stream<unknown> = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(
        Stream.filter((reason) => reason === "application-active"),
        Stream.filterEffect(() =>
          SubscriptionRef.get(state).pipe(
            Effect.map((current) => current.status !== "live" && current.status !== "deleted"),
          ),
        ),
      ),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(synchronizedGeneration, Option.none());
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        let current = yield* SubscriptionRef.get(state);
        const mustLoadSnapshot = yield* Ref.get(forceSnapshot);
        if ((mustLoadSnapshot || Option.isNone(current.data)) && current.status !== "deleted") {
          // Bounded, and never fatal. `Stream.runHead` yields `None` when the
          // supervisor's scope closes mid-reconnect, and `Option.getOrThrow`
          // turned that into a defect that killed this fiber for good — leaving
          // the thread in `synchronizing` with no request ever reaching the
          // server, which the UI renders as a permanent "Syncing messages...".
          // Falling back to `None` just skips the optimisation and lets the
          // subscription's first frame carry the snapshot instead.
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: (value) => Effect.succeed(Option.some(value)),
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                  ),
              }),
            ),
            Effect.timeoutOption(PREPARED_CONNECTION_WAIT),
            Effect.map(Option.flatten),
            Effect.orElseSucceed(() => Option.none<PreparedConnection>()),
          );
          if (Option.isSome(prepared)) {
            const httpSnapshot = yield* snapshotLoader.load(prepared.value, threadId);
            if (Option.isSome(httpSnapshot)) {
              yield* applyItem({ kind: "snapshot", snapshot: httpSnapshot.value });
              current = yield* SubscriptionRef.get(state);
            }
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data) && !(yield* Ref.get(forceSnapshot));
        if (!supportsCompletionMarker && canResume) {
          yield* markCurrentGenerationSynchronized;
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: Stream.merge(
          Stream.fromQueue(resubscribeRequests) as Stream.Stream<unknown>,
          foregroundResubscriptions,
        ),
      },
    ).pipe(Stream.runForEach(applyItem)),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            shouldPersistThread(thread) ? persist({ snapshotSequence, thread }) : Effect.void,
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";

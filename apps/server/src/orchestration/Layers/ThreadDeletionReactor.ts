import type { ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadArtifactService } from "../../artifacts/ThreadArtifactService.ts";
import {
  listUnfinishedThreadDeletions,
  purgeDeletedThreadPersistence,
} from "../../persistence/DeletedThreadPersistence.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

/** Shared constructor keeps deletion cleanup tests on the same drainable queue as production. */
export const makeThreadDeletionWorker = <R, E>(
  process: (threadId: ThreadId) => Effect.Effect<void, E, R>,
) => makeDrainableWorker(process);

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadId;
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const threadArtifacts = yield* ThreadArtifactService;

  const stopProviderSession = (threadId: ThreadId) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadId) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const deleteThreadArtifacts = (threadId: ThreadId) =>
    logCleanupCauseUnlessInterrupted({
      effect: threadArtifacts.cleanupDeletedThread(threadId).pipe(Effect.asVoid),
      message: "thread deletion cleanup skipped artifact removal",
      threadId,
    });

  const purgeThreadPersistence = (threadId: ThreadId) =>
    logCleanupCauseUnlessInterrupted({
      effect: purgeDeletedThreadPersistence(threadId),
      message: "thread deletion cleanup skipped persisted conversation purge",
      threadId,
    });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (threadId: ThreadId) {
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* deleteThreadArtifacts(threadId);
    yield* purgeThreadPersistence(threadId);
  });

  const processThreadDeletedSafely = (threadId: ThreadId) =>
    processThreadDeleted(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to clean up a deleted thread", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeThreadDeletionWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event.payload.threadId);
      }),
    );
    // The stream offers each deletion once. One whose cleanup a restart cut
    // short, or that failed, keeps its row marked deleted with its history
    // intact, so finish those on every start.
    const unfinished = yield* listUnfinishedThreadDeletions().pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catch((cause) =>
        Effect.logWarning("thread deletion reactor could not list unfinished deletions", {
          cause,
        }).pipe(Effect.as<ReadonlyArray<ThreadId>>([])),
      ),
    );
    yield* Effect.forEach(unfinished, (threadId) => worker.enqueue(threadId), { discard: true });
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);

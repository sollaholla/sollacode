import { CommandId, EventId, type OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  logCleanupCauseUnlessInterrupted,
  makeThreadDeletionWorker,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });

  it.effect("drains queued deleted-thread cleanup without sleeps", () =>
    Effect.gen(function* () {
      const processed: string[] = [];
      const worker = yield* makeThreadDeletionWorker((event) =>
        Effect.sync(() => {
          processed.push(event.payload.threadId);
        }),
      );
      const event = {
        sequence: 1,
        type: "thread.deleted",
        eventId: EventId.make("event-artifact-cleanup"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-08-21T00:00:00.000Z",
        commandId: CommandId.make("command-artifact-cleanup"),
        causationEventId: null,
        correlationId: CommandId.make("command-artifact-cleanup"),
        metadata: {},
        payload: {
          threadId,
          deletedAt: "2026-08-21T00:00:00.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;

      yield* worker.enqueue(event);
      yield* worker.drain;
      expect(processed).toEqual([threadId]);
    }),
  );
});

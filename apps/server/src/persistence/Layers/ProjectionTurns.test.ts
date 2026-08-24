import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

it.layer(ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "ProjectionTurnRepository pending queue",
  (it) => {
    it.effect("upserts exact messages and consumes the deterministic FIFO head", () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionTurnRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-pending-queue");
        const messageB = MessageId.make("message-b");
        const messageA = MessageId.make("message-a");
        const requestedAt = "2026-08-24T20:00:00.000Z";

        yield* repository.upsertPendingTurnStart({
          threadId,
          messageId: messageB,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt,
        });
        yield* repository.upsertPendingTurnStart({
          threadId,
          messageId: messageA,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt,
        });
        // Replaying B refreshes B only; it cannot replace or duplicate A.
        yield* repository.upsertPendingTurnStart({
          threadId,
          messageId: messageB,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: "plan-b",
          requestedAt,
        });

        const rows = yield* sql<{ readonly messageId: string }>`
          SELECT pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NULL AND state = 'pending'
          ORDER BY pending_message_id ASC
        `;
        assert.deepEqual(rows, [{ messageId: messageA }, { messageId: messageB }]);

        const oldest = yield* repository.getOldestPendingTurnStartByThreadId({ threadId });
        assert.equal(Option.getOrThrow(oldest).messageId, messageA);
        const exactB = yield* repository.getPendingTurnStart({
          threadId,
          messageId: messageB,
        });
        assert.equal(Option.getOrThrow(exactB).sourceProposedPlanId, "plan-b");

        yield* repository.deletePendingTurnStart({ threadId, messageId: messageA });
        assert.equal(
          Option.getOrThrow(yield* repository.getOldestPendingTurnStartByThreadId({ threadId }))
            .messageId,
          messageB,
        );
      }),
    );
  },
);

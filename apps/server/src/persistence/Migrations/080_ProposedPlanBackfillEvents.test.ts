import { ThreadProposedPlanUpsertedPayload } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const decodePayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(ThreadProposedPlanUpsertedPayload),
);

it.layer(NodeSqliteClient.layerMemory())("080_ProposedPlanBackfillEvents", (it) => {
  it.effect("publishes plan states that only the projection knew", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });

      for (const [threadId, deletedAt] of [
        ["thread-live", null],
        ["thread-deleted", "2026-10-09T00:00:00.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, latest_turn_id, created_at, updated_at,
            has_actionable_proposed_plan, deleted_at
          ) VALUES (
            ${threadId}, 'project-1', ${threadId}, '{"instanceId":"claudeAgent","model":"opus"}',
            'full-access', 'agent', NULL, '2026-10-05T00:00:00.000Z',
            '2026-10-05T00:00:00.000Z', 0, ${deletedAt}
          )
        `;
      }

      const insertPlan = (input: {
        readonly planId: string;
        readonly threadId: string;
        readonly implementedAt?: string;
        readonly closedAt?: string;
      }) => sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at,
          implemented_at, implementation_thread_id, closed_at
        ) VALUES (
          ${input.planId}, ${input.threadId}, 'turn-plan', ${`# ${input.planId}`},
          '2026-10-05T20:00:00.000Z', '2026-10-05T20:00:00.000Z',
          ${input.implementedAt ?? null},
          ${input.implementedAt === undefined ? null : input.threadId},
          ${input.closedAt ?? null}
        )
      `;
      // Marked implemented by 079 alone: its only event still says waiting.
      yield* insertPlan({
        planId: "plan-backfilled",
        threadId: "thread-live",
        implementedAt: "2026-10-06T00:28:53.953Z",
      });
      // Implemented through an event already; nothing to publish.
      yield* insertPlan({
        planId: "plan-published",
        threadId: "thread-live",
        implementedAt: "2026-10-06T01:00:00.000Z",
      });
      yield* insertPlan({
        planId: "plan-closed",
        threadId: "thread-live",
        closedAt: "2026-10-06T02:00:00.000Z",
      });
      // Still waiting: there is no state to publish.
      yield* insertPlan({ planId: "plan-open", threadId: "thread-live" });
      yield* insertPlan({
        planId: "plan-on-deleted-thread",
        threadId: "thread-deleted",
        implementedAt: "2026-10-06T00:00:00.000Z",
      });

      let streamVersion = 0;
      const planEvent = (planId: string, implementedAt: string | null) =>
        Effect.gen(function* () {
          streamVersion += 1;
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          const payloadJson = JSON.stringify({
            threadId: "thread-live",
            proposedPlan: {
              id: planId,
              turnId: "turn-plan",
              planMarkdown: `# ${planId}`,
              implementedAt,
              implementationThreadId: implementedAt === null ? null : "thread-live",
              createdAt: "2026-10-05T20:00:00.000Z",
              updatedAt: "2026-10-05T20:00:00.000Z",
            },
          });
          yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json,
              metadata_json
            ) VALUES (
              ${`event-${streamVersion}`}, 'thread', 'thread-live', ${streamVersion},
              'thread.proposed-plan-upserted', '2026-10-05T20:00:00.000Z', NULL, NULL, NULL,
              'provider', ${payloadJson}, '{}'
            )
          `;
        });
      yield* planEvent("plan-backfilled", null);
      yield* planEvent("plan-published", null);
      yield* planEvent("plan-published", "2026-10-06T01:00:00.000Z");
      yield* planEvent("plan-closed", null);

      yield* runMigrations({ toMigrationInclusive: 80 });

      const published = yield* sql<{
        readonly eventId: string;
        readonly streamVersion: number;
        readonly actorKind: string;
        readonly payloadJson: string;
      }>`
        SELECT
          event_id AS "eventId",
          stream_version AS "streamVersion",
          actor_kind AS "actorKind",
          payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE event_id LIKE 'migration-080:%'
        ORDER BY sequence
      `;
      assert.deepEqual(
        published.map(({ eventId, streamVersion, actorKind }) => ({
          eventId,
          streamVersion,
          actorKind,
        })),
        [
          { eventId: "migration-080:plan-backfilled", streamVersion: 5, actorKind: "server" },
          { eventId: "migration-080:plan-closed", streamVersion: 6, actorKind: "server" },
        ],
      );
      // Each event is a valid upsert carrying exactly the projection's plan.
      assert.deepEqual(decodePayload(published[0]?.payloadJson), {
        threadId: "thread-live",
        proposedPlan: {
          id: "plan-backfilled",
          turnId: "turn-plan",
          planMarkdown: "# plan-backfilled",
          implementedAt: "2026-10-06T00:28:53.953Z",
          implementationThreadId: "thread-live",
          closedAt: null,
          createdAt: "2026-10-05T20:00:00.000Z",
          updatedAt: "2026-10-05T20:00:00.000Z",
        },
      } as never);
      assert.equal(
        decodePayload(published[1]?.payloadJson).proposedPlan.closedAt,
        "2026-10-06T02:00:00.000Z",
      );
    }),
  );
});

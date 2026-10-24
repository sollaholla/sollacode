import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("079_ProposedPlanClosedAt", (it) => {
  it.effect("marks plans a person approved by moving on, and recomputes who waits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });

      const threads = [
        // Built by switching to Agent mode (the ARCore report): implemented.
        ["thread-built", "plan"],
        // Still being refined in Plan mode: keeps waiting.
        ["thread-refining", "plan"],
        // Only a housekeeping turn followed: keeps waiting.
        ["thread-housekeeping", "agent"],
        // Moved on from the older plan, then later proposed and approved a new
        // one: both implemented, each by the message that followed it.
        ["thread-superseded", "plan"],
        // Replaced by a newer plan before anyone acted: stays open, superseded.
        ["thread-replaced", "plan"],
        // Only a resume, another agent's question and a delegated run followed:
        // none of them is the person, so it keeps waiting.
        ["thread-not-the-person", "default"],
        // The orchestrator relayed the person's go-ahead: implemented.
        ["thread-orchestrated", "default"],
      ] as const;
      for (const [threadId, interactionMode] of threads) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, latest_turn_id, created_at, updated_at,
            has_actionable_proposed_plan
          ) VALUES (
            ${threadId}, 'project-1', ${threadId}, '{"instanceId":"claudeAgent","model":"opus"}',
            'full-access', ${interactionMode}, 'turn-later', '2026-10-05T00:00:00.000Z',
            '2026-10-05T00:00:00.000Z', 0
          )
        `;
      }

      const insertPlan = (planId: string, threadId: string, createdAt: string) => sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at, implemented_at
        ) VALUES (${planId}, ${threadId}, 'turn-plan', '# Plan', ${createdAt}, ${createdAt}, NULL)
      `;
      yield* insertPlan("plan-built", "thread-built", "2026-10-05T23:02:25.000Z");
      yield* insertPlan("plan-refining", "thread-refining", "2026-10-05T23:02:25.000Z");
      yield* insertPlan("plan-housekeeping", "thread-housekeeping", "2026-10-05T23:02:25.000Z");
      yield* insertPlan("plan-older", "thread-superseded", "2026-10-05T20:00:00.000Z");
      yield* insertPlan("plan-newest", "thread-superseded", "2026-10-05T23:02:25.000Z");
      yield* insertPlan("plan-replaced", "thread-replaced", "2026-10-05T20:00:00.000Z");
      yield* insertPlan("plan-replacement", "thread-replaced", "2026-10-05T23:02:25.000Z");
      yield* insertPlan("plan-not-the-person", "thread-not-the-person", "2026-10-05T23:02:25.000Z");
      yield* insertPlan("plan-orchestrated", "thread-orchestrated", "2026-10-05T23:02:25.000Z");

      let streamVersion = 0;
      const turnStart = (input: {
        readonly threadId: string;
        readonly messageId: string;
        readonly interactionMode: string;
        readonly occurredAt: string;
        readonly inputOrigin?: string;
        readonly text?: string;
        readonly senderThreadId?: string;
        readonly delegationId?: string;
      }) =>
        Effect.gen(function* () {
          streamVersion += 1;
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          const payloadJson = JSON.stringify({
            threadId: input.threadId,
            messageId: input.messageId,
            interactionMode: input.interactionMode,
          });
          yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json,
              metadata_json
            ) VALUES (
              ${`event-${streamVersion}`}, 'thread', ${input.threadId}, ${streamVersion},
              'thread.turn-start-requested', ${input.occurredAt}, NULL, NULL, NULL, 'client',
              ${payloadJson}, '{}'
            )
          `;
          yield* sql`
            INSERT INTO projection_thread_messages (
              message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at,
              input_origin, sender_thread_id, delegation_id
            ) VALUES (
              ${input.messageId}, ${input.threadId}, NULL, 'user', ${input.text ?? "message"}, 0,
              ${input.occurredAt}, ${input.occurredAt}, ${input.inputOrigin ?? null},
              ${input.senderThreadId ?? null}, ${input.delegationId ?? null}
            )
          `;
        });

      // The turn that proposed the plan does not count: it came before it.
      yield* turnStart({
        threadId: "thread-built",
        messageId: "message-before",
        interactionMode: "default",
        occurredAt: "2026-10-05T22:05:22.000Z",
      });
      yield* turnStart({
        threadId: "thread-built",
        messageId: "message-agent-mode",
        interactionMode: "agent",
        occurredAt: "2026-10-06T00:28:53.000Z",
      });
      yield* turnStart({
        threadId: "thread-refining",
        messageId: "message-question",
        interactionMode: "plan",
        occurredAt: "2026-10-06T00:28:53.000Z",
      });
      // Build message while plan-older was newest: implements it.
      yield* turnStart({
        threadId: "thread-superseded",
        messageId: "message-build-old",
        interactionMode: "default",
        occurredAt: "2026-10-05T21:00:00.000Z",
      });
      // Build message after plan-newest: implements plan-newest only.
      yield* turnStart({
        threadId: "thread-superseded",
        messageId: "message-build-new",
        interactionMode: "default",
        occurredAt: "2026-10-06T09:00:00.000Z",
      });
      yield* turnStart({
        threadId: "thread-replaced",
        messageId: "message-build-after-replacement",
        interactionMode: "default",
        occurredAt: "2026-10-06T09:00:00.000Z",
      });
      yield* turnStart({
        threadId: "thread-housekeeping",
        messageId: "browser-tab-cleanup-message:thread-housekeeping:turn-plan",
        interactionMode: "agent",
        occurredAt: "2026-10-06T00:28:53.000Z",
        inputOrigin: "agent-loop",
      });
      yield* turnStart({
        threadId: "thread-not-the-person",
        messageId: "message-resume",
        interactionMode: "default",
        occurredAt: "2026-10-06T00:00:00.000Z",
        text: "Please resume your current task using the context provided and pick up exactly where you left off.",
      });
      yield* turnStart({
        threadId: "thread-not-the-person",
        messageId: "message-consult",
        interactionMode: "default",
        occurredAt: "2026-10-06T01:00:00.000Z",
        senderThreadId: "consulting-agent-thread",
      });
      yield* turnStart({
        threadId: "thread-not-the-person",
        messageId: "message-delegated",
        interactionMode: "default",
        occurredAt: "2026-10-06T02:00:00.000Z",
        delegationId: "delegation-1",
      });
      yield* turnStart({
        threadId: "thread-orchestrated",
        messageId: "message-orchestrator",
        interactionMode: "default",
        occurredAt: "2026-10-06T03:00:00.000Z",
        senderThreadId: "solla-orchestrator",
      });

      yield* runMigrations({ toMigrationInclusive: 79 });

      const plans = yield* sql<{
        readonly planId: string;
        readonly implementedAt: string | null;
        readonly implementationThreadId: string | null;
        readonly closedAt: string | null;
      }>`
        SELECT
          plan_id AS "planId",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          closed_at AS "closedAt"
        FROM projection_thread_proposed_plans
        ORDER BY plan_id
      `;
      const implemented = (threadId: string, at: string) => ({
        implementedAt: at,
        implementationThreadId: threadId,
        closedAt: null,
      });
      const open = { implementedAt: null, implementationThreadId: null, closedAt: null };
      assert.deepEqual(plans, [
        { planId: "plan-built", ...implemented("thread-built", "2026-10-06T00:28:53.000Z") },
        { planId: "plan-housekeeping", ...open },
        {
          planId: "plan-newest",
          ...implemented("thread-superseded", "2026-10-06T09:00:00.000Z"),
        },
        { planId: "plan-not-the-person", ...open },
        {
          planId: "plan-older",
          ...implemented("thread-superseded", "2026-10-05T21:00:00.000Z"),
        },
        {
          planId: "plan-orchestrated",
          ...implemented("thread-orchestrated", "2026-10-06T03:00:00.000Z"),
        },
        { planId: "plan-refining", ...open },
        { planId: "plan-replaced", ...open },
        {
          planId: "plan-replacement",
          ...implemented("thread-replaced", "2026-10-06T09:00:00.000Z"),
        },
      ]);

      const flags = yield* sql<{ readonly threadId: string; readonly waiting: number }>`
        SELECT thread_id AS "threadId", has_actionable_proposed_plan AS "waiting"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepEqual(flags, [
        { threadId: "thread-built", waiting: 0 },
        { threadId: "thread-housekeeping", waiting: 1 },
        { threadId: "thread-not-the-person", waiting: 1 },
        { threadId: "thread-orchestrated", waiting: 0 },
        { threadId: "thread-refining", waiting: 1 },
        { threadId: "thread-replaced", waiting: 0 },
        { threadId: "thread-superseded", waiting: 0 },
      ]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const createdAt = "2026-08-21T20:00:00.000Z";
const expiresAt = "2026-08-21T20:30:00.000Z";
const snapshot = JSON.stringify({
  vmAgentId: "source-agent",
  name: "Source",
  handle: "source",
});
const limits = JSON.stringify({
  maxDepth: 1,
  maxActiveChildren: 3,
  maxChildDelegations: 0,
  maxFollowups: 5,
  maxMessages: 200,
  wallClockMinutes: 30,
});

layer("053_VmAgentCollaboration", (it) => {
  it.effect("retains and terminalizes delegation history when an agent is deleted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* runMigrations({ toMigrationInclusive: 53 });

      yield* sql`INSERT INTO vm_agents (
        vm_agent_id, name, name_lower, handle, purpose, vm_id, status,
        control_mode, guest_ip, last_error, created_at, updated_at, thread_id
      ) VALUES (
        'source-agent', 'Source', 'source', 'source', 'Delegate work', 'source-vm',
        'running', 'agent', NULL, NULL, ${createdAt}, ${createdAt}, 'source-thread'
      )`;
      yield* sql`INSERT INTO vm_agent_delegations (
        delegation_id, root_vm_agent_id, source_vm_agent_id, root_delegation_id,
        parent_delegation_id, depth, target_json, target_vm_agent_id, worker_thread_id,
        root_agent_snapshot_json, source_agent_snapshot_json, target_agent_snapshot_json,
        task_id, run_id, idempotency_key, title, task, completion_criteria_json,
        requested_capabilities_json, status, followup_count, message_count, limits_json,
        revision, created_at, started_at, completed_at, expires_at, updated_at,
        result_json, error
      ) VALUES (
        'delegation-one', 'source-agent', 'source-agent', NULL, NULL, 1,
        '{"kind":"ephemeral"}', NULL, 'delegation-worker:one',
        ${snapshot}, ${snapshot}, NULL, 'delegation-task:one', NULL, 'request-one',
        'Investigate', 'Investigate the issue', '[]', '["workspace.consult"]',
        'running', 0, 1, ${limits}, 1, ${createdAt}, ${createdAt}, NULL,
        ${expiresAt}, ${createdAt}, NULL, NULL
      )`;
      yield* sql`INSERT INTO vm_agent_delegation_messages (
        message_id, delegation_id, sequence, sender, sender_vm_agent_id,
        kind, delivery, text, created_at
      ) VALUES (
        'message-one', 'delegation-one', 1, 'source-agent', 'source-agent',
        'note', 'delivered', 'Investigate the issue', ${createdAt}
      )`;
      yield* sql`INSERT INTO vm_agent_delegation_events (
        event_id, delegation_id, sequence, event_type, payload_json, created_at
      ) VALUES (
        'event-one', 'delegation-one', 1, 'delegation.created', '{}', ${createdAt}
      )`;

      yield* sql`DELETE FROM vm_agents WHERE vm_agent_id = 'source-agent'`;

      const delegations = yield* sql<{
        readonly status: string;
        readonly sourceSnapshot: string;
        readonly error: string | null;
      }>`SELECT status, source_agent_snapshot_json AS "sourceSnapshot", error
          FROM vm_agent_delegations WHERE delegation_id = 'delegation-one'`;
      const messageCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM vm_agent_delegation_messages
        WHERE delegation_id = 'delegation-one'
      `;
      const eventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM vm_agent_delegation_events
        WHERE delegation_id = 'delegation-one'
      `;

      assert.strictEqual(delegations[0]?.status, "failed");
      assert.strictEqual(delegations[0]?.sourceSnapshot, snapshot);
      assert.include(delegations[0]?.error ?? "", "was deleted");
      assert.strictEqual(messageCount[0]?.count, 1);
      assert.strictEqual(eventCount[0]?.count, 1);
    }),
  );

  it.effect("enforces source-scoped idempotency and unique worker/task links", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      const insert = (input: {
        readonly delegationId: string;
        readonly sourceId: string;
        readonly taskId: string;
        readonly workerThreadId: string;
        readonly idempotencyKey: string;
      }) => sql`INSERT INTO vm_agent_delegations (
        delegation_id, root_vm_agent_id, source_vm_agent_id, root_delegation_id,
        parent_delegation_id, depth, target_json, target_vm_agent_id, worker_thread_id,
        root_agent_snapshot_json, source_agent_snapshot_json, target_agent_snapshot_json,
        task_id, run_id, idempotency_key, title, task, completion_criteria_json,
        requested_capabilities_json, status, followup_count, message_count, limits_json,
        revision, created_at, started_at, completed_at, expires_at, updated_at,
        result_json, error
      ) VALUES (
        ${input.delegationId}, ${input.sourceId}, ${input.sourceId}, NULL, NULL, 1,
        '{"kind":"ephemeral"}', NULL, ${input.workerThreadId}, ${snapshot}, ${snapshot},
        NULL, ${input.taskId}, NULL, ${input.idempotencyKey}, 'Investigate',
        'Investigate', '[]', '[]', 'queued', 0, 1, ${limits}, 1, ${createdAt},
        NULL, NULL, ${expiresAt}, ${createdAt}, NULL, NULL
      )`;

      yield* insert({
        delegationId: "delegation-idempotency-one",
        sourceId: "source-one",
        taskId: "task-idempotency-one",
        workerThreadId: "worker-idempotency-one",
        idempotencyKey: "same-key",
      });
      yield* insert({
        delegationId: "delegation-idempotency-two",
        sourceId: "source-two",
        taskId: "task-idempotency-two",
        workerThreadId: "worker-idempotency-two",
        idempotencyKey: "same-key",
      });

      const duplicateSource = yield* Effect.exit(
        insert({
          delegationId: "delegation-idempotency-three",
          sourceId: "source-one",
          taskId: "task-idempotency-three",
          workerThreadId: "worker-idempotency-three",
          idempotencyKey: "same-key",
        }),
      );
      const duplicateWorker = yield* Effect.exit(
        insert({
          delegationId: "delegation-idempotency-four",
          sourceId: "source-four",
          taskId: "task-idempotency-four",
          workerThreadId: "worker-idempotency-one",
          idempotencyKey: "request-four",
        }),
      );
      const duplicateTask = yield* Effect.exit(
        insert({
          delegationId: "delegation-idempotency-five",
          sourceId: "source-five",
          taskId: "task-idempotency-one",
          workerThreadId: "worker-idempotency-five",
          idempotencyKey: "request-five",
        }),
      );

      assert.isTrue(Exit.isFailure(duplicateSource));
      assert.isTrue(Exit.isFailure(duplicateWorker));
      assert.isTrue(Exit.isFailure(duplicateTask));
    }),
  );
});

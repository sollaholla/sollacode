import {
  VmAgentCollaborationCapability,
  VmAgentDelegation,
  VmAgentDelegationId,
  VmAgentDelegationLimits,
  VmAgentDelegationMessage,
  VmAgentDelegationMessageId,
  VmAgentDelegationResult,
  VmAgentDelegationTarget,
  VmAgentId,
  VmAgentIdentitySnapshot,
  VmAgentTaskCompletionCriteria,
  VmAgentTaskId,
  VmAgentTaskRunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  type AppendVmAgentDelegationMessageInput,
  type CompleteVmAgentDelegationInput,
  type CreateVmAgentDelegationInput,
  VmAgentCollaborationStore,
  type VmAgentCollaborationStoreShape,
} from "../Services/VmAgentCollaborations.ts";

const DelegationDb = VmAgentDelegation.mapFields(
  Struct.assign({
    target: Schema.fromJsonString(VmAgentDelegationTarget),
    rootAgentSnapshot: Schema.fromJsonString(VmAgentIdentitySnapshot),
    sourceAgentSnapshot: Schema.fromJsonString(VmAgentIdentitySnapshot),
    targetAgentSnapshot: Schema.NullOr(Schema.fromJsonString(VmAgentIdentitySnapshot)),
    completionCriteria: Schema.fromJsonString(VmAgentTaskCompletionCriteria),
    requestedCapabilities: Schema.fromJsonString(Schema.Array(VmAgentCollaborationCapability)),
    effectiveLimits: Schema.fromJsonString(VmAgentDelegationLimits),
    result: Schema.NullOr(Schema.fromJsonString(VmAgentDelegationResult)),
  }),
);

const DelegationRef = Schema.Struct({ delegationId: VmAgentDelegationId });
const TaskRef = Schema.Struct({ taskId: VmAgentTaskId });
const RunRef = Schema.Struct({ runId: VmAgentTaskRunId });
const SourceKey = Schema.Struct({ sourceVmAgentId: VmAgentId, idempotencyKey: Schema.String });
const AgentRef = Schema.Struct({ vmAgentId: VmAgentId });
const ThreadRef = Schema.Struct({ threadId: Schema.String });
const encodeDelegationResult = Schema.encodeSync(Schema.fromJsonString(VmAgentDelegationResult));

const delegationColumns = (sql: SqlClient.SqlClient) => sql`
  delegation_id AS "delegationId", root_vm_agent_id AS "rootVmAgentId",
  source_vm_agent_id AS "sourceVmAgentId", root_delegation_id AS "rootDelegationId",
  parent_delegation_id AS "parentDelegationId", depth, target_json AS "target",
  target_vm_agent_id AS "targetVmAgentId", worker_thread_id AS "workerThreadId",
  root_agent_snapshot_json AS "rootAgentSnapshot",
  source_agent_snapshot_json AS "sourceAgentSnapshot",
  target_agent_snapshot_json AS "targetAgentSnapshot", task_id AS "taskId",
  run_id AS "runId", title, task, completion_criteria_json AS "completionCriteria",
  requested_capabilities_json AS "requestedCapabilities", status,
  followup_count AS "followupCount", message_count AS "messageCount",
  limits_json AS "effectiveLimits", revision, created_at AS "createdAt",
  started_at AS "startedAt", completed_at AS "completedAt", expires_at AS "expiresAt",
  updated_at AS "updatedAt", result_json AS "result", error
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mapError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`VmAgentCollaborationStore.${operation}:query`));

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DelegationDb,
    execute: () => sql`SELECT ${delegationColumns(sql)} FROM vm_agent_delegations
      ORDER BY updated_at DESC, delegation_id DESC LIMIT 500`,
  });
  const listForAgentRows = SqlSchema.findAll({
    Request: AgentRef,
    Result: DelegationDb,
    execute: ({ vmAgentId }) => sql`SELECT ${delegationColumns(sql)} FROM vm_agent_delegations
      WHERE root_vm_agent_id = ${vmAgentId} OR source_vm_agent_id = ${vmAgentId}
         OR target_vm_agent_id = ${vmAgentId}
      ORDER BY updated_at DESC, delegation_id DESC LIMIT 500`,
  });
  const getByIdRow = SqlSchema.findOneOption({
    Request: DelegationRef,
    Result: DelegationDb,
    execute: ({ delegationId }) => sql`SELECT ${delegationColumns(sql)}
      FROM vm_agent_delegations WHERE delegation_id = ${delegationId}`,
  });
  const getByTaskRow = SqlSchema.findOneOption({
    Request: TaskRef,
    Result: DelegationDb,
    execute: ({ taskId }) => sql`SELECT ${delegationColumns(sql)}
      FROM vm_agent_delegations WHERE task_id = ${taskId}`,
  });
  const getByRunRow = SqlSchema.findOneOption({
    Request: RunRef,
    Result: DelegationDb,
    execute: ({ runId }) => sql`SELECT ${delegationColumns(sql)}
      FROM vm_agent_delegations WHERE run_id = ${runId}`,
  });
  const getByWorkerThreadRow = SqlSchema.findOneOption({
    Request: ThreadRef,
    Result: DelegationDb,
    execute: ({ threadId }) => sql`SELECT ${delegationColumns(sql)}
      FROM vm_agent_delegations WHERE worker_thread_id = ${threadId}
      ORDER BY created_at DESC LIMIT 1`,
  });
  const getBySourceKeyRow = SqlSchema.findOneOption({
    Request: SourceKey,
    Result: DelegationDb,
    execute: ({ sourceVmAgentId, idempotencyKey }) => sql`SELECT ${delegationColumns(sql)}
      FROM vm_agent_delegations
      WHERE source_vm_agent_id = ${sourceVmAgentId} AND idempotency_key = ${idempotencyKey}`,
  });
  const listMessageRows = SqlSchema.findAll({
    Request: DelegationRef,
    Result: VmAgentDelegationMessage,
    execute: ({ delegationId }) => sql`
      SELECT message_id AS "messageId", delegation_id AS "delegationId", sequence,
             sender, sender_vm_agent_id AS "senderVmAgentId", kind, delivery, text,
             created_at AS "createdAt"
      FROM vm_agent_delegation_messages WHERE delegation_id = ${delegationId}
      ORDER BY sequence ASC LIMIT 200`,
  });

  const insertTask = SqlSchema.void({
    Request: Schema.Struct({
      taskId: VmAgentTaskId,
      schedulerVmAgentId: VmAgentId,
      title: VmAgentDelegation.fields.title,
      task: VmAgentDelegation.fields.task,
      completionCriteria: Schema.fromJsonString(VmAgentTaskCompletionCriteria),
      delegationId: VmAgentDelegationId,
      createdAt: VmAgentDelegation.fields.createdAt,
    }),
    execute: (input) => sql`INSERT INTO vm_agent_tasks (
      task_id, vm_agent_id, title, prompt, completion_criteria_json, status,
      schedule_json, next_run_at, created_by, approval_state, notification_policy,
      artifact_id, created_at, updated_at, delegation_id
    ) VALUES (
      ${input.taskId}, ${input.schedulerVmAgentId}, ${input.title}, ${input.task},
      ${input.completionCriteria}, 'active',
      ${JSON.stringify({ kind: "once", runAt: input.createdAt })}, ${input.createdAt},
      'agent', 'approved', 'never', NULL, ${input.createdAt}, ${input.createdAt},
      ${input.delegationId})`,
  });
  const insertDelegation = SqlSchema.void({
    Request: Schema.Struct({ delegation: DelegationDb, idempotencyKey: Schema.String }),
    execute: ({ delegation, idempotencyKey }) => sql`INSERT INTO vm_agent_delegations (
      delegation_id, root_vm_agent_id, source_vm_agent_id, root_delegation_id,
      parent_delegation_id, depth, target_json, target_vm_agent_id, worker_thread_id,
      root_agent_snapshot_json, source_agent_snapshot_json, target_agent_snapshot_json,
      task_id, run_id, idempotency_key, title, task, completion_criteria_json,
      requested_capabilities_json, status, followup_count, message_count, limits_json,
      revision, created_at, started_at, completed_at, expires_at, updated_at, result_json, error
    ) VALUES (
      ${delegation.delegationId}, ${delegation.rootVmAgentId}, ${delegation.sourceVmAgentId},
      ${delegation.rootDelegationId}, ${delegation.parentDelegationId}, ${delegation.depth},
      ${delegation.target}, ${delegation.targetVmAgentId}, ${delegation.workerThreadId},
      ${delegation.rootAgentSnapshot}, ${delegation.sourceAgentSnapshot},
      ${delegation.targetAgentSnapshot}, ${delegation.taskId}, ${delegation.runId},
      ${idempotencyKey}, ${delegation.title}, ${delegation.task},
      ${delegation.completionCriteria}, ${delegation.requestedCapabilities},
      ${delegation.status}, ${delegation.followupCount}, ${delegation.messageCount},
      ${delegation.effectiveLimits}, ${delegation.revision}, ${delegation.createdAt},
      ${delegation.startedAt}, ${delegation.completedAt}, ${delegation.expiresAt},
      ${delegation.updatedAt}, ${delegation.result}, ${delegation.error})`,
  });
  const insertMessage = SqlSchema.void({
    Request: VmAgentDelegationMessage,
    execute: (message) => sql`INSERT INTO vm_agent_delegation_messages (
      message_id, delegation_id, sequence, sender, sender_vm_agent_id, kind, delivery,
      text, created_at
    ) VALUES (${message.messageId}, ${message.delegationId}, ${message.sequence},
      ${message.sender}, ${message.senderVmAgentId}, ${message.kind}, ${message.delivery},
      ${message.text}, ${message.createdAt})`,
  });
  const insertEvent = (input: {
    readonly delegationId: VmAgentDelegationId;
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  }) => sql`INSERT INTO vm_agent_delegation_events (
      event_id, delegation_id, sequence, event_type, payload_json, created_at
    ) VALUES (
      'delegation-event:' || ${input.delegationId} || ':' ||
        (SELECT COALESCE(MAX(sequence), 0) + 1 FROM vm_agent_delegation_events
         WHERE delegation_id = ${input.delegationId}),
      ${input.delegationId},
      (SELECT COALESCE(MAX(sequence), 0) + 1 FROM vm_agent_delegation_events
       WHERE delegation_id = ${input.delegationId}),
      ${input.type}, ${JSON.stringify(input.payload)}, ${input.createdAt})`;

  const list: VmAgentCollaborationStoreShape["list"] = () =>
    listRows(undefined).pipe(mapError("list"));
  const listForAgent: VmAgentCollaborationStoreShape["listForAgent"] = (vmAgentId) =>
    listForAgentRows({ vmAgentId }).pipe(mapError("listForAgent"));
  const getById: VmAgentCollaborationStoreShape["getById"] = (delegationId) =>
    getByIdRow({ delegationId }).pipe(mapError("getById"));
  const getByTaskId: VmAgentCollaborationStoreShape["getByTaskId"] = (taskId) =>
    getByTaskRow({ taskId }).pipe(mapError("getByTaskId"));
  const getByRunId: VmAgentCollaborationStoreShape["getByRunId"] = (runId) =>
    getByRunRow({ runId }).pipe(mapError("getByRunId"));
  const getByWorkerThreadId: VmAgentCollaborationStoreShape["getByWorkerThreadId"] = (threadId) =>
    getByWorkerThreadRow({ threadId }).pipe(mapError("getByWorkerThreadId"));
  const getByIdempotencyKey: VmAgentCollaborationStoreShape["getByIdempotencyKey"] = (
    sourceVmAgentId,
    idempotencyKey,
  ) => getBySourceKeyRow({ sourceVmAgentId, idempotencyKey }).pipe(mapError("getByIdempotencyKey"));
  const listMessages: VmAgentCollaborationStoreShape["listMessages"] = (delegationId) =>
    listMessageRows({ delegationId }).pipe(mapError("listMessages"));

  const create: VmAgentCollaborationStoreShape["create"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* insertTask({
            taskId: input.delegation.taskId,
            schedulerVmAgentId: input.schedulerVmAgentId,
            title: input.delegation.title,
            task: input.delegation.task,
            completionCriteria: input.delegation.completionCriteria,
            delegationId: input.delegation.delegationId,
            createdAt: input.delegation.createdAt,
          });
          yield* insertDelegation({
            delegation: input.delegation,
            idempotencyKey: input.idempotencyKey,
          });
          yield* insertMessage(input.initialMessage);
          yield* insertEvent({
            delegationId: input.delegation.delegationId,
            type: "delegation.created",
            payload: {
              sourceVmAgentId: input.delegation.sourceVmAgentId,
              target: input.delegation.target,
              taskId: input.delegation.taskId,
            },
            createdAt: input.delegation.createdAt,
          });
          return input.delegation;
        }),
      )
      .pipe(mapError("create"));

  const markRunClaimed: VmAgentCollaborationStoreShape["markRunClaimed"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* getByTaskRow({ taskId: input.taskId });
          if (Option.isNone(row)) return;
          yield* sql`UPDATE vm_agent_delegations
        SET run_id = ${input.runId}, updated_at = ${input.updatedAt},
            revision = revision + 1
        WHERE delegation_id = ${row.value.delegationId}
          AND status IN ('pending-approval', 'queued')`;
          yield* insertEvent({
            delegationId: row.value.delegationId,
            type: "delegation.run-claimed",
            payload: { runId: input.runId },
            createdAt: input.updatedAt,
          });
        }),
      )
      .pipe(mapError("markRunClaimed"));

  const markRunning: VmAgentCollaborationStoreShape["markRunning"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* getByRunRow({ runId: input.runId });
          if (Option.isNone(row)) return;
          yield* sql`UPDATE vm_agent_delegations SET status = 'running',
        started_at = COALESCE(started_at, ${input.startedAt}), updated_at = ${input.startedAt},
        revision = revision + 1 WHERE delegation_id = ${row.value.delegationId}
        AND status IN ('pending-approval', 'queued', 'waiting-input', 'running')`;
          yield* sql`UPDATE projection_thread_messages SET delegation_id = ${row.value.delegationId}
        WHERE message_id = ${input.messageId}`;
          yield* insertEvent({
            delegationId: row.value.delegationId,
            type: "delegation.running",
            payload: { runId: input.runId, messageId: input.messageId },
            createdAt: input.startedAt,
          });
        }),
      )
      .pipe(mapError("markRunning"));

  const setWorkerThread: VmAgentCollaborationStoreShape["setWorkerThread"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE vm_agent_delegations SET worker_thread_id = ${input.threadId},
        updated_at = ${input.updatedAt}, revision = revision + 1
        WHERE delegation_id = ${input.delegationId}
        AND (worker_thread_id IS NULL OR worker_thread_id = ${input.threadId})`;
          yield* insertEvent({
            delegationId: input.delegationId,
            type: "delegation.worker-thread-bound",
            payload: { threadId: input.threadId },
            createdAt: input.updatedAt,
          });
        }),
      )
      .pipe(mapError("setWorkerThread"));

  const appendMessage: VmAgentCollaborationStoreShape["appendMessage"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* getByIdRow({ delegationId: input.delegationId });
          if (Option.isNone(current)) return yield* Effect.die("delegation missing");
          const sequence = current.value.messageCount + 1;
          const message: VmAgentDelegationMessage = {
            messageId: input.messageId,
            delegationId: input.delegationId,
            sequence,
            sender: input.sender,
            senderVmAgentId: input.senderVmAgentId,
            kind: input.kind,
            delivery: input.delivery,
            text: input.text,
            createdAt: input.createdAt,
          };
          yield* insertMessage(message);
          yield* sql`UPDATE vm_agent_delegations SET message_count = message_count + 1,
        followup_count = followup_count + ${input.incrementFollowup ? 1 : 0},
        status = COALESCE(${input.nextStatus ?? null}, status), updated_at = ${input.createdAt},
        revision = revision + 1 WHERE delegation_id = ${input.delegationId}`;
          if (input.delivery === "pending") {
            yield* sql`UPDATE vm_agent_tasks SET status = 'active', next_run_at = ${input.createdAt},
          updated_at = ${input.createdAt} WHERE delegation_id = ${input.delegationId}`;
          }
          if (input.deliveryMessageId !== undefined && current.value.runId !== null) {
            yield* sql`UPDATE vm_agent_task_runs SET message_id = ${input.deliveryMessageId},
          updated_at = ${input.createdAt} WHERE run_id = ${current.value.runId}`;
          }
          yield* insertEvent({
            delegationId: input.delegationId,
            type: "delegation.message",
            payload: {
              sender: input.sender,
              kind: input.kind,
              delivery: input.delivery,
              messageId: input.messageId,
              sequence,
            },
            createdAt: input.createdAt,
          });
          return message;
        }),
      )
      .pipe(mapError("appendMessage"));

  const markMessageDelivered: VmAgentCollaborationStoreShape["markMessageDelivered"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const refs = yield* sql<{
            readonly delegationId: string;
          }>`SELECT delegation_id AS "delegationId"
        FROM vm_agent_delegation_messages WHERE message_id = ${input.messageId}`;
          const delegationId = refs[0]?.delegationId;
          if (!delegationId) return;
          yield* sql`UPDATE vm_agent_delegation_messages SET delivery = 'delivered'
        WHERE message_id = ${input.messageId}`;
          yield* sql`UPDATE vm_agent_delegations SET updated_at = ${input.updatedAt},
        revision = revision + 1 WHERE delegation_id = ${delegationId}`;
        }),
      )
      .pipe(mapError("markMessageDelivered"));

  const requeuePendingFollowup: VmAgentCollaborationStoreShape["requeuePendingFollowup"] = (
    input,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const pending = yield* sql<{ readonly found: number }>`SELECT EXISTS(
            SELECT 1 FROM vm_agent_delegation_messages
            WHERE delegation_id = ${input.delegationId} AND delivery = 'pending'
          ) AS found`;
          if ((pending[0]?.found ?? 0) !== 1) return;
          yield* sql`UPDATE vm_agent_delegations
            SET status = 'queued', run_id = NULL, updated_at = ${input.updatedAt},
                revision = revision + 1
            WHERE delegation_id = ${input.delegationId}
              AND status IN ('queued', 'running', 'waiting-input')`;
          yield* sql`UPDATE vm_agent_tasks
            SET status = 'active', next_run_at = ${input.updatedAt}, updated_at = ${input.updatedAt}
            WHERE delegation_id = ${input.delegationId}`;
          yield* insertEvent({
            delegationId: input.delegationId,
            type: "delegation.followup-queued",
            payload: {},
            createdAt: input.updatedAt,
          });
        }),
      )
      .pipe(mapError("requeuePendingFollowup"));

  const complete: VmAgentCollaborationStoreShape["complete"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* getByRunRow({ runId: input.runId });
          if (Option.isNone(current)) return;
          if (input.summary && input.messageId)
            yield* insertMessage({
              messageId: input.messageId,
              delegationId: current.value.delegationId,
              sequence: current.value.messageCount + 1,
              sender: "target-agent",
              senderVmAgentId: current.value.targetVmAgentId,
              kind: "answer",
              delivery: "delivered",
              text: input.summary,
              createdAt: input.completedAt,
            });
          const result =
            input.status === "completed" && input.summary
              ? encodeDelegationResult({
                  summary: input.summary,
                  completedBy:
                    current.value.target.kind === "agent" ? "target-agent" : "ephemeral-worker",
                  completedAt: input.completedAt,
                })
              : null;
          yield* sql`UPDATE vm_agent_delegations SET status = ${input.status},
        completed_at = ${input.completedAt}, updated_at = ${input.completedAt},
        result_json = ${result}, error = ${input.error},
        message_count = message_count + ${input.summary && input.messageId ? 1 : 0},
        revision = revision + 1 WHERE delegation_id = ${current.value.delegationId}
        AND status IN ('pending-approval', 'queued', 'running', 'waiting-input')`;
          yield* sql`UPDATE vm_agent_tasks SET status = 'completed', next_run_at = NULL,
        updated_at = ${input.completedAt} WHERE delegation_id = ${current.value.delegationId}`;
          yield* insertEvent({
            delegationId: current.value.delegationId,
            type: `delegation.${input.status}`,
            payload: { runId: input.runId, error: input.error },
            createdAt: input.completedAt,
          });
        }),
      )
      .pipe(mapError("complete"));

  const cancel: VmAgentCollaborationStoreShape["cancel"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE vm_agent_delegations SET status = ${input.status},
        completed_at = ${input.completedAt}, updated_at = ${input.completedAt},
        error = ${input.detail}, revision = revision + 1
        WHERE delegation_id = ${input.delegationId}
        AND status IN ('pending-approval', 'queued', 'running', 'waiting-input')`;
          yield* sql`UPDATE vm_agent_tasks SET status = 'completed', next_run_at = NULL,
        updated_at = ${input.completedAt} WHERE delegation_id = ${input.delegationId}`;
          yield* sql`UPDATE vm_agent_task_runs SET status = 'cancelled',
        completed_at = ${input.completedAt}, updated_at = ${input.completedAt}, error = ${input.detail}
        WHERE run_id = (SELECT run_id FROM vm_agent_delegations
          WHERE delegation_id = ${input.delegationId}) AND status IN ('queued', 'booting', 'running')`;
          yield* insertEvent({
            delegationId: input.delegationId,
            type: `delegation.${input.status}`,
            payload: { detail: input.detail },
            createdAt: input.completedAt,
          });
        }),
      )
      .pipe(mapError("cancel"));

  const listExpired: VmAgentCollaborationStoreShape["listExpired"] = (now) =>
    SqlSchema.findAll({
      Request: Schema.Struct({ now: VmAgentDelegation.fields.expiresAt }),
      Result: DelegationDb,
      execute: ({ now }) => sql`SELECT ${delegationColumns(sql)}
        FROM vm_agent_delegations WHERE expires_at <= ${now}
        AND status IN ('pending-approval', 'queued', 'running', 'waiting-input')
        ORDER BY expires_at ASC`,
    })({ now }).pipe(mapError("listExpired"));

  const countActiveForRoot: VmAgentCollaborationStoreShape["countActiveForRoot"] = (vmAgentId) =>
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM vm_agent_delegations
      WHERE root_vm_agent_id = ${vmAgentId}
      AND status IN ('pending-approval', 'queued', 'running', 'waiting-input')`.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      mapError("countActiveForRoot"),
    );

  const findActiveForTarget: VmAgentCollaborationStoreShape["findActiveForTarget"] = (vmAgentId) =>
    SqlSchema.findOneOption({
      Request: AgentRef,
      Result: DelegationDb,
      execute: ({ vmAgentId }) => sql`SELECT ${delegationColumns(sql)}
        FROM vm_agent_delegations WHERE target_vm_agent_id = ${vmAgentId}
        AND status IN ('pending-approval', 'queued', 'running', 'waiting-input')
        ORDER BY created_at DESC LIMIT 1`,
    })({ vmAgentId }).pipe(mapError("findActiveForTarget"));

  const hasActiveTargetThread: VmAgentCollaborationStoreShape["hasActiveTargetThread"] = (
    threadId,
  ) =>
    sql<{ readonly found: number }>`SELECT EXISTS(SELECT 1
      FROM vm_agent_delegations AS delegation
      LEFT JOIN vm_agents AS target ON target.vm_agent_id = delegation.target_vm_agent_id
      WHERE (delegation.worker_thread_id = ${threadId} OR target.thread_id = ${threadId})
      AND delegation.status IN ('pending-approval', 'queued', 'running', 'waiting-input')) AS found`.pipe(
      Effect.map((rows) => (rows[0]?.found ?? 0) === 1),
      mapError("hasActiveTargetThread"),
    );

  return VmAgentCollaborationStore.of({
    list,
    listForAgent,
    getById,
    getByRunId,
    getByTaskId,
    getByWorkerThreadId,
    getByIdempotencyKey,
    listMessages,
    create,
    markRunClaimed,
    markRunning,
    setWorkerThread,
    appendMessage,
    markMessageDelivered,
    requeuePendingFollowup,
    complete,
    cancel,
    listExpired,
    countActiveForRoot,
    findActiveForTarget,
    hasActiveTargetThread,
  });
});

export const VmAgentCollaborationStoreLive = Layer.effect(VmAgentCollaborationStore, make);

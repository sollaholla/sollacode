import {
  VmAgentArtifact,
  VmAgentArtifactDefinition,
  VmAgentNotification,
  VmAgentNotificationPreferences,
  VmAgentTask,
  VmAgentTaskId,
  VmAgentTaskRun,
  VmAgentTaskRunId,
  VmAgentTaskSchedule,
  VmAgentWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  type ClaimVmAgentTaskInput,
  type CompleteVmAgentTaskRunInput,
  type CreateVmAgentNotificationInput,
  type CreateVmAgentTaskInput,
  type SetVmAgentTaskRunRunningInput,
  type UpdateVmAgentTaskInput,
  type UpsertVmAgentArtifactInput,
  VmAgentWorkspaceStore,
  type VmAgentWorkspaceStoreShape,
} from "../Services/VmAgentWorkspaces.ts";

const VmAgentTaskDb = VmAgentTask.mapFields(
  Struct.assign({
    completionCriteria: Schema.fromJsonString(Schema.Array(Schema.String)),
    schedule: Schema.NullOr(Schema.fromJsonString(VmAgentTaskSchedule)),
  }),
);

const VmAgentArtifactDb = VmAgentArtifact.mapFields(
  Struct.assign({
    definition: Schema.fromJsonString(VmAgentArtifactDefinition),
  }),
);

const PreferencesDb = Schema.Struct({
  vmAgentId: VmAgentNotificationPreferences.fields.vmAgentId,
  enabled: Schema.Int,
  taskCompletions: Schema.Int,
  taskFailures: Schema.Int,
  agentMessages: Schema.Int,
  updatedAt: VmAgentNotificationPreferences.fields.updatedAt,
});

const RunObservationDb = VmAgentTaskRun.mapFields(
  Struct.assign({
    projectionState: Schema.NullOr(
      Schema.Literals(["pending", "running", "interrupted", "incomplete", "completed", "error"]),
    ),
    projectionTurnId: Schema.NullOr(Schema.String),
    assistantText: Schema.NullOr(Schema.String),
  }),
);

const AgentRef = Schema.Struct({ vmAgentId: VmAgentTask.fields.vmAgentId });
const TaskRef = Schema.Struct({
  vmAgentId: VmAgentTask.fields.vmAgentId,
  taskId: VmAgentTaskId,
});
const NotificationRef = Schema.Struct({
  vmAgentId: VmAgentTask.fields.vmAgentId,
  notificationId: VmAgentNotification.fields.notificationId,
  readAt: VmAgentNotification.fields.createdAt,
});

const taskColumns = (sql: SqlClient.SqlClient) => sql`
  task_id AS "taskId",
  vm_agent_id AS "vmAgentId",
  title,
  prompt,
  completion_criteria_json AS "completionCriteria",
  status,
  schedule_json AS "schedule",
  next_run_at AS "nextRunAt",
  created_by AS "createdBy",
  approval_state AS "approvalState",
  notification_policy AS "notificationPolicy",
  artifact_id AS "artifactId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listTasks = SqlSchema.findAll({
    Request: AgentRef,
    Result: VmAgentTaskDb,
    execute: ({ vmAgentId }) => sql`
      SELECT ${taskColumns(sql)}
      FROM vm_agent_tasks
      WHERE vm_agent_id = ${vmAgentId} AND delegation_id IS NULL
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
        next_run_at ASC,
        updated_at DESC
      LIMIT 500
    `,
  });

  const getTaskRow = SqlSchema.findOneOption({
    Request: TaskRef,
    Result: VmAgentTaskDb,
    execute: ({ vmAgentId, taskId }) => sql`
      SELECT ${taskColumns(sql)}
      FROM vm_agent_tasks
      WHERE vm_agent_id = ${vmAgentId} AND task_id = ${taskId}
    `,
  });

  const insertTask = SqlSchema.void({
    Request: VmAgentTaskDb,
    execute: (task) => sql`
      INSERT INTO vm_agent_tasks (
        task_id, vm_agent_id, title, prompt, completion_criteria_json, status,
        schedule_json, next_run_at, created_by, approval_state,
        notification_policy, artifact_id, created_at, updated_at
      ) VALUES (
        ${task.taskId}, ${task.vmAgentId}, ${task.title}, ${task.prompt},
        ${task.completionCriteria}, ${task.status}, ${task.schedule}, ${task.nextRunAt},
        ${task.createdBy}, ${task.approvalState}, ${task.notificationPolicy},
        ${task.artifactId}, ${task.createdAt}, ${task.updatedAt}
      )
    `,
  });

  const updateTaskRow = SqlSchema.void({
    Request: VmAgentTaskDb,
    execute: (task) => sql`
      UPDATE vm_agent_tasks
      SET title = ${task.title},
          prompt = ${task.prompt},
          completion_criteria_json = ${task.completionCriteria},
          status = ${task.status},
          schedule_json = ${task.schedule},
          next_run_at = ${task.nextRunAt},
          approval_state = ${task.approvalState},
          notification_policy = ${task.notificationPolicy},
          updated_at = ${task.updatedAt}
      WHERE vm_agent_id = ${task.vmAgentId} AND task_id = ${task.taskId}
    `,
  });

  const deleteTaskRow = SqlSchema.void({
    Request: TaskRef,
    execute: ({ vmAgentId, taskId }) => sql`
      DELETE FROM vm_agent_tasks
      WHERE vm_agent_id = ${vmAgentId} AND task_id = ${taskId}
    `,
  });

  const listRuns = SqlSchema.findAll({
    Request: AgentRef,
    Result: VmAgentTaskRun,
    execute: ({ vmAgentId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", vm_agent_id AS "vmAgentId", status,
        message_id AS "messageId", turn_id AS "turnId", scheduled_for AS "scheduledFor",
        started_at AS "startedAt", completed_at AS "completedAt",
        result_summary AS "resultSummary", error, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM vm_agent_task_runs
      WHERE vm_agent_id = ${vmAgentId}
      ORDER BY created_at DESC
      LIMIT 100
    `,
  });

  const insertRun = SqlSchema.void({
    Request: VmAgentTaskRun,
    execute: (run) => sql`
      INSERT INTO vm_agent_task_runs (
        run_id, task_id, vm_agent_id, status, message_id, turn_id, scheduled_for,
        started_at, completed_at, result_summary, error, created_at, updated_at
      ) VALUES (
        ${run.runId}, ${run.taskId}, ${run.vmAgentId}, ${run.status}, ${run.messageId},
        ${run.turnId}, ${run.scheduledFor}, ${run.startedAt}, ${run.completedAt},
        ${run.resultSummary}, ${run.error}, ${run.createdAt}, ${run.updatedAt}
      )
    `,
  });

  const findNextDue = SqlSchema.findOneOption({
    Request: Schema.Struct({ now: VmAgentTask.fields.createdAt }),
    Result: VmAgentTaskDb,
    execute: ({ now }) => sql`
      SELECT ${taskColumns(sql)}
      FROM vm_agent_tasks AS task
      WHERE task.status = 'active'
        AND task.approval_state = 'approved'
        AND task.next_run_at IS NOT NULL
        AND task.next_run_at <= ${now}
        AND NOT EXISTS (
          SELECT 1 FROM vm_agent_task_runs AS active_run
          WHERE active_run.vm_agent_id = task.vm_agent_id
            AND active_run.status IN ('queued', 'booting', 'running')
        )
      ORDER BY task.next_run_at ASC, task.created_at ASC
      LIMIT 1
    `,
  });

  const advanceClaimedTask = SqlSchema.void({
    Request: Schema.Struct({
      taskId: VmAgentTaskId,
      nextRunAt: Schema.NullOr(VmAgentTask.fields.createdAt),
      updatedAt: VmAgentTask.fields.updatedAt,
    }),
    execute: ({ taskId, nextRunAt, updatedAt }) => sql`
      UPDATE vm_agent_tasks
      SET next_run_at = ${nextRunAt}, updated_at = ${updatedAt}
      WHERE task_id = ${taskId}
    `,
  });

  const listArtifacts = SqlSchema.findOneOption({
    Request: AgentRef,
    Result: VmAgentArtifactDb,
    execute: ({ vmAgentId }) => sql`
      SELECT artifact_id AS "artifactId", vm_agent_id AS "vmAgentId", title,
             definition_json AS "definition", revision, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM vm_agent_artifacts
      WHERE vm_agent_id = ${vmAgentId}
    `,
  });

  const insertDefaultArtifact = SqlSchema.void({
    Request: VmAgentArtifactDb,
    execute: (artifact) => sql`
      INSERT INTO vm_agent_artifacts (
        artifact_id, vm_agent_id, title, definition_json, revision, created_at, updated_at
      ) VALUES (
        ${artifact.artifactId}, ${artifact.vmAgentId}, ${artifact.title},
        ${artifact.definition}, ${artifact.revision}, ${artifact.createdAt}, ${artifact.updatedAt}
      )
      ON CONFLICT (vm_agent_id) DO NOTHING
    `,
  });

  const upsertArtifactRow = SqlSchema.void({
    Request: VmAgentArtifactDb,
    execute: (artifact) => sql`
      INSERT INTO vm_agent_artifacts (
        artifact_id, vm_agent_id, title, definition_json, revision, created_at, updated_at
      ) VALUES (
        ${artifact.artifactId}, ${artifact.vmAgentId}, ${artifact.title},
        ${artifact.definition}, ${artifact.revision}, ${artifact.createdAt}, ${artifact.updatedAt}
      )
      ON CONFLICT (vm_agent_id) DO UPDATE SET
        title = excluded.title,
        definition_json = excluded.definition_json,
        revision = vm_agent_artifacts.revision + 1,
        updated_at = excluded.updated_at
    `,
  });

  const listNotifications = SqlSchema.findAll({
    Request: AgentRef,
    Result: VmAgentNotification,
    execute: ({ vmAgentId }) => sql`
      SELECT notification_id AS "notificationId", vm_agent_id AS "vmAgentId",
             task_id AS "taskId", run_id AS "runId", kind, title, body,
             deep_link AS "deepLink", read_at AS "readAt", created_at AS "createdAt"
      FROM vm_agent_notifications
      WHERE vm_agent_id = ${vmAgentId}
      ORDER BY created_at DESC
      LIMIT 100
    `,
  });

  const insertNotification = SqlSchema.void({
    Request: Schema.Struct({
      notificationId: VmAgentNotification.fields.notificationId,
      vmAgentId: VmAgentNotification.fields.vmAgentId,
      taskId: VmAgentNotification.fields.taskId,
      runId: VmAgentNotification.fields.runId,
      kind: VmAgentNotification.fields.kind,
      title: VmAgentNotification.fields.title,
      body: VmAgentNotification.fields.body,
      deepLink: VmAgentNotification.fields.deepLink,
      dedupeKey: Schema.String,
      createdAt: VmAgentNotification.fields.createdAt,
    }),
    execute: (notification) => sql`
      INSERT INTO vm_agent_notifications (
        notification_id, vm_agent_id, task_id, run_id, kind, title, body,
        deep_link, dedupe_key, read_at, created_at
      ) VALUES (
        ${notification.notificationId}, ${notification.vmAgentId}, ${notification.taskId},
        ${notification.runId}, ${notification.kind}, ${notification.title},
        ${notification.body}, ${notification.deepLink}, ${notification.dedupeKey},
        NULL, ${notification.createdAt}
      )
      ON CONFLICT (dedupe_key) DO NOTHING
    `,
  });

  const markNotificationReadRow = SqlSchema.void({
    Request: NotificationRef,
    execute: ({ vmAgentId, notificationId, readAt }) => sql`
      UPDATE vm_agent_notifications
      SET read_at = COALESCE(read_at, ${readAt})
      WHERE vm_agent_id = ${vmAgentId} AND notification_id = ${notificationId}
    `,
  });

  const getPreferences = SqlSchema.findOneOption({
    Request: AgentRef,
    Result: PreferencesDb,
    execute: ({ vmAgentId }) => sql`
      SELECT vm_agent_id AS "vmAgentId", enabled,
             task_completions AS "taskCompletions", task_failures AS "taskFailures",
             agent_messages AS "agentMessages", updated_at AS "updatedAt"
      FROM vm_agent_notification_preferences
      WHERE vm_agent_id = ${vmAgentId}
    `,
  });

  const upsertPreferences = SqlSchema.void({
    Request: PreferencesDb,
    execute: (preferences) => sql`
      INSERT INTO vm_agent_notification_preferences (
        vm_agent_id, enabled, task_completions, task_failures, agent_messages, updated_at
      ) VALUES (
        ${preferences.vmAgentId}, ${preferences.enabled}, ${preferences.taskCompletions},
        ${preferences.taskFailures}, ${preferences.agentMessages}, ${preferences.updatedAt}
      )
      ON CONFLICT (vm_agent_id) DO UPDATE SET
        enabled = excluded.enabled,
        task_completions = excluded.task_completions,
        task_failures = excluded.task_failures,
        agent_messages = excluded.agent_messages,
        updated_at = excluded.updated_at
    `,
  });

  const listObservations = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RunObservationDb,
    execute: () => sql`
      SELECT
        run.run_id AS "runId", run.task_id AS "taskId", run.vm_agent_id AS "vmAgentId",
        run.status, run.message_id AS "messageId", run.turn_id AS "turnId",
        run.scheduled_for AS "scheduledFor", run.started_at AS "startedAt",
        run.completed_at AS "completedAt", run.result_summary AS "resultSummary",
        run.error, run.created_at AS "createdAt", run.updated_at AS "updatedAt",
        turn.state AS "projectionState", turn.turn_id AS "projectionTurnId",
        assistant.text AS "assistantText"
      FROM vm_agent_task_runs AS run
      LEFT JOIN vm_agents AS agent ON agent.vm_agent_id = run.vm_agent_id
      LEFT JOIN vm_agent_delegations AS delegation ON delegation.task_id = run.task_id
      LEFT JOIN projection_turns AS turn
        ON turn.thread_id = COALESCE(delegation.worker_thread_id, agent.thread_id)
        AND turn.pending_message_id = run.message_id
      LEFT JOIN projection_thread_messages AS assistant
        ON assistant.message_id = turn.assistant_message_id
      WHERE run.status IN ('queued', 'booting', 'running')
      ORDER BY run.created_at ASC
    `,
  });

  const setRunBootingRow = SqlSchema.void({
    Request: Schema.Struct({ runId: VmAgentTaskRunId, updatedAt: VmAgentTaskRun.fields.updatedAt }),
    execute: ({ runId, updatedAt }) => sql`
      UPDATE vm_agent_task_runs SET status = 'booting', updated_at = ${updatedAt}
      WHERE run_id = ${runId} AND status = 'queued'
    `,
  });

  const setRunRunningRow = SqlSchema.void({
    Request: Schema.Struct({
      runId: VmAgentTaskRunId,
      messageId: VmAgentTaskRun.fields.messageId,
      startedAt: VmAgentTaskRun.fields.scheduledFor,
    }),
    execute: ({ runId, messageId, startedAt }) => sql`
      UPDATE vm_agent_task_runs
      SET status = 'running', message_id = ${messageId}, started_at = ${startedAt}, updated_at = ${startedAt}
      WHERE run_id = ${runId} AND status IN ('queued', 'booting')
    `,
  });

  const completeRunRow = SqlSchema.void({
    Request: Schema.Struct({
      runId: VmAgentTaskRunId,
      status: Schema.Literals(["completed", "failed", "cancelled"]),
      turnId: Schema.NullOr(Schema.String),
      resultSummary: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
      completedAt: VmAgentTaskRun.fields.scheduledFor,
    }),
    execute: (input) => sql`
      UPDATE vm_agent_task_runs
      SET status = ${input.status}, turn_id = ${input.turnId},
          result_summary = ${input.resultSummary}, error = ${input.error},
          completed_at = ${input.completedAt}, updated_at = ${input.completedAt}
      WHERE run_id = ${input.runId}
    `,
  });

  const completeOneTimeTask = SqlSchema.void({
    Request: Schema.Struct({ runId: VmAgentTaskRunId, updatedAt: VmAgentTask.fields.updatedAt }),
    execute: ({ runId, updatedAt }) => sql`
      UPDATE vm_agent_tasks
      SET status = 'completed', next_run_at = NULL, updated_at = ${updatedAt}
      WHERE task_id = (SELECT task_id FROM vm_agent_task_runs WHERE run_id = ${runId})
        AND (schedule_json IS NULL OR json_extract(schedule_json, '$.kind') = 'once')
    `,
  });

  const mapError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`VmAgentWorkspaceStore.${operation}:query`));

  const preferenceFromDb = (
    row: Schema.Schema.Type<typeof PreferencesDb>,
  ): VmAgentNotificationPreferences => ({
    vmAgentId: row.vmAgentId,
    enabled: row.enabled !== 0,
    taskCompletions: row.taskCompletions !== 0,
    taskFailures: row.taskFailures !== 0,
    agentMessages: row.agentMessages !== 0,
    updatedAt: row.updatedAt,
  });

  const ensureDefaults: VmAgentWorkspaceStoreShape["ensureDefaults"] = (input) =>
    sql
      .withTransaction(
        Effect.all([
          insertDefaultArtifact({
            artifactId: input.artifactId,
            vmAgentId: input.vmAgentId,
            title: "Schedule",
            definition: { kind: "schedule" },
            revision: 1,
            createdAt: input.now,
            updatedAt: input.now,
          }),
          upsertPreferences({
            vmAgentId: input.vmAgentId,
            enabled: 1,
            taskCompletions: 1,
            taskFailures: 1,
            agentMessages: 1,
            updatedAt: input.now,
          }).pipe(
            Effect.when(
              getPreferences({ vmAgentId: input.vmAgentId }).pipe(Effect.map(Option.isNone)),
            ),
          ),
        ]),
      )
      .pipe(mapError("ensureDefaults"), Effect.asVoid);

  const snapshot: VmAgentWorkspaceStoreShape["snapshot"] = (vmAgentId) =>
    Effect.all({
      tasks: listTasks({ vmAgentId }),
      runs: listRuns({ vmAgentId }),
      artifact: listArtifacts({ vmAgentId }),
      notifications: listNotifications({ vmAgentId }),
      preferences: getPreferences({ vmAgentId }),
    }).pipe(
      mapError("snapshot"),
      Effect.map(({ tasks, runs, artifact, notifications, preferences }) => {
        const fallbackUpdatedAt = artifact.pipe(
          Option.map((value) => value.updatedAt),
          Option.getOrElse(() => "1970-01-01T00:00:00.000Z"),
        );
        return {
          type: "snapshot" as const,
          vmAgentId,
          tasks,
          runs,
          artifact: Option.getOrNull(artifact),
          notifications,
          notificationPreferences: Option.match(preferences, {
            onNone: () => ({
              vmAgentId,
              enabled: true,
              taskCompletions: true,
              taskFailures: true,
              agentMessages: true,
              updatedAt: fallbackUpdatedAt,
            }),
            onSome: preferenceFromDb,
          }),
        } satisfies VmAgentWorkspaceSnapshot;
      }),
    );

  const getTask: VmAgentWorkspaceStoreShape["getTask"] = (vmAgentId, taskId) =>
    getTaskRow({ vmAgentId, taskId }).pipe(mapError("getTask"));

  const createTask: VmAgentWorkspaceStoreShape["createTask"] = (input: CreateVmAgentTaskInput) => {
    const task: VmAgentTask = { ...input, updatedAt: input.createdAt };
    return insertTask(task).pipe(mapError("createTask"), Effect.as(task));
  };

  const updateTask: VmAgentWorkspaceStoreShape["updateTask"] = (input: UpdateVmAgentTaskInput) => {
    const task: VmAgentTask = {
      ...input,
      createdBy: "user",
      artifactId: null,
      createdAt: input.updatedAt,
    };
    return getTaskRow({ vmAgentId: input.vmAgentId, taskId: input.taskId }).pipe(
      mapError("updateTask.read"),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(task),
          onSome: (current) => {
            const updated = {
              ...task,
              createdBy: current.createdBy,
              artifactId: current.artifactId,
              createdAt: current.createdAt,
            } satisfies VmAgentTask;
            return updateTaskRow(updated).pipe(mapError("updateTask.write"), Effect.as(updated));
          },
        }),
      ),
    );
  };

  const deleteTask: VmAgentWorkspaceStoreShape["deleteTask"] = (vmAgentId, taskId) =>
    deleteTaskRow({ vmAgentId, taskId }).pipe(mapError("deleteTask"));

  const runTaskNow: VmAgentWorkspaceStoreShape["runTaskNow"] = ({ vmAgentId, taskId, now }) =>
    getTaskRow({ vmAgentId, taskId }).pipe(
      mapError("runTaskNow.read"),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die(new Error(`Unknown task ${taskId}`)),
          onSome: (task) => {
            const updated = {
              ...task,
              status: "active" as const,
              nextRunAt: now,
              updatedAt: now,
            };
            return updateTaskRow(updated).pipe(mapError("runTaskNow.write"), Effect.as(updated));
          },
        }),
      ),
    );

  const claimNextDue: VmAgentWorkspaceStoreShape["claimNextDue"] = (input: ClaimVmAgentTaskInput) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const due = yield* findNextDue({ now: input.now });
          if (Option.isNone(due)) return Option.none();
          const task = due.value;
          const nextRunAt =
            task.schedule?.kind === "interval"
              ? DateTime.formatIso(
                  DateTime.add(DateTime.makeUnsafe(input.now), {
                    minutes: task.schedule.everyMinutes,
                  }),
                )
              : null;
          const run: VmAgentTaskRun = {
            runId: input.runId,
            taskId: task.taskId,
            vmAgentId: task.vmAgentId,
            status: "queued",
            messageId: null,
            turnId: null,
            scheduledFor: task.nextRunAt ?? input.now,
            startedAt: null,
            completedAt: null,
            resultSummary: null,
            error: null,
            createdAt: input.now,
            updatedAt: input.now,
          };
          yield* insertRun(run);
          yield* advanceClaimedTask({ taskId: task.taskId, nextRunAt, updatedAt: input.now });
          return Option.some({ task: { ...task, nextRunAt, updatedAt: input.now }, run });
        }),
      )
      .pipe(mapError("claimNextDue"));

  const setRunBooting: VmAgentWorkspaceStoreShape["setRunBooting"] = (runId, updatedAt) =>
    setRunBootingRow({ runId, updatedAt }).pipe(mapError("setRunBooting"));

  const setRunRunning: VmAgentWorkspaceStoreShape["setRunRunning"] = (
    input: SetVmAgentTaskRunRunningInput,
  ) => setRunRunningRow(input).pipe(mapError("setRunRunning"));

  const completeRun: VmAgentWorkspaceStoreShape["completeRun"] = (
    input: CompleteVmAgentTaskRunInput,
  ) =>
    sql
      .withTransaction(
        completeRunRow(input).pipe(
          Effect.flatMap(() =>
            input.status === "completed"
              ? completeOneTimeTask({ runId: input.runId, updatedAt: input.completedAt })
              : Effect.void,
          ),
        ),
      )
      .pipe(mapError("completeRun"));

  const listRunObservations: VmAgentWorkspaceStoreShape["listRunObservations"] = () =>
    listObservations(undefined).pipe(
      mapError("listRunObservations"),
      Effect.map((rows) =>
        rows.map(({ projectionState, projectionTurnId, assistantText, ...run }) => ({
          run,
          projectionState,
          projectionTurnId,
          assistantText,
        })),
      ),
    );

  const createNotification: VmAgentWorkspaceStoreShape["createNotification"] = (
    input: CreateVmAgentNotificationInput,
  ) => insertNotification(input).pipe(mapError("createNotification"));

  const markNotificationRead: VmAgentWorkspaceStoreShape["markNotificationRead"] = (input) =>
    markNotificationReadRow(input).pipe(mapError("markNotificationRead"));

  const updateNotificationPreferences: VmAgentWorkspaceStoreShape["updateNotificationPreferences"] =
    (preferences) =>
      upsertPreferences({
        ...preferences,
        enabled: preferences.enabled ? 1 : 0,
        taskCompletions: preferences.taskCompletions ? 1 : 0,
        taskFailures: preferences.taskFailures ? 1 : 0,
        agentMessages: preferences.agentMessages ? 1 : 0,
      }).pipe(mapError("updateNotificationPreferences"), Effect.as(preferences));

  const upsertArtifact: VmAgentWorkspaceStoreShape["upsertArtifact"] = (
    input: UpsertVmAgentArtifactInput,
  ) =>
    listArtifacts({ vmAgentId: input.vmAgentId }).pipe(
      mapError("upsertArtifact.read"),
      Effect.flatMap((current) => {
        const artifact: VmAgentArtifact = {
          artifactId: Option.match(current, {
            onNone: () => input.artifactId,
            onSome: (value) => value.artifactId,
          }),
          vmAgentId: input.vmAgentId,
          title: input.title,
          definition: input.definition,
          revision: Option.match(current, {
            onNone: () => 1,
            onSome: (value) => value.revision + 1,
          }),
          createdAt: Option.match(current, {
            onNone: () => input.updatedAt,
            onSome: (value) => value.createdAt,
          }),
          updatedAt: input.updatedAt,
        };
        return upsertArtifactRow(artifact).pipe(
          mapError("upsertArtifact.write"),
          Effect.as(artifact),
        );
      }),
    );

  return {
    ensureDefaults,
    snapshot,
    getTask,
    createTask,
    updateTask,
    deleteTask,
    runTaskNow,
    claimNextDue,
    setRunBooting,
    setRunRunning,
    completeRun,
    listRunObservations,
    createNotification,
    markNotificationRead,
    updateNotificationPreferences,
    upsertArtifact,
  } satisfies VmAgentWorkspaceStoreShape;
});

export const VmAgentWorkspaceStoreLive = Layer.effect(VmAgentWorkspaceStore, make);

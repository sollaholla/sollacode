import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  listOpenBackgroundTasksBefore,
  refreshProjectionThreadBackgroundTasks,
} from "./BackgroundTaskProjection.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const noon = DateTime.makeUnsafe("2026-10-10T12:00:00.000Z");
const at = (minutesBeforeNoon: number) =>
  DateTime.formatIso(DateTime.subtract(noon, { minutes: minutesBeforeNoon }));

const seedThread = (threadId: string, updatedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, latest_turn_id, created_at, updated_at,
        has_actionable_proposed_plan, deleted_at
      ) VALUES (
        ${threadId}, 'project-1', ${threadId}, '{"instanceId":"claudeAgent","model":"opus"}',
        'full-access', 'default', NULL, ${at(600)}, ${updatedAt}, 0, NULL
      )
    `;
  });

let activityCount = 0;
const task = (input: {
  readonly threadId: string;
  readonly taskId: string;
  readonly kind: "task.started" | "task.progress" | "task.completed";
  readonly createdAt: string;
  readonly taskType?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    activityCount += 1;
    // Progress and completion share one lifecycle row per task, as ingestion writes them.
    const activityId =
      input.kind === "task.started"
        ? `started-${activityCount}`
        : `lifecycle:${input.threadId}:${input.taskId}`;
    const payload = `{"taskId":"${input.taskId}"${
      input.taskType === undefined ? "" : `,"taskType":"${input.taskType}"`
    }}`;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      ) VALUES (
        ${activityId}, ${input.threadId}, NULL, 'info', ${input.kind}, '', ${payload}, NULL,
        ${input.createdAt}
      )
      ON CONFLICT (activity_id) DO UPDATE SET
        kind = excluded.kind,
        payload_json = excluded.payload_json,
        created_at = excluded.created_at
    `;
  });

const summaryOf = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      readonly count: number;
      readonly startedAt: string | null;
      readonly activityAt: string | null;
    }>`
      SELECT
        background_task_count AS "count",
        background_tasks_started_at AS "startedAt",
        background_tasks_activity_at AS "activityAt"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `;
    return row;
  });

it.layer(NodeSqliteClient.layerMemory())("BackgroundTaskProjection", (it) => {
  it.effect("summarizes the tasks still running, measured from the newest report", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedThread("thread-busy", at(1));

      // Still running: started ten minutes ago, reported a minute ago.
      yield* task({
        threadId: "thread-busy",
        taskId: "a",
        kind: "task.started",
        createdAt: at(10),
      });
      yield* task({
        threadId: "thread-busy",
        taskId: "a",
        kind: "task.progress",
        createdAt: at(1),
      });
      // Finished.
      yield* task({ threadId: "thread-busy", taskId: "b", kind: "task.started", createdAt: at(5) });
      yield* task({
        threadId: "thread-busy",
        taskId: "b",
        kind: "task.completed",
        createdAt: at(2),
      });
      // Never finished, silent for hours before the newest report: a ghost.
      yield* task({
        threadId: "thread-busy",
        taskId: "c",
        kind: "task.started",
        createdAt: at(180),
      });
      // A plan refresh is server work, not the agent's.
      yield* task({
        threadId: "thread-busy",
        taskId: "p",
        kind: "task.started",
        createdAt: at(3),
        taskType: "plan-refresh",
      });

      yield* refreshProjectionThreadBackgroundTasks(sql, "thread-busy");
      assert.deepEqual(yield* summaryOf("thread-busy"), {
        count: 1,
        startedAt: at(10),
        activityAt: at(1),
      });

      // A task started again after it finished is running again.
      yield* task({ threadId: "thread-busy", taskId: "b", kind: "task.started", createdAt: at(0) });
      yield* refreshProjectionThreadBackgroundTasks(sql, "thread-busy");
      assert.equal((yield* summaryOf("thread-busy"))?.count, 2);

      // Once everything reports finished, the thread has no background work.
      yield* task({
        threadId: "thread-busy",
        taskId: "a",
        kind: "task.completed",
        createdAt: at(0),
      });
      yield* task({
        threadId: "thread-busy",
        taskId: "b",
        kind: "task.completed",
        createdAt: at(0),
      });
      yield* refreshProjectionThreadBackgroundTasks(sql, "thread-busy");
      assert.deepEqual(yield* summaryOf("thread-busy"), {
        count: 0,
        startedAt: null,
        activityAt: null,
      });
    }),
  );

  it.effect("lists the tasks a previous process left open", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedThread("thread-restarted", at(2));
      yield* seedThread("thread-long-idle", at(60 * 30));
      const boot = at(1);

      yield* task({
        threadId: "thread-restarted",
        taskId: "orphan",
        kind: "task.started",
        createdAt: at(20),
      });
      yield* task({
        threadId: "thread-restarted",
        taskId: "orphan",
        kind: "task.progress",
        createdAt: at(3),
      });
      // Gone quiet long before the restart, but still never finished.
      yield* task({
        threadId: "thread-restarted",
        taskId: "quiet",
        kind: "task.started",
        createdAt: at(300),
      });
      // Reported after boot: it belongs to the running process.
      yield* task({
        threadId: "thread-restarted",
        taskId: "current",
        kind: "task.started",
        createdAt: at(0),
      });
      yield* task({
        threadId: "thread-restarted",
        taskId: "done",
        kind: "task.started",
        createdAt: at(30),
      });
      yield* task({
        threadId: "thread-restarted",
        taskId: "done",
        kind: "task.completed",
        createdAt: at(25),
      });
      // A thread untouched for over a day is outside the lookback.
      yield* task({
        threadId: "thread-long-idle",
        taskId: "ancient",
        kind: "task.started",
        createdAt: at(60 * 30),
      });

      assert.deepEqual(yield* listOpenBackgroundTasksBefore(sql, { before: boot }), [
        // The ghost the busy thread above never finished goes too.
        { threadId: "thread-busy", taskId: "c" },
        { threadId: "thread-restarted", taskId: "quiet" },
        { threadId: "thread-restarted", taskId: "orphan" },
      ]);
    }),
  );
});

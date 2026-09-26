import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { EventId, ThreadId } from "@t3tools/contracts";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const insertActivity = (input: {
  readonly activityId: string;
  readonly threadId: string;
  readonly kind: string;
  readonly toolCallId: string | null;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload =
      input.toolCallId === null
        ? encodeJson({ data: {} })
        : encodeJson({ data: { toolCallId: input.toolCallId } });
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
      )
      VALUES (
        ${input.activityId}, ${input.threadId}, NULL, 'info', ${input.kind}, 's',
        ${payload}, ${input.createdAt}
      )
    `;
  });

layer("ProjectionThreadActivityRepository.deleteSupersededToolUpdates", (it) => {
  it.effect("preserves duplicate historical activity chronology while repairing content", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("history-replay");
      const original = {
        activityId: EventId.make("old-tool"),
        threadId,
        turnId: null,
        tone: "tool" as const,
        kind: "tool.started",
        summary: "Running",
        payload: {},
        sequence: 10,
        createdAt: "2026-09-13T20:43:26.208Z",
      };
      yield* repository.upsert(original);
      yield* repository.upsert(
        {
          ...original,
          kind: "tool.completed",
          summary: "Completed",
          sequence: 30,
          createdAt: "2026-09-13T21:26:02.431Z",
        },
        { preserveChronology: true },
      );
      const [repaired] = yield* repository.listByThreadId({ threadId });
      assert.equal(repaired?.createdAt, original.createdAt);
      assert.equal(repaired?.sequence, 10);
      assert.equal(repaired?.kind, "tool.completed");
      yield* repository.upsert(
        { ...original, activityId: EventId.make("missing-tool"), sequence: 20 },
        { preserveChronology: true },
      );
      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(
        rows.map((row) => row.activityId),
        ["old-tool", "missing-tool"],
      );
      yield* repository.upsert({
        ...original,
        sequence: 40,
        createdAt: "2026-09-13T22:00:00.000Z",
      });
      const liveRows = yield* repository.listByThreadId({ threadId });
      assert.equal(liveRows.at(-1)?.sequence, 40);
      assert.equal(liveRows.at(-1)?.createdAt, "2026-09-13T22:00:00.000Z");
      yield* repository.deleteByThreadId({ threadId });
    }),
  );

  it.effect("deletes only the completed call's recent updated frames", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionThreadActivityRepository;
      yield* runMigrations({});

      const seeds = [
        // Superseded frames of the completed call: both go.
        {
          activityId: "u-1",
          threadId: "t-1",
          kind: "tool.updated",
          toolCallId: "call-1",
          createdAt: "2026-08-30T10:30:00.000Z",
        },
        {
          activityId: "u-2",
          threadId: "t-1",
          kind: "tool.updated",
          toolCallId: "call-1",
          createdAt: "2026-08-30T10:31:00.000Z",
        },
        // A different call's frame stays.
        {
          activityId: "u-other-call",
          threadId: "t-1",
          kind: "tool.updated",
          toolCallId: "call-2",
          createdAt: "2026-08-30T10:31:00.000Z",
        },
        // Same call outside the window stays (left for the compactor).
        {
          activityId: "u-old",
          threadId: "t-1",
          kind: "tool.updated",
          toolCallId: "call-1",
          createdAt: "2026-08-30T08:00:00.000Z",
        },
        // A frame with no toolCallId can never match.
        {
          activityId: "u-no-id",
          threadId: "t-1",
          kind: "tool.updated",
          toolCallId: null,
          createdAt: "2026-08-30T10:31:00.000Z",
        },
        // Another thread's identical frame stays.
        {
          activityId: "u-other-thread",
          threadId: "t-2",
          kind: "tool.updated",
          toolCallId: "call-1",
          createdAt: "2026-08-30T10:31:00.000Z",
        },
        // The completion itself is not an updated frame and stays.
        {
          activityId: "c-1",
          threadId: "t-1",
          kind: "tool.completed",
          toolCallId: "call-1",
          createdAt: "2026-08-30T10:32:00.000Z",
        },
      ];
      yield* Effect.forEach(seeds, insertActivity, { concurrency: 1 });

      yield* repository.deleteSupersededToolUpdates({
        threadId: ThreadId.make("t-1"),
        toolCallId: "call-1",
        sinceCreatedAt: "2026-08-30T09:32:00.000Z",
      });

      const survivors = yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId" FROM projection_thread_activities ORDER BY activity_id
      `;
      assert.deepEqual(
        survivors.map((row) => row.activityId),
        ["c-1", "u-no-id", "u-old", "u-other-call", "u-other-thread"],
      );
    }),
  );
});

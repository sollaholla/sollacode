import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  VmAgentDelegationId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import {
  ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
  ACTIVE_TURN_STEER_DELIVERY_UNKNOWN_REASON,
} from "../../persistence/Services/ThreadWorkObligations.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("t3-projection-pipeline-test-");

it.layer(makeProjectionPipelinePrefixedTestLayer("t3-projection-bootstrap-noop-test-"))(
  "OrchestrationProjectionPipeline caught-up bootstrap",
  (it) => {
    it.effect("does not rewrite every thread shell when no events need replay", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("thread-caught-up-bootstrap");

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-caught-up-bootstrap"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-caught-up-bootstrap"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-caught-up-bootstrap"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-caught-up-bootstrap"),
            title: "Caught-up bootstrap",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* projectionPipeline.bootstrap;

        yield* sql`CREATE TEMP TABLE bootstrap_thread_updates (thread_id TEXT NOT NULL)`;
        yield* sql`
          CREATE TEMP TRIGGER capture_bootstrap_thread_update
          AFTER UPDATE ON projection_threads
          BEGIN
            INSERT INTO bootstrap_thread_updates (thread_id) VALUES (NEW.thread_id);
          END
        `;

        yield* projectionPipeline.bootstrap;

        const updateRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM bootstrap_thread_updates
        `;
        assert.deepStrictEqual(updateRows, [{ count: 0 }]);
      }),
    );
  },
);

it.layer(makeProjectionPipelinePrefixedTestLayer("t3-projection-pipeline-backlog-test-"))(
  "OrchestrationProjectionPipeline backlog",
  (it) => {
    it.effect("bootstraps every event when the backlog exceeds the default replay limit", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* sql`
        WITH RECURSIVE backlog(event_number) AS (
          VALUES (1)
          UNION ALL
          SELECT event_number + 1
          FROM backlog
          WHERE event_number < 1001
        )
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        SELECT
          'evt-backlog-' || event_number,
          'project',
          'project-backlog-' || event_number,
          0,
          'project.created',
          ${now},
          'cmd-backlog-' || event_number,
          NULL,
          'cmd-backlog-' || event_number,
          'client',
          json_object(
            'projectId',
            'project-backlog-' || event_number,
            'title',
            'Backlog Project ' || event_number,
            'workspaceRoot',
            '/tmp/project-backlog-' || event_number,
            'defaultModelSelection',
            NULL,
            'scripts',
            json('[]'),
            'createdAt',
            ${now},
            'updatedAt',
            ${now}
          ),
          json('{}')
        FROM backlog
      `;

        yield* projectionPipeline.bootstrap;

        const projectCountRows = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count
        FROM projection_projects
      `;
        assert.equal(projectCountRows[0]?.count, 1001);

        const projectionStateRows = yield* sql<{
          readonly projector: string;
          readonly lastAppliedSequence: number;
        }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector
      `;
        assert.equal(projectionStateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
        assert.isTrue(projectionStateRows.every((row) => row.lastAppliedSequence === 1001));
      }),
    );
  },
);

it.layer(makeProjectionPipelinePrefixedTestLayer("t3-projection-pipeline-revert-rebuild-test-"))(
  "OrchestrationProjectionPipeline revert rebuild",
  (it) => {
    it.effect("rebuilds revert-sensitive projections after turns are materialized", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-revert-rebuild");

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-revert-rebuild-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-revert-rebuild"),
          occurredAt: "2026-01-02T00:00:00.000Z",
          commandId: CommandId.make("cmd-revert-rebuild-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-revert-rebuild-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-revert-rebuild"),
            title: "Project Revert Rebuild",
            workspaceRoot: "/tmp/project-revert-rebuild",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        });
        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-revert-rebuild-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-01-02T00:00:01.000Z",
          commandId: CommandId.make("cmd-revert-rebuild-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-revert-rebuild-2"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-revert-rebuild"),
            title: "Thread Revert Rebuild",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-02T00:00:01.000Z",
            updatedAt: "2026-01-02T00:00:01.000Z",
          },
        });
        yield* eventStore.append({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-revert-rebuild-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-01-02T00:00:02.000Z",
          commandId: CommandId.make("cmd-revert-rebuild-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-revert-rebuild-3"),
          metadata: {},
          payload: {
            threadId,
            turnId: TurnId.make("turn-revert-rebuild-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-rebuild/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("message-revert-rebuild-keep"),
            completedAt: "2026-01-02T00:00:02.000Z",
          },
        });
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-revert-rebuild-4"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-01-02T00:00:02.100Z",
          commandId: CommandId.make("cmd-revert-rebuild-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-revert-rebuild-4"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-revert-rebuild-keep"),
            role: "user",
            text: "keep",
            turnId: TurnId.make("turn-revert-rebuild-1"),
            streaming: false,
            createdAt: "2026-01-02T00:00:02.100Z",
            updatedAt: "2026-01-02T00:00:02.100Z",
          },
        });
        yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make("evt-revert-rebuild-5"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-01-02T00:00:02.200Z",
          commandId: CommandId.make("cmd-revert-rebuild-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-revert-rebuild-5"),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-revert-rebuild-keep"),
              tone: "info",
              kind: "status",
              summary: "keep",
              payload: {},
              turnId: TurnId.make("turn-revert-rebuild-1"),
              createdAt: "2026-01-02T00:00:02.200Z",
            },
          },
        });
        yield* eventStore.append({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-revert-rebuild-6"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-01-02T00:00:03.000Z",
          commandId: CommandId.make("cmd-revert-rebuild-6"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-revert-rebuild-6"),
          metadata: {},
          payload: {
            threadId,
            turnId: TurnId.make("turn-revert-rebuild-2"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-rebuild/turn/2"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("message-revert-rebuild-remove"),
            completedAt: "2026-01-02T00:00:03.000Z",
          },
        });
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-revert-rebuild-7"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-01-02T00:00:03.100Z",
          commandId: CommandId.make("cmd-revert-rebuild-7"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-revert-rebuild-7"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-revert-rebuild-remove"),
            role: "user",
            text: "remove",
            turnId: TurnId.make("turn-revert-rebuild-2"),
            streaming: false,
            createdAt: "2026-01-02T00:00:03.100Z",
            updatedAt: "2026-01-02T00:00:03.100Z",
          },
        });
        yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make("evt-revert-rebuild-8"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-01-02T00:00:03.200Z",
          commandId: CommandId.make("cmd-revert-rebuild-8"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-revert-rebuild-8"),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-revert-rebuild-remove"),
              tone: "info",
              kind: "status",
              summary: "remove",
              payload: {},
              turnId: TurnId.make("turn-revert-rebuild-2"),
              createdAt: "2026-01-02T00:00:03.200Z",
            },
          },
        });
        yield* eventStore.append({
          type: "thread.reverted",
          eventId: EventId.make("evt-revert-rebuild-9"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-01-02T00:00:04.000Z",
          commandId: CommandId.make("cmd-revert-rebuild-9"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-revert-rebuild-9"),
          metadata: {},
          payload: {
            threadId,
            turnCount: 1,
          },
        });

        yield* projectionPipeline.bootstrap;

        const messageRows = yield* sql<{
          readonly messageId: string;
        }>`
          SELECT message_id AS "messageId"
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
          ORDER BY message_id
        `;
        assert.deepEqual(messageRows, [{ messageId: "message-revert-rebuild-keep" }]);

        const activityRows = yield* sql<{
          readonly activityId: string;
        }>`
          SELECT activity_id AS "activityId"
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
          ORDER BY activity_id
        `;
        assert.deepEqual(activityRows, [{ activityId: "activity-revert-rebuild-keep" }]);

        const threadRows = yield* sql<{
          readonly latestTurnId: string | null;
          readonly latestUserMessageAt: string | null;
        }>`
          SELECT
            latest_turn_id AS "latestTurnId",
            latest_user_message_at AS "latestUserMessageAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(threadRows, [
          {
            latestTurnId: "turn-revert-rebuild-1",
            latestUserMessageAt: "2026-01-02T00:00:02.100Z",
          },
        ]);
      }),
    );
  },
);

it.layer(makeProjectionPipelinePrefixedTestLayer("t3-projection-pipeline-bounded-summary-test-"))(
  "OrchestrationProjectionPipeline bounded shell summaries",
  (it) => {
    it.effect("does not hydrate historical activity payloads for streaming and tool events", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-bounded-summary");
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-bounded-summary-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-bounded-summary"),
          occurredAt: "2026-07-30T12:00:00.000Z",
          commandId: CommandId.make("cmd-bounded-summary-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bounded-summary-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-bounded-summary"),
            title: "Bounded Summary Project",
            workspaceRoot: "/tmp/project-bounded-summary",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-07-30T12:00:00.000Z",
            updatedAt: "2026-07-30T12:00:00.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-bounded-summary-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-07-30T12:00:01.000Z",
          commandId: CommandId.make("cmd-bounded-summary-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bounded-summary-2"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-bounded-summary"),
            title: "Bounded Summary Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-07-30T12:00:01.000Z",
            updatedAt: "2026-07-30T12:00:01.000Z",
          },
        });

        // A malformed historical payload stands in for the very large tool
        // payload history that previously got decoded after every token and
        // activity. Routine events must not read this row at all.
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES (
            'activity-bounded-summary-history',
            ${threadId},
            NULL,
            'info',
            'tool.completed',
            'Historical tool payload',
            '{malformed historical payload',
            1,
            '2026-07-30T12:00:01.500Z'
          )
        `;

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-bounded-summary-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-07-30T12:00:02.000Z",
          commandId: CommandId.make("cmd-bounded-summary-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bounded-summary-3"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-bounded-summary"),
            role: "assistant",
            text: "streamed text",
            turnId: TurnId.make("turn-bounded-summary"),
            streaming: true,
            createdAt: "2026-07-30T12:00:02.000Z",
            updatedAt: "2026-07-30T12:00:02.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.activity-appended",
          eventId: EventId.make("evt-bounded-summary-4"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-07-30T12:00:03.000Z",
          commandId: CommandId.make("cmd-bounded-summary-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bounded-summary-4"),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-bounded-summary-current"),
              tone: "info",
              kind: "tool.updated",
              summary: "Current tool update",
              payload: { detail: "small" },
              turnId: TurnId.make("turn-bounded-summary"),
              createdAt: "2026-07-30T12:00:03.000Z",
            },
          },
        });
        yield* appendAndProject({
          type: "thread.activity-appended",
          eventId: EventId.make("evt-bounded-summary-5"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-07-30T12:00:04.000Z",
          commandId: CommandId.make("cmd-bounded-summary-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-bounded-summary-5"),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-bounded-summary-nonstale-user-input-failure"),
              tone: "error",
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              payload: {
                requestId: "request-bounded-summary-never-opened",
                detail: "Provider timed out while responding to user input",
              },
              turnId: TurnId.make("turn-bounded-summary"),
              createdAt: "2026-07-30T12:00:04.000Z",
            },
          },
        });

        const threadRows = yield* sql<{
          readonly updatedAt: string;
          readonly pendingUserInputCount: number;
        }>`
          SELECT
            updated_at AS "updatedAt",
            pending_user_input_count AS "pendingUserInputCount"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(threadRows, [
          {
            updatedAt: "2026-07-30T12:00:04.000Z",
            pendingUserInputCount: 0,
          },
        ]);
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }

      // Settled lifecycle through the DB pipeline: thread.settled writes the
      // override + timestamp, thread.unsettled(user) flips to the active pin.
      yield* eventStore.append({
        type: "thread.settled",
        eventId: EventId.make("evt-settle-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-settle-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-settle-1"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          settledAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(settledRows, [
        { settledOverride: "settled", settledAt: "2026-01-01T00:00:01.000Z" },
      ]);

      yield* eventStore.append({
        type: "thread.unsettled",
        eventId: EventId.make("evt-unsettle-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: CommandId.make("cmd-unsettle-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-unsettle-1"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason: "user",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      const unsettledRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(unsettledRows, [{ settledOverride: "active", settledAt: null }]);
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-fork-")))(
  "OrchestrationProjectionPipeline attachment fork",
  (it) => {
    it.effect("copies attachment files into independent fork ownership", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const { attachmentsDir } = yield* ServerConfig;
        const now = "2026-01-01T00:00:00.000Z";
        const sourceThreadId = ThreadId.make("thread-fork-source");
        const targetThreadId = ThreadId.make("thread-fork-target");
        const sourceAttachmentId = "thread-fork-source-00000000-0000-4000-8000-000000000001";
        const targetAttachmentId = "thread-fork-target-00000000-0000-4000-8000-000000000001";
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-attachment-fork-1"),
          aggregateKind: "thread",
          aggregateId: sourceThreadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-attachment-fork-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-attachment-fork-1"),
          metadata: {},
          payload: {
            threadId: sourceThreadId,
            projectId: ProjectId.make("project-attachment-fork"),
            title: "Source",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachment-fork-2"),
          aggregateKind: "thread",
          aggregateId: sourceThreadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-attachment-fork-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-attachment-fork-2"),
          metadata: {},
          payload: {
            threadId: sourceThreadId,
            messageId: MessageId.make("message-attachment-fork"),
            role: "user",
            text: "Reference",
            attachments: [
              {
                type: "image",
                id: sourceAttachmentId,
                name: "reference.png",
                mimeType: "image/png",
                sizeBytes: 7,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        const sourcePath = path.join(attachmentsDir, `${sourceAttachmentId}.png`);
        const targetPath = path.join(attachmentsDir, `${targetAttachmentId}.png`);
        yield* fileSystem.writeFileString(sourcePath, "payload");

        yield* appendAndProject({
          type: "thread.forked",
          eventId: EventId.make("evt-attachment-fork-3"),
          aggregateKind: "thread",
          aggregateId: targetThreadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-attachment-fork-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-attachment-fork-3"),
          metadata: {},
          payload: {
            threadId: targetThreadId,
            sourceThreadId,
            projectId: ProjectId.make("project-attachment-fork"),
            title: "Fork",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        assert.isTrue(yield* exists(sourcePath));
        assert.isTrue(yield* exists(targetPath));
        assert.equal(yield* fileSystem.readFileString(targetPath), "payload");

        const sideChatThreadId = ThreadId.make("thread-fork-side");
        yield* appendAndProject({
          type: "thread.forked",
          eventId: EventId.make("evt-attachment-fork-4"),
          aggregateKind: "thread",
          aggregateId: sideChatThreadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-attachment-fork-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-attachment-fork-4"),
          metadata: {},
          payload: {
            threadId: sideChatThreadId,
            sourceThreadId,
            projectId: ProjectId.make("project-attachment-fork"),
            title: "Side chat",
            createdByThreadId: sourceThreadId,
            browserProfileThreadId: sourceThreadId,
            isSideChat: true,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        const sideChatRows = yield* sql<{
          readonly parentThreadId: string | null;
          readonly createdByThreadId: string | null;
          readonly browserProfileThreadId: string | null;
          readonly messageCount: number;
        }>`
          SELECT
            side_chat_parent_thread_id AS "parentThreadId",
            created_by_thread_id AS "createdByThreadId",
            browser_profile_thread_id AS "browserProfileThreadId",
            (
              SELECT COUNT(*)
              FROM projection_thread_messages
              WHERE thread_id = ${sideChatThreadId}
            ) AS "messageCount"
          FROM projection_threads
          WHERE thread_id = ${sideChatThreadId}
        `;
        assert.deepEqual(sideChatRows, [
          {
            parentThreadId: sourceThreadId,
            createdByThreadId: sourceThreadId,
            browserProfileThreadId: sourceThreadId,
            messageCount: 0,
          },
        ]);

        const siblingSideChatThreadId = ThreadId.make("thread-fork-side-sibling");
        yield* appendAndProject({
          type: "thread.forked",
          eventId: EventId.make("evt-attachment-fork-side-sibling"),
          aggregateKind: "thread",
          aggregateId: siblingSideChatThreadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-attachment-fork-side-sibling"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-attachment-fork-side-sibling"),
          metadata: {},
          payload: {
            threadId: siblingSideChatThreadId,
            sourceThreadId: sideChatThreadId,
            projectId: ProjectId.make("project-attachment-fork"),
            title: "Sibling side chat",
            createdByThreadId: sideChatThreadId,
            browserProfileThreadId: sourceThreadId,
            isSideChat: true,
            sideChatParentThreadId: sourceThreadId,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "agent",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        const siblingSideChatRows = yield* sql<{
          readonly parentThreadId: string | null;
          readonly createdByThreadId: string | null;
          readonly browserProfileThreadId: string | null;
          readonly messageCount: number;
        }>`
          SELECT
            side_chat_parent_thread_id AS "parentThreadId",
            created_by_thread_id AS "createdByThreadId",
            browser_profile_thread_id AS "browserProfileThreadId",
            (
              SELECT COUNT(*)
              FROM projection_thread_messages
              WHERE thread_id = ${siblingSideChatThreadId}
            ) AS "messageCount"
          FROM projection_threads
          WHERE thread_id = ${siblingSideChatThreadId}
        `;
        assert.deepEqual(siblingSideChatRows, [
          {
            parentThreadId: sourceThreadId,
            createdByThreadId: sideChatThreadId,
            browserProfileThreadId: sourceThreadId,
            messageCount: 0,
          },
        ]);

        yield* appendAndProject({
          type: "thread.deleted",
          eventId: EventId.make("evt-attachment-fork-5"),
          aggregateKind: "thread",
          aggregateId: sideChatThreadId,
          occurredAt: "2026-01-01T00:00:01.000Z",
          commandId: CommandId.make("cmd-attachment-fork-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-attachment-fork-5"),
          metadata: {},
          payload: {
            threadId: sideChatThreadId,
            deletedAt: "2026-01-01T00:00:01.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.meta-updated",
          eventId: EventId.make("evt-attachment-fork-6"),
          aggregateKind: "thread",
          aggregateId: sideChatThreadId,
          occurredAt: "2026-01-01T00:00:02.000Z",
          commandId: CommandId.make("cmd-attachment-fork-6"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-attachment-fork-6"),
          metadata: {},
          payload: {
            threadId: sideChatThreadId,
            isSideChat: false,
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
        });
        const promotedRows = yield* sql<{
          readonly deletedAt: string | null;
          readonly isSideChat: number;
          readonly parentThreadId: string | null;
        }>`
          SELECT
            deleted_at AS "deletedAt",
            is_side_chat AS "isSideChat",
            side_chat_parent_thread_id AS "parentThreadId"
          FROM projection_threads
          WHERE thread_id = ${sideChatThreadId}
        `;
        assert.deepEqual(promotedRows, [{ deletedAt: null, isSideChat: 0, parentThreadId: null }]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments"),
            messageId: MessageId.make("message-attachments"),
            role: "user",
            text: "Inspect this",
            delegationId: VmAgentDelegationId.make("delegation-projection-pipeline"),
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
          readonly delegationId: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson",
              delegation_id AS "delegationId"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.delegationId, "delegation-projection-pipeline");
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-safe-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("preserves mixed image attachment metadata as-is", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments-safe"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments-safe"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments-safe"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments-safe"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments-safe"),
            messageId: MessageId.make("message-attachments-safe"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-safe-att-1",
                name: "untrusted.exe",
                mimeType: "image/x-unknown",
                sizeBytes: 5,
              },
              {
                type: "image",
                id: "thread-attachments-safe-att-2",
                name: "not-image.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-safe-att-1",
            name: "untrusted.exe",
            mimeType: "image/x-unknown",
            sizeBytes: 5,
          },
          {
            type: "image",
            id: "thread-attachments-safe-att-2",
            name: "not-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const later = "2026-01-01T00:00:01.000Z";

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-clear-attachments-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Thread Clear Attachments",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.make("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-01T00:00:01.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-overwrite-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          projectId: ProjectId.make("project-overwrite"),
          title: "Thread Overwrite",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.make("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-rollback-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-rollback"),
          projectId: ProjectId.make("project-rollback"),
          title: "Thread Rollback",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-rollback-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-rollback"),
          occurredAt: now,
          commandId: CommandId.make("cmd-rollback-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-rollback-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-rollback"),
            messageId: MessageId.make("message-rollback"),
            role: "user",
            text: "Rollback me",
            attachments: [
              {
                type: "image",
                id: "thread-rollback-att-1",
                name: "rollback.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes unreferenced attachment files when a thread is reverted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";
      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-revert-files"),
          title: "Thread Revert Files",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-files/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-5"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-files/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });

      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-revert-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("removes thread attachment directory when thread is deleted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const { attachmentsDir } = yield* ServerConfig;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("Thread Delete.Files");
        const attachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000001";
        const otherThreadAttachmentId =
          "thread-delete-files-extra-00000000-0000-4000-8000-000000000002";

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-delete-files-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-delete-files"),
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-delete-files"),
            title: "Project Delete Files",
            workspaceRoot: "/tmp/project-delete-files",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-delete-files-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-2"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-delete-files"),
            title: "Thread Delete Files",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-delete-files-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-3"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-delete-files"),
            role: "user",
            text: "Delete",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "delete.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        const otherThreadAttachmentPath = path.join(
          attachmentsDir,
          `${otherThreadAttachmentId}.png`,
        );
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(threadAttachmentPath, "delete");
        yield* fileSystem.writeFileString(otherThreadAttachmentPath, "other-thread");
        assert.isTrue(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));

        yield* appendAndProject({
          type: "thread.deleted",
          eventId: EventId.make("evt-delete-files-4"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-4"),
          metadata: {},
          payload: {
            threadId,
            deletedAt: now,
          },
        });

        assert.isFalse(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-delete-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("ignores unsafe thread ids for attachment cleanup paths", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const now = "2026-01-01T00:00:00.000Z";
        const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
        const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
        const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
        yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
        yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
        yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

        yield* eventStore.append({
          type: "thread.deleted",
          eventId: EventId.make("evt-unsafe-thread-delete"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make(".."),
          occurredAt: now,
          commandId: CommandId.make("cmd-unsafe-thread-delete"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-unsafe-thread-delete"),
          metadata: {},
          payload: {
            threadId: ThreadId.make(".."),
            deletedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        assert.isTrue(yield* exists(attachmentsRootDir));
        assert.isTrue(yield* exists(attachmentsSentinelPath));
        assert.isTrue(yield* exists(stateDirSentinelPath));
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          projectId: ProjectId.make("project-a"),
          title: "Thread A",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [{ text: "hello world" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps the turn running across interim assistant messages until the session ends", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-lifecycle");
      const turnId = TurnId.make("turn-lifecycle-1");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-tl1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-tl1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-lifecycle"),
          title: "Turn lifecycle",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-opus",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-tl2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      });

      // Interim assistant message completes mid-turn (commentary between
      // tool calls) — the turn must stay running and unsettled.
      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-tl3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:05.000Z",
        commandId: CommandId.make("cmd-tl3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-tl-interim"),
          role: "assistant",
          text: "interim commentary",
          turnId,
          streaming: false,
          createdAt: "2026-01-01T00:00:05.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
      });

      yield* projectionPipeline.bootstrap;

      const runningRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(runningRows, [{ state: "running", completedAt: null }]);

      // The session leaving "running" is the turn-end signal.
      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:01:00.000Z",
        commandId: CommandId.make("cmd-tl4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl4"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(settledRows, [
        { state: "completed", completedAt: "2026-01-01T00:01:00.000Z" },
      ]);

      // A failover can briefly report ready before adopting the same active
      // provider turn again. The new running session is authoritative and must
      // reopen that turn rather than preserving the stale completed state.
      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:01:01.000Z",
        commandId: CommandId.make("cmd-tl5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl5"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:01:01.000Z",
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const reopenedRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(reopenedRows, [{ state: "running", completedAt: null }]);

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:01:02.000Z",
        commandId: CommandId.make("cmd-tl6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl6"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:01:02.000Z",
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const interruptedRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(interruptedRows, [
        { state: "incomplete", completedAt: "2026-01-01T00:01:02.000Z" },
      ]);
      const threadRows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threadRows, [{ latestTurnId: turnId }]);
    }),
  );

  it.effect("settles a superseded running turn when a new turn becomes active", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-supersede");
      const oldTurnId = TurnId.make("turn-superseded");
      const newTurnId = TurnId.make("turn-steer");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-ts1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-ts1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-ts1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-supersede"),
          title: "Turn supersede",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "big-pickle",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const appendRunningSessionSet = (eventId: string, turnId: TurnId, updatedAt: string) =>
        eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: updatedAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "opencode",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt,
            },
          },
        });

      yield* appendRunningSessionSet("evt-ts2", oldTurnId, "2026-01-01T00:00:01.000Z");
      // A steer: a new turn becomes active without the provider ever
      // completing the previous one.
      yield* appendRunningSessionSet("evt-ts3", newTurnId, "2026-01-01T00:00:30.000Z");

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT turn_id AS "turnId", state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY requested_at
      `;
      assert.deepEqual(rows, [
        { turnId: oldTurnId, state: "completed", completedAt: "2026-01-01T00:00:30.000Z" },
        { turnId: newTurnId, state: "running", completedAt: null },
      ]);
    }),
  );

  it.effect("does not regress latest_turn_id when an older checkpoint is projected late", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-late-checkpoint-pointer");
      const olderTurnId = TurnId.make("turn-older-checkpoint");
      const newerTurnId = TurnId.make("turn-newer-stop");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-lcp-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:00.000Z",
        commandId: CommandId.make("cmd-lcp-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-lcp-1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-late-checkpoint-pointer"),
          title: "Late checkpoint pointer",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          runtimeMode: "full-access",
          interactionMode: "agent",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-lcp-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:01:00.000Z",
        commandId: CommandId.make("cmd-lcp-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-lcp-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: newerTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        },
      });
      yield* eventStore.append({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-lcp-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:01:01.000Z",
        commandId: CommandId.make("cmd-lcp-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-lcp-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: olderTurnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/late/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-older-checkpoint"),
          completedAt: "2026-01-01T00:00:30.000Z",
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(rows, [{ latestTurnId: newerTurnId }]);
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-empty-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          projectId: ProjectId.make("project-empty"),
          title: "Thread Empty",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );

  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.make("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-conflict-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.make("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            projectId: ProjectId.make("project-conflict"),
            title: "Thread Conflict",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-interrupt-requested",
          eventId: EventId.make("evt-conflict-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.make("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-interrupted"),
            createdAt: "2026-02-26T13:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-conflict-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.make("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            messageId: MessageId.make("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-conflict-5"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.make("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-5"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-conflict/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;
        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
          { turnId: "turn-interrupted", checkpointTurnCount: null, status: "interrupted" },
        ]);
      }),
  );

  it.effect("clears stale pending approvals from projected shell summaries", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stale-approval"),
        occurredAt: "2026-02-26T12:30:00.000Z",
        commandId: CommandId.make("cmd-stale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stale-approval"),
          title: "Project Stale Approval",
          workspaceRoot: "/tmp/project-stale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:30:00.000Z",
          updatedAt: "2026-02-26T12:30:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:01.000Z",
        commandId: CommandId.make("cmd-stale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          projectId: ProjectId.make("project-stale-approval"),
          title: "Thread Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:30:01.000Z",
          updatedAt: "2026-02-26T12:30:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:02.000Z",
        commandId: CommandId.make("cmd-stale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-stale-1",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:03.000Z",
        commandId: CommandId.make("cmd-stale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-failed"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-stale-1",
              detail: "Unknown pending permission request: approval-request-stale-1",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:03.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id = 'approval-request-stale-1'
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-stale-1",
          status: "resolved",
          resolvedAt: "2026-02-26T12:30:03.000Z",
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-stale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 0 }]);
    }),
  );

  it.effect("clears stale pending user input from projected shell summaries", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stale-user-input-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stale-user-input"),
        occurredAt: "2026-02-26T12:35:00.000Z",
        commandId: CommandId.make("cmd-stale-user-input-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stale-user-input"),
          title: "Project Stale User Input",
          workspaceRoot: "/tmp/project-stale-user-input",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:35:00.000Z",
          updatedAt: "2026-02-26T12:35:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stale-user-input-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:01.000Z",
        commandId: CommandId.make("cmd-stale-user-input-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          projectId: ProjectId.make("project-stale-user-input"),
          title: "Thread Stale User Input",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:35:01.000Z",
          updatedAt: "2026-02-26T12:35:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-user-input-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:02.000Z",
        commandId: CommandId.make("cmd-stale-user-input-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          activity: {
            id: EventId.make("activity-stale-user-input-requested"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-request-stale-1",
              questions: [
                {
                  id: "sandbox_mode",
                  header: "Sandbox",
                  question: "Which mode should be used?",
                  options: [
                    {
                      label: "workspace-write",
                      description: "Allow workspace writes only",
                    },
                  ],
                },
              ],
            },
            turnId: null,
            createdAt: "2026-02-26T12:35:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-user-input-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:03.000Z",
        commandId: CommandId.make("cmd-stale-user-input-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          activity: {
            id: EventId.make("activity-stale-user-input-failed"),
            tone: "error",
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            payload: {
              requestId: "user-input-request-stale-1",
              detail:
                "Provider adapter request failed (codex) for item/tool/requestUserInput: Unknown pending Codex user input request: user-input-request-stale-1",
            },
            turnId: null,
            createdAt: "2026-02-26T12:35:03.000Z",
          },
        },
      });

      const threadRows = yield* sql<{
        readonly pendingUserInputCount: number;
      }>`
        SELECT pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        WHERE thread_id = 'thread-stale-user-input'
      `;
      assert.deepEqual(threadRows, [{ pendingUserInputCount: 0 }]);
    }),
  );

  it.effect("ignores non-stale provider approval response failures", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-nonstale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:00.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Project Non-Stale Approval",
          workspaceRoot: "/tmp/project-nonstale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:45:00.000Z",
          updatedAt: "2026-02-26T12:45:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-nonstale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:01.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Thread Non-Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:45:01.000Z",
          updatedAt: "2026-02-26T12:45:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:02.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-nonstale-existing",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:03.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-existing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-existing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: TurnId.make("turn-nonstale-failure"),
            createdAt: "2026-02-26T12:45:03.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:04.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-missing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-missing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:04.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly turnId: string | null;
        readonly createdAt: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          turn_id AS "turnId",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id IN (
          'approval-request-nonstale-existing',
          'approval-request-nonstale-missing'
        )
        ORDER BY request_id
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-nonstale-existing",
          status: "pending",
          turnId: null,
          createdAt: "2026-02-26T12:45:02.000Z",
          resolvedAt: null,
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-nonstale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 1 }]);
    }),
  );

  it.effect("does not fallback-retain messages whose turnId is removed by revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert"),
        occurredAt: "2026-02-26T12:00:00.000Z",
        commandId: CommandId.make("cmd-revert-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert"),
          title: "Project Revert",
          workspaceRoot: "/tmp/project-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:00:00.000Z",
          updatedAt: "2026-02-26T12:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: CommandId.make("cmd-revert-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          projectId: ProjectId.make("project-revert"),
          title: "Thread Revert",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:00:01.000Z",
          updatedAt: "2026-02-26T12:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: CommandId.make("cmd-revert-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-keep"),
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: CommandId.make("cmd-revert-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-keep"),
          role: "assistant",
          text: "kept",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: CommandId.make("cmd-revert-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-remove"),
          completedAt: "2026-02-26T12:00:03.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-6"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.050Z",
        commandId: CommandId.make("cmd-revert-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-6"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("user-remove"),
          role: "user",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.050Z",
          updatedAt: "2026-02-26T12:00:03.050Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-7"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.100Z",
        commandId: CommandId.make("cmd-revert-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-7"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-remove"),
          role: "assistant",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.100Z",
          updatedAt: "2026-02-26T12:00:03.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-8"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:04.000Z",
        commandId: CommandId.make("cmd-revert-8"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-8"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnCount: 1,
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly role: string;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_thread_messages
        WHERE thread_id = 'thread-revert'
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "assistant-keep",
          turnId: "turn-1",
          role: "assistant",
        },
      ]);
    }),
  );
});

it.layer(makeProjectionPipelinePrefixedTestLayer("t3-pending-turn-terminal-test-"))(
  "OrchestrationProjectionPipeline pending turn cleanup",
  (it) => {
    it.effect("preserves queued turn starts when an unrelated session becomes terminal", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;

        for (const [index, status] of (["error", "interrupted", "stopped"] as const).entries()) {
          const threadId = ThreadId.make(`thread-terminal-${status}`);
          const requestedAt = `2026-02-26T14:00:0${index}.000Z`;
          yield* eventStore.append({
            type: "thread.turn-start-requested",
            eventId: EventId.make(`evt-terminal-pending-${status}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: requestedAt,
            commandId: CommandId.make(`cmd-terminal-pending-${status}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-terminal-pending-${status}`),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make(`message-terminal-${status}`),
              runtimeMode: "approval-required",
              createdAt: requestedAt,
            },
          });
          yield* eventStore.append({
            type: "thread.session-set",
            eventId: EventId.make(`evt-terminal-session-${status}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: requestedAt,
            commandId: CommandId.make(`cmd-terminal-session-${status}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-terminal-session-${status}`),
            metadata: {},
            payload: {
              threadId,
              session: {
                threadId,
                status,
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: status === "error" ? "startup failed" : null,
                updatedAt: requestedAt,
              },
            },
          });
        }

        yield* projectionPipeline.bootstrap;

        const pendingRows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId"
          FROM projection_turns
          WHERE turn_id IS NULL
            AND state = 'pending'
        `;
        assert.deepEqual(pendingRows.map((row) => row.threadId).sort(), [
          "thread-terminal-error",
          "thread-terminal-interrupted",
          "thread-terminal-stopped",
        ]);
      }),
    );

    it.effect("adopts multiple queued starts FIFO without repeated-session queue loss", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-pending-fifo");
        const messageB = MessageId.make("message-pending-b");
        const messageC = MessageId.make("message-pending-c");
        const turnB = TurnId.make("turn-pending-b");
        const turnC = TurnId.make("turn-pending-c");

        for (const [index, messageId] of [messageB, messageC].entries()) {
          const createdAt = `2026-02-26T14:30:0${index}.000Z`;
          yield* eventStore.append({
            type: "thread.turn-start-requested",
            eventId: EventId.make(`evt-pending-fifo-start-${index}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: createdAt,
            commandId: CommandId.make(`cmd-pending-fifo-start-${index}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-pending-fifo-start-${index}`),
            metadata: {},
            payload: {
              threadId,
              messageId,
              runtimeMode: "approval-required",
              createdAt,
            },
          });
        }
        yield* projectionPipeline.bootstrap;

        const appendSession = (
          suffix: string,
          status: "running" | "ready",
          activeTurnId: TurnId | null,
          updatedAt: string,
        ) =>
          eventStore.append({
            type: "thread.session-set",
            eventId: EventId.make(`evt-pending-fifo-session-${suffix}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: updatedAt,
            commandId: CommandId.make(`cmd-pending-fifo-session-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-pending-fifo-session-${suffix}`),
            metadata: {},
            payload: {
              threadId,
              session: {
                threadId,
                status,
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId,
                lastError: null,
                updatedAt,
              },
            },
          });

        yield* appendSession("b-running", "running", turnB, "2026-02-26T14:30:02.000Z");
        yield* projectionPipeline.bootstrap;
        yield* appendSession("b-repeated", "running", turnB, "2026-02-26T14:30:03.000Z");
        yield* projectionPipeline.bootstrap;

        let pending = yield* sql<{ readonly messageId: string }>`
          SELECT pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NULL AND state = 'pending'
        `;
        assert.deepEqual(pending, [{ messageId: messageC }]);

        yield* appendSession("b-ready", "ready", null, "2026-02-26T14:30:04.000Z");
        yield* appendSession("c-running", "running", turnC, "2026-02-26T14:30:05.000Z");
        yield* projectionPipeline.bootstrap;

        pending = yield* sql<{ readonly messageId: string }>`
          SELECT pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NULL AND state = 'pending'
        `;
        assert.deepEqual(pending, []);
        const concrete = yield* sql<{
          readonly turnId: string;
          readonly messageId: string | null;
        }>`
          SELECT turn_id AS "turnId", pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
          ORDER BY turn_id ASC
        `;
        assert.deepEqual(concrete, [
          { turnId: turnB, messageId: messageB },
          { turnId: turnC, messageId: messageC },
        ]);
      }),
    );

    it.effect("a new user turn removes a legacy orphan before adopting its own message", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-new-turn-repairs-orphan");
        const orphanMessageId = MessageId.make("message-legacy-orphan");
        const newMessageId = MessageId.make("message-after-legacy-orphan");
        const newTurnId = TurnId.make("turn-after-legacy-orphan");

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, branch, worktree_path, latest_turn_id,
            created_at, updated_at, deleted_at, runtime_mode, interaction_mode,
            model_selection_json, latest_user_message_at,
            pending_approval_count, pending_user_input_count
          ) VALUES (
            ${threadId}, 'project-new-turn-repair', 'New Turn Repair', NULL, NULL, NULL,
            '2026-02-26T14:34:00.000Z', '2026-02-26T14:34:00.000Z', NULL,
            'full-access', 'default',
            '{"instanceId":"codex","model":"gpt-5.6-sol"}',
            '2026-02-26T14:36:00.000Z', 0, 0
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming,
            created_at, updated_at
          ) VALUES (
            ${newMessageId}, ${threadId}, NULL, 'user', 'Continue with the next task', 0,
            '2026-02-26T14:36:00.000Z', '2026-02-26T14:36:00.000Z'
          )
        `;
        // Simulates the exact old-build state: visible queue row, but no
        // durable owner capable of ever dispatching or clearing it.
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (
            ${threadId}, NULL, ${orphanMessageId}, NULL, 'pending',
            '2026-02-26T14:35:00.000Z', NULL, NULL, '[]'
          )
        `;
        yield* eventStore.append({
          type: "thread.turn-start-requested",
          eventId: EventId.make("evt-new-turn-repairs-orphan"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-02-26T14:36:00.000Z",
          commandId: CommandId.make("cmd-new-turn-repairs-orphan"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-new-turn-repairs-orphan"),
          metadata: {},
          payload: {
            threadId,
            messageId: newMessageId,
            runtimeMode: "approval-required",
            createdAt: "2026-02-26T14:36:00.000Z",
          },
        });
        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make("evt-new-turn-repairs-orphan-running"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-02-26T14:36:01.000Z",
          commandId: CommandId.make("cmd-new-turn-repairs-orphan-running"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-new-turn-repairs-orphan-running"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: newTurnId,
              lastError: null,
              updatedAt: "2026-02-26T14:36:01.000Z",
            },
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly turnId: string | null;
          readonly messageId: string | null;
        }>`
          SELECT turn_id AS "turnId", pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = ${threadId}
          ORDER BY row_id ASC
        `;
        assert.deepEqual(rows, [{ turnId: newTurnId, messageId: newMessageId }]);
      }),
    );

    it.effect("does not let a repeated old turn adopt a message queued after it began", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-repeated-old-turn");
        const oldTurnId = TurnId.make("turn-repeated-old");
        const newMessageId = MessageId.make("message-after-old-turn");

        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (
            ${threadId}, ${oldTurnId}, NULL, NULL, 'running',
            '2026-02-26T14:40:00.000Z', '2026-02-26T14:40:00.000Z', NULL, '[]'
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (
            ${threadId}, NULL, ${newMessageId}, NULL, 'pending',
            '2026-02-26T14:41:00.000Z', NULL, NULL, '[]'
          )
        `;
        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make("evt-repeated-old-turn"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-02-26T14:41:01.000Z",
          commandId: CommandId.make("cmd-repeated-old-turn"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-repeated-old-turn"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: oldTurnId,
              lastError: null,
              updatedAt: "2026-02-26T14:41:01.000Z",
            },
          },
        });
        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly turnId: string | null;
          readonly messageId: string | null;
        }>`
          SELECT turn_id AS "turnId", pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = ${threadId}
          ORDER BY row_id ASC
        `;
        assert.deepEqual(rows, [
          { turnId: oldTurnId, messageId: null },
          { turnId: null, messageId: newMessageId },
        ]);
      }),
    );

    it.effect("retires the exact pending placeholder when a delivery receipt proves a steer", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-delivered-steer");
        const hostTurnId = TurnId.make("turn-delivered-steer-host");
        const hostMessageId = MessageId.make("message-delivered-steer-host");
        const steeredMessageId = MessageId.make("message-delivered-steer-pending");
        const requestedAt = "2026-02-26T15:00:00.000Z";

        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES
            (
              ${threadId}, ${hostTurnId}, ${hostMessageId}, NULL, 'running',
              '2026-02-26T14:59:00.000Z', '2026-02-26T14:59:00.000Z', NULL, '[]'
            ),
            (
              ${threadId}, NULL, ${steeredMessageId}, NULL, 'pending',
              ${requestedAt}, NULL, NULL, '[]'
            )
        `;
        yield* sql`
          INSERT INTO thread_work_obligations (
            obligation_id, thread_id, source_turn_id, kind, state,
            provider_instance_id, attempt, next_attempt_at, claimed_at,
            lease_expires_at, blocked_reason, created_at, updated_at
          ) VALUES (
            'work-delivered-steer', ${threadId}, ${`turn-start:${steeredMessageId}`},
            'active-turn-recovery', 'completed', 'codex', 0, NULL, NULL, NULL,
            ${ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON}, ${requestedAt}, ${requestedAt}
          )
        `;
        yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make("evt-delivered-steer"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-02-26T15:00:00.100Z",
          commandId: CommandId.make("cmd-delivered-steer"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delivered-steer"),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-delivered-steer"),
              tone: "info",
              kind: "message.delivered",
              summary: "Message delivered to the provider",
              payload: { messageId: steeredMessageId },
              // Claude's prompt-stream delivery receipt intentionally has no
              // provider turn id; the exact pre-claim marker is authoritative.
              turnId: null,
              createdAt: "2026-02-26T15:00:00.100Z",
            },
          },
        });

        yield* projectionPipeline.bootstrap;
        yield* projectionPipeline.bootstrap;

        const turns = yield* sql<{
          readonly turnId: string | null;
          readonly pendingMessageId: string | null;
        }>`
          SELECT turn_id AS "turnId", pending_message_id AS "pendingMessageId"
          FROM projection_turns
          WHERE thread_id = ${threadId}
          ORDER BY row_id ASC
        `;
        assert.deepEqual(turns, [{ turnId: hostTurnId, pendingMessageId: hostMessageId }]);

        const obligations = yield* sql<{
          readonly state: string;
          readonly blockedReason: string | null;
        }>`
          SELECT state, blocked_reason AS "blockedReason"
          FROM thread_work_obligations
          WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(obligations, [{ state: "completed", blockedReason: null }]);
      }),
    );

    it.effect("keeps an ordinary delivery placeholder until the concrete turn adopts it", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-ordinary-delivery-receipt");
        const messageId = MessageId.make("message-ordinary-delivery-receipt");
        const turnId = TurnId.make("turn-ordinary-delivery-receipt");
        const requestedAt = "2026-02-26T15:05:00.000Z";

        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (
            ${threadId}, NULL, ${messageId}, NULL, 'pending',
            ${requestedAt}, NULL, NULL, '[]'
          )
        `;
        yield* sql`
          INSERT INTO thread_work_obligations (
            obligation_id, thread_id, source_turn_id, kind, state,
            provider_instance_id, attempt, next_attempt_at, claimed_at,
            lease_expires_at, blocked_reason, created_at, updated_at
          ) VALUES (
            'work-ordinary-delivery', ${threadId}, ${`turn-start:${messageId}`},
            'active-turn-recovery', 'executing', 'claudeAgent', 1, NULL,
            ${requestedAt}, '2026-02-26T15:06:00.000Z', NULL,
            ${requestedAt}, ${requestedAt}
          )
        `;
        yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make("evt-ordinary-delivery-receipt"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-02-26T15:05:00.100Z",
          commandId: CommandId.make("cmd-ordinary-delivery-receipt"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-ordinary-delivery-receipt"),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-ordinary-delivery-receipt"),
              tone: "info",
              kind: "message.delivered",
              summary: "Message delivered to the provider",
              payload: { messageId },
              turnId: null,
              createdAt: "2026-02-26T15:05:00.100Z",
            },
          },
        });

        yield* projectionPipeline.bootstrap;
        let pending = yield* sql<{ readonly messageId: string }>`
          SELECT pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NULL AND state = 'pending'
        `;
        assert.deepEqual(pending, [{ messageId }]);

        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make("evt-ordinary-delivery-running"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-02-26T15:05:00.200Z",
          commandId: CommandId.make("cmd-ordinary-delivery-running"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-ordinary-delivery-running"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "claude",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: "2026-02-26T15:05:00.200Z",
            },
          },
        });
        yield* projectionPipeline.bootstrap;

        pending = yield* sql<{ readonly messageId: string }>`
          SELECT pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NULL AND state = 'pending'
        `;
        assert.deepEqual(pending, []);
        const concrete = yield* sql<{ readonly messageId: string | null }>`
          SELECT pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        `;
        assert.deepEqual(concrete, [{ messageId }]);
      }),
    );

    it.effect("does not let a late steer receipt delete a newer pending message", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-late-steer-receipt");
        const hostTurnId = TurnId.make("turn-late-steer-host");
        const oldMessageId = MessageId.make("message-old-steer");
        const currentMessageId = MessageId.make("message-current-pending");

        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES
            (
              ${threadId}, ${hostTurnId}, 'message-host-source', NULL, 'running',
              '2026-02-26T15:09:00.000Z', '2026-02-26T15:09:00.000Z', NULL, '[]'
            ),
            (
              ${threadId}, NULL, ${oldMessageId}, NULL, 'pending',
              '2026-02-26T15:09:30.000Z', NULL, NULL, '[]'
            ),
            (
              ${threadId}, NULL, ${currentMessageId}, NULL, 'pending',
              '2026-02-26T15:10:00.000Z', NULL, NULL, '[]'
            )
        `;
        yield* sql`
          INSERT INTO thread_work_obligations (
            obligation_id, thread_id, source_turn_id, kind, state,
            provider_instance_id, attempt, next_attempt_at, claimed_at,
            lease_expires_at, blocked_reason, created_at, updated_at
          ) VALUES (
            'work-old-steer', ${threadId}, ${`turn-start:${oldMessageId}`},
            'active-turn-recovery', 'completed', 'codex', 0, NULL, NULL, NULL,
            ${ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON},
            '2026-02-26T15:09:30.000Z', '2026-02-26T15:09:30.000Z'
          )
        `;
        yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make("evt-late-steer-receipt"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-02-26T15:10:00.100Z",
          commandId: CommandId.make("cmd-late-steer-receipt"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-late-steer-receipt"),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-late-steer-receipt"),
              tone: "info",
              kind: "message.delivered",
              summary: "Message delivered to the provider",
              payload: { messageId: oldMessageId },
              turnId: hostTurnId,
              createdAt: "2026-02-26T15:10:00.100Z",
            },
          },
        });

        yield* projectionPipeline.bootstrap;

        const pending = yield* sql<{ readonly pendingMessageId: string }>`
          SELECT pending_message_id AS "pendingMessageId"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NULL AND state = 'pending'
        `;
        assert.deepEqual(pending, [{ pendingMessageId: currentMessageId }]);
      }),
    );
  },
);

it.effect("restores pending turn-start metadata across projection pipeline restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const threadId = ThreadId.make("thread-restart");
    const turnId = TurnId.make("turn-restart");
    const messageId = MessageId.make("message-restart");
    const sourcePlanThreadId = ThreadId.make("thread-plan-source");
    const sourcePlanId = "plan-source";
    const turnStartedAt = "2026-02-26T14:00:00.000Z";
    const sessionSetAt = "2026-02-26T14:00:05.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.make("evt-restart-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnStartedAt,
        commandId: CommandId.make("cmd-restart-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          sourceProposedPlan: {
            threadId: sourcePlanThreadId,
            planId: sourcePlanId,
          },
          runtimeMode: "approval-required",
          createdAt: turnStartedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
    }).pipe(Effect.provide(firstProjectionLayer));

    const turnRows = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-restart-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: sessionSetAt,
        commandId: CommandId.make("cmd-restart-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);

      return yield* sql<{
        readonly turnId: string;
        readonly userMessageId: string | null;
        readonly sourceProposedPlanThreadId: string | null;
        readonly sourceProposedPlanId: string | null;
        readonly startedAt: string;
      }>`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          started_at AS "startedAt"
        FROM projection_turns
        WHERE turn_id = ${turnId}
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.deepEqual(turnRows, [
      {
        turnId: "turn-restart",
        userMessageId: "message-restart",
        sourceProposedPlanThreadId: "thread-plan-source",
        sourceProposedPlanId: "plan-source",
        startedAt: turnStartedAt,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-projection-pipeline-restart-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.layer(makeProjectionPipelinePrefixedTestLayer("t3-actionable-proposed-plan-summary-test-"))(
  "OrchestrationProjectionPipeline actionable proposed plan summary",
  (it) => {
    it.effect("marks only the latest turn's unimplemented plan as actionable", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        const projectId = ProjectId.make("project-actionable-plan");
        const threadId = ThreadId.make("thread-actionable-plan");
        const firstTurnId = TurnId.make("turn-actionable-plan-1");
        const secondTurnId = TurnId.make("turn-actionable-plan-2");
        const planId = "plan-actionable-1";

        const readFlag = () =>
          sql<{ readonly hasActionableProposedPlan: number }>`
            SELECT has_actionable_proposed_plan AS "hasActionableProposedPlan"
            FROM projection_threads
            WHERE thread_id = ${threadId}
          `;

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-actionable-plan-1"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-01T12:00:00.000Z",
          commandId: CommandId.make("cmd-actionable-plan-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-actionable-plan-1"),
          metadata: {},
          payload: {
            projectId,
            title: "Actionable Plan Project",
            workspaceRoot: "/tmp/project-actionable-plan",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-01T12:00:00.000Z",
            updatedAt: "2026-03-01T12:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-actionable-plan-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-01T12:00:01.000Z",
          commandId: CommandId.make("cmd-actionable-plan-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-actionable-plan-2"),
          metadata: {},
          payload: {
            threadId,
            projectId,
            title: "Actionable Plan Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "plan",
            branch: null,
            worktreePath: null,
            createdAt: "2026-03-01T12:00:01.000Z",
            updatedAt: "2026-03-01T12:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.session-set",
          eventId: EventId.make("evt-actionable-plan-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-01T12:00:02.000Z",
          commandId: CommandId.make("cmd-actionable-plan-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-actionable-plan-3"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: firstTurnId,
              lastError: null,
              updatedAt: "2026-03-01T12:00:02.000Z",
            },
          },
        });

        yield* appendAndProject({
          type: "thread.proposed-plan-upserted",
          eventId: EventId.make("evt-actionable-plan-4"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-01T12:00:03.000Z",
          commandId: CommandId.make("cmd-actionable-plan-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-actionable-plan-4"),
          metadata: {},
          payload: {
            threadId,
            proposedPlan: {
              id: planId,
              turnId: firstTurnId,
              planMarkdown: "# Ship the leftover plan",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-03-01T12:00:03.000Z",
              updatedAt: "2026-03-01T12:00:03.000Z",
            },
          },
        });

        assert.deepEqual(yield* readFlag(), [{ hasActionableProposedPlan: 1 }]);

        yield* appendAndProject({
          type: "thread.session-set",
          eventId: EventId.make("evt-actionable-plan-5"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-03-01T12:00:04.000Z",
          commandId: CommandId.make("cmd-actionable-plan-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-actionable-plan-5"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: secondTurnId,
              lastError: null,
              updatedAt: "2026-03-01T12:00:04.000Z",
            },
          },
        });

        assert.deepEqual(yield* readFlag(), [{ hasActionableProposedPlan: 0 }]);
      }),
    );
  },
);

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  const createAgentThread = (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly suffix: string;
  }) =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`cmd-${input.suffix}-project`),
        projectId: input.projectId,
        title: `Agent cleanup ${input.suffix}`,
        workspaceRoot: `/tmp/project-${input.suffix}`,
        defaultModelSelection: {
          instanceId: input.providerInstanceId,
          model: "gpt-5.6-sol",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`cmd-${input.suffix}-thread`),
        threadId: input.threadId,
        projectId: input.projectId,
        title: `Agent cleanup ${input.suffix}`,
        modelSelection: {
          instanceId: input.providerInstanceId,
          model: "gpt-5.6-sol",
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

  const queueCleanupAfterContinuableTurn = (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly sourceTurnId: TurnId;
    readonly cleanupMessageId: MessageId;
    readonly suffix: string;
  }) =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sourceMessageId = MessageId.make(`message-${input.suffix}-source`);
      const assistantMessageId = MessageId.make(`assistant-${input.suffix}-source`);
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-${input.suffix}-source-start`),
        threadId: input.threadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Continue autonomously.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-${input.suffix}-source-running`),
        threadId: input.threadId,
        session: {
          threadId: input.threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: input.providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: input.sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`cmd-${input.suffix}-source-delta`),
        threadId: input.threadId,
        messageId: assistantMessageId,
        delta: "This phase is complete and autonomous work remains.",
        turnId: input.sourceTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`cmd-${input.suffix}-source-complete`),
        threadId: input.threadId,
        messageId: assistantMessageId,
        turnId: input.sourceTurnId,
        createdAt: "2026-01-01T00:00:03.500Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`browser-tab-cleanup-command:${input.suffix}`),
        threadId: input.threadId,
        session: {
          threadId: input.threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: input.providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        atomicFollowupTurn: {
          sourceTurnId: input.sourceTurnId,
          message: {
            messageId: input.cleanupMessageId,
            role: "user",
            text: "Browser tab check: 2 tabs are open.",
            inputOrigin: "agent-loop",
            attachments: [],
          },
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      });
    });

  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-live-project"),
        projectId: ProjectId.make("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-scripts-project-create"),
        projectId: ProjectId.make("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-scripts-project-update"),
        projectId: ProjectId.make("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5"}',
        },
      ]);
    }),
  );

  it.effect("projects durable work for user turns without duplicating Agent continuations", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-thread-work");
      const threadId = ThreadId.make("thread-thread-work");
      const incompleteTurnId = TurnId.make("turn-incomplete-thread-work");
      const providerInstanceId = ProviderInstanceId.make("codex");

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-thread-work-project-create"),
        projectId,
        title: "Thread Work Project",
        workspaceRoot: "/tmp/project-thread-work",
        defaultModelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5.6-sol",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-work-thread-create"),
        threadId,
        projectId,
        title: "Thread Work Thread",
        modelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5.6-sol",
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const dispatchTurn = (input: {
        readonly commandId: string;
        readonly messageId: string;
        readonly text: string;
        readonly inputOrigin?: "agent-loop";
        readonly createdAt: string;
      }) =>
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(input.commandId),
          threadId,
          message: {
            messageId: MessageId.make(input.messageId),
            role: "user",
            text: input.text,
            ...(input.inputOrigin === undefined ? {} : { inputOrigin: input.inputOrigin }),
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          createdAt: input.createdAt,
        });

      yield* dispatchTurn({
        commandId: "cmd-thread-work-first",
        messageId: "message-thread-work-first",
        text: "First explicit user turn",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* dispatchTurn({
        commandId: "cmd-thread-work-second",
        messageId: "message-thread-work-second",
        text: "Second explicit user turn",
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      yield* dispatchTurn({
        commandId: `startup-auto-resume-command:${threadId}:${incompleteTurnId}`,
        messageId: `startup-auto-resume-message:${threadId}:${incompleteTurnId}`,
        text: "Please resume your current task using the context provided and pick up exactly where you left off.",
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      // Only the continuation's own auto-resume prompts skip the obligation.
      yield* dispatchTurn({
        commandId: "cmd-thread-work-agent-loop",
        messageId: "agent-auto-resume-message:thread-work:turn-prior",
        text: "Internal Agent continuation",
        inputOrigin: "agent-loop",
        createdAt: "2026-01-01T00:00:04.000Z",
      });
      // A scheduled VM-agent task prompt is also agent-loop, but nothing else
      // owns its launch — excluding it here meant its turn never started.
      yield* dispatchTurn({
        commandId: "cmd-thread-work-scheduled-task",
        messageId: "vm-task:run-thread-work",
        text: "Scheduled task prompt",
        inputOrigin: "agent-loop",
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      const obligations = yield* sql<{
        readonly sourceTurnId: string;
        readonly kind: string;
        readonly state: string;
        readonly blockedReason: string | null;
      }>`
        SELECT
          source_turn_id AS "sourceTurnId",
          kind,
          state,
          blocked_reason AS "blockedReason"
        FROM thread_work_obligations
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC
      `;

      // Earlier user messages stay pending: each is a real message the UI has
      // marked "Sent", and they deliver FIFO once the thread frees up. Only
      // synthetic work is superseded by newer sends.
      assert.deepEqual(obligations, [
        {
          sourceTurnId: "turn-start:message-thread-work-first",
          kind: "active-turn-recovery",
          state: "pending",
          blockedReason: null,
        },
        {
          sourceTurnId: "turn-start:message-thread-work-second",
          kind: "active-turn-recovery",
          state: "pending",
          blockedReason: null,
        },
        {
          // The scheduled-task send is a real parked delivery, so it
          // supersedes the synthetic resume exactly as a typed message would.
          sourceTurnId: "turn-incomplete-thread-work",
          kind: "startup-resume",
          state: "cancelled",
          blockedReason: "superseded by user turn",
        },
        {
          sourceTurnId: "turn-start:vm-task:run-thread-work",
          kind: "active-turn-recovery",
          state: "pending",
          blockedReason: null,
        },
      ]);

      // An interrupt (the user's Stop button) ends current work — including
      // any queued synthetic resume — but must not drop parked user messages.
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-thread-work-interrupt"),
        threadId,
        turnId: incompleteTurnId,
        createdAt: "2026-01-01T00:00:06.000Z",
      });

      const afterInterrupt = yield* sql<{
        readonly sourceTurnId: string;
        readonly kind: string;
        readonly state: string;
      }>`
        SELECT
          source_turn_id AS "sourceTurnId",
          kind,
          state
        FROM thread_work_obligations
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC
      `;
      assert.deepEqual(afterInterrupt, [
        {
          sourceTurnId: "turn-start:message-thread-work-first",
          kind: "active-turn-recovery",
          state: "pending",
        },
        {
          sourceTurnId: "turn-start:message-thread-work-second",
          kind: "active-turn-recovery",
          state: "pending",
        },
        {
          sourceTurnId: "turn-incomplete-thread-work",
          kind: "startup-resume",
          state: "cancelled",
        },
        {
          sourceTurnId: "turn-start:vm-task:run-thread-work",
          kind: "active-turn-recovery",
          state: "pending",
        },
      ]);

      // A scheduler retry must be able to resurrect a cancelled obligation.
      // The task scheduler re-dispatches under a fresh command id but reuses
      // the message id, so the retry maps to the same deterministic row —
      // treating that row purely as a replay receipt meant one transient
      // cancellation killed the run for good (observed live: "Queued for
      // Codex" forever, run failed after its retries all no-opped).
      yield* sql`
        UPDATE thread_work_obligations
        SET state = 'cancelled',
            blocked_reason = 'turn-start was superseded',
            updated_at = '2026-01-01T00:00:06.500Z'
        WHERE thread_id = ${threadId}
          AND source_turn_id = ${"turn-start:vm-task:run-thread-work"}
      `;
      yield* dispatchTurn({
        commandId: "vm-task:run-thread-work:retry:1",
        messageId: "vm-task:run-thread-work",
        text: "Scheduled task prompt",
        inputOrigin: "agent-loop",
        createdAt: "2026-01-01T00:00:07.000Z",
      });

      const afterRetry = yield* sql<{
        readonly state: string;
        readonly blockedReason: string | null;
      }>`
        SELECT state, blocked_reason AS "blockedReason"
        FROM thread_work_obligations
        WHERE thread_id = ${threadId}
          AND source_turn_id = ${"turn-start:vm-task:run-thread-work"}
      `;
      assert.deepEqual(afterRetry, [{ state: "pending", blockedReason: null }]);
    }),
  );

  it.effect("retires the exact startup-resume owner when its resumed turn completes", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-completed-startup-resume");
      const threadId = ThreadId.make("thread-completed-startup-resume");
      const sourceTurnId = TurnId.make("turn-interrupted-before-startup-resume");
      const resumedTurnId = TurnId.make("turn-completed-startup-resume");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const resumeMessageId = MessageId.make(
        `startup-auto-resume-message:${threadId}:${sourceTurnId}`,
      );

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-completed-startup-resume-project"),
        projectId,
        title: "Completed startup resume",
        workspaceRoot: "/tmp/project-completed-startup-resume",
        defaultModelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5.6-sol",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-completed-startup-resume-thread"),
        threadId,
        projectId,
        title: "Completed startup resume thread",
        modelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5.6-sol",
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`startup-auto-resume-command:${threadId}:${sourceTurnId}`),
        threadId,
        message: {
          messageId: resumeMessageId,
          role: "user",
          text: "Please resume your current task.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      // Match the production failure: the supervisor owns the resume and its
      // lease is live when the provider turn reaches its terminal reply.
      yield* sql`
        UPDATE thread_work_obligations
        SET state = 'executing',
            attempt = 1,
            claimed_at = '2026-01-01T00:00:01.500Z',
            lease_expires_at = '2026-01-01T00:01:01.500Z',
            updated_at = '2026-01-01T00:00:01.500Z'
        WHERE thread_id = ${threadId}
          AND source_turn_id = ${sourceTurnId}
          AND kind = 'startup-resume'
      `;
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-completed-startup-resume-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: resumedTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-completed-startup-resume-delta"),
        threadId,
        messageId: MessageId.make("assistant-completed-startup-resume"),
        delta: "Everything requested is complete.\n\nAGENT_STOP",
        turnId: resumedTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-completed-startup-resume-complete"),
        threadId,
        messageId: MessageId.make("assistant-completed-startup-resume"),
        turnId: resumedTurnId,
        createdAt: "2026-01-01T00:00:04.000Z",
      });

      const beforeTurnEnd = yield* sql<{ readonly state: string }>`
        SELECT state
        FROM thread_work_obligations
        WHERE thread_id = ${threadId} AND kind = 'startup-resume'
      `;
      assert.deepEqual(beforeTurnEnd, [{ state: "executing" }]);

      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-completed-startup-resume-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      const obligations = yield* sql<{
        readonly kind: string;
        readonly state: string;
        readonly claimedAt: string | null;
        readonly leaseExpiresAt: string | null;
      }>`
        SELECT
          kind,
          state,
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt"
        FROM thread_work_obligations
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC
      `;
      assert.deepEqual(obligations, [
        {
          kind: "startup-resume",
          state: "completed",
          claimedAt: null,
          leaseExpiresAt: null,
        },
      ]);

      const pendingWork = yield* sql<{
        readonly kind: string | null;
        readonly state: string | null;
        readonly since: string | null;
      }>`
        SELECT
          pending_work_kind AS "kind",
          pending_work_state AS "state",
          pending_work_since AS "since"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(pendingWork, [{ kind: null, state: null, since: null }]);
    }),
  );

  it.effect("does not enqueue Agent continuation for settings turns or a later real user", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-agent-continuation-guards");
      const providerInstanceId = ProviderInstanceId.make("codex");

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-agent-guards-project"),
        projectId,
        title: "Agent continuation guards",
        workspaceRoot: "/tmp/project-agent-continuation-guards",
        defaultModelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5.6-sol",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const createThread = (threadId: ThreadId, suffix: string) =>
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-agent-guards-thread-${suffix}`),
          threadId,
          projectId,
          title: `Agent guard ${suffix}`,
          modelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5.6-sol",
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        });

      const finishTurn = (input: {
        readonly threadId: ThreadId;
        readonly suffix: string;
        readonly turnId: TurnId;
        readonly sourceText: string;
        readonly laterUserText?: string;
        readonly laterUserBeforeAssistant?: boolean;
      }) =>
        Effect.gen(function* () {
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`cmd-agent-guards-start-${input.suffix}`),
            threadId: input.threadId,
            message: {
              messageId: MessageId.make(`message-agent-guards-${input.suffix}`),
              role: "user",
              text: input.sourceText,
              attachments: [],
            },
            interactionMode: "agent",
            runtimeMode: "full-access",
            createdAt: "2026-01-01T00:00:01.000Z",
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-agent-guards-running-${input.suffix}`),
            threadId: input.threadId,
            session: {
              threadId: input.threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId,
              runtimeMode: "full-access",
              activeTurnId: input.turnId,
              lastError: null,
              updatedAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          const enqueueLaterUser = (text: string) =>
            engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`cmd-agent-guards-later-user-${input.suffix}`),
              threadId: input.threadId,
              message: {
                messageId: MessageId.make(`message-agent-guards-later-user-${input.suffix}`),
                role: "user",
                text,
                attachments: [],
              },
              interactionMode: "agent",
              runtimeMode: "full-access",
              // Deliberately skew the later user's wall clock behind the
              // source. Event sequence, not timestamp or message sort order,
              // must still give this newer intent priority.
              createdAt: input.laterUserBeforeAssistant
                ? "2025-12-31T23:59:59.000Z"
                : "2026-01-01T00:00:04.000Z",
            });
          if (input.laterUserText !== undefined && input.laterUserBeforeAssistant === true) {
            yield* enqueueLaterUser(input.laterUserText);
          }
          yield* engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make(`cmd-agent-guards-delta-${input.suffix}`),
            threadId: input.threadId,
            messageId: MessageId.make(`assistant-agent-guards-${input.suffix}`),
            delta: "This phase is complete and more work remains.",
            turnId: input.turnId,
            createdAt: "2026-01-01T00:00:03.000Z",
          });
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`cmd-agent-guards-complete-${input.suffix}`),
            threadId: input.threadId,
            messageId: MessageId.make(`assistant-agent-guards-${input.suffix}`),
            turnId: input.turnId,
            createdAt: "2026-01-01T00:00:03.000Z",
          });
          if (input.laterUserText !== undefined && input.laterUserBeforeAssistant !== true) {
            yield* enqueueLaterUser(input.laterUserText);
          }
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-agent-guards-ready-${input.suffix}`),
            threadId: input.threadId,
            session: {
              threadId: input.threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId,
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-01-01T00:00:05.000Z",
            },
            createdAt: "2026-01-01T00:00:05.000Z",
          });
        });

      const settingsThreadId = ThreadId.make("thread-agent-settings-guard");
      const userRaceThreadId = ThreadId.make("thread-agent-user-race-guard");
      yield* createThread(settingsThreadId, "settings");
      yield* createThread(userRaceThreadId, "user-race");
      yield* finishTurn({
        threadId: settingsThreadId,
        suffix: "settings",
        turnId: TurnId.make("turn-agent-settings-guard"),
        sourceText: "Settings updated: use max effort. Apply immediately.",
      });
      yield* finishTurn({
        threadId: userRaceThreadId,
        suffix: "user-race",
        turnId: TurnId.make("turn-agent-user-race-guard"),
        sourceText: "Continue autonomously.",
        laterUserText: "Use this newer direction instead.",
        laterUserBeforeAssistant: true,
      });

      const continuationRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM thread_work_obligations
        WHERE kind = 'agent-continuation'
          AND thread_id IN (${settingsThreadId}, ${userRaceThreadId})
      `;
      assert.deepEqual(continuationRows, []);
    }),
  );

  it.effect(
    "atomically replaces the completed turn continuation with a housekeeping follow-up",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-agent-atomic-followup");
        const threadId = ThreadId.make("thread-agent-atomic-followup");
        const turnId = TurnId.make("turn-agent-atomic-followup");
        const providerInstanceId = ProviderInstanceId.make("codex");
        const cleanupMessageId = MessageId.make(
          `browser-tab-cleanup-message:${threadId}:${turnId}`,
        );

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-agent-atomic-followup-project"),
          projectId,
          title: "Atomic Agent follow-up",
          workspaceRoot: "/tmp/project-agent-atomic-followup",
          defaultModelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5.6-sol",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-agent-atomic-followup-thread"),
          threadId,
          projectId,
          title: "Atomic Agent follow-up",
          modelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5.6-sol",
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-agent-atomic-followup-start"),
          threadId,
          message: {
            messageId: MessageId.make("message-agent-atomic-followup"),
            role: "user",
            text: "Continue autonomously.",
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-agent-atomic-followup-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-agent-atomic-followup-delta"),
          threadId,
          messageId: MessageId.make("assistant-agent-atomic-followup"),
          delta: "The work continues after this phase.",
          turnId,
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-agent-atomic-followup-complete"),
          threadId,
          messageId: MessageId.make("assistant-agent-atomic-followup"),
          turnId,
          createdAt: "2026-01-01T00:00:03.500Z",
        });

        // Settlement and the cleanup turn are one command/transaction. The
        // projector may briefly insert the ordinary Agent continuation while
        // applying session-set, but the following turn-start cancels it before
        // any committed state can be claimed by the scheduler.
        const cleanupCommand = {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-agent-atomic-followup-ready"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
          atomicFollowupTurn: {
            sourceTurnId: turnId,
            message: {
              messageId: cleanupMessageId,
              role: "user",
              text: "Browser tab check: 2 tabs are open.",
              inputOrigin: "agent-loop",
              attachments: [],
            },
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        } as const;
        yield* engine.dispatch(cleanupCommand);

        const rows = yield* sql<{
          readonly kind: string;
          readonly sourceTurnId: string;
          readonly state: string;
        }>`
          SELECT
            kind,
            source_turn_id AS "sourceTurnId",
            state
          FROM thread_work_obligations
          WHERE thread_id = ${threadId}
            AND kind IN ('agent-continuation', 'active-turn-recovery')
          ORDER BY kind ASC, source_turn_id ASC
        `;
        assert.deepEqual(rows, [
          {
            kind: "active-turn-recovery",
            sourceTurnId: `turn-start:${cleanupMessageId}`,
            state: "pending",
          },
          {
            kind: "active-turn-recovery",
            sourceTurnId: "turn-start:message-agent-atomic-followup",
            state: "pending",
          },
          {
            kind: "agent-continuation",
            sourceTurnId: String(turnId),
            state: "cancelled",
          },
        ]);

        // A crash after the atomic command but before its cleanup receipt is
        // committed can replay the same provider completion. The deterministic
        // parent command id must make that replay a no-op, even after the
        // cleanup turn itself has started.
        const cleanupTurnId = TurnId.make("turn-agent-atomic-followup-cleanup");
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-agent-atomic-followup-cleanup-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: cleanupTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:05.000Z",
          },
          createdAt: "2026-01-01T00:00:05.000Z",
        });
        yield* engine.dispatch(cleanupCommand);

        const [replayedSession] = yield* sql<{
          readonly status: string;
          readonly activeTurnId: string | null;
        }>`
          SELECT status, active_turn_id AS "activeTurnId"
          FROM projection_thread_sessions
          WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(replayedSession, {
          status: "running",
          activeTurnId: cleanupTurnId,
        });
        const cleanupMessages = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_thread_messages
          WHERE message_id = ${cleanupMessageId}
        `;
        assert.deepEqual(cleanupMessages, [{ count: 1 }]);

        // Stop can land after ingestion planned cleanup but before this atomic
        // command reaches the decider. The source-turn guard lets lifecycle
        // settlement through while suppressing the now-stale reminder.
        const stoppedThreadId = ThreadId.make("thread-agent-atomic-followup-stopped");
        const stoppedTurnId = TurnId.make("turn-agent-atomic-followup-stopped");
        const stoppedCleanupMessageId = MessageId.make(
          `browser-tab-cleanup-message:${stoppedThreadId}:${stoppedTurnId}`,
        );
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-agent-atomic-followup-stopped-thread"),
          threadId: stoppedThreadId,
          projectId,
          title: "Stopped atomic Agent follow-up",
          modelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5.6-sol",
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:06.000Z",
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-agent-atomic-followup-stopped-start"),
          threadId: stoppedThreadId,
          message: {
            messageId: MessageId.make("message-agent-atomic-followup-stopped"),
            role: "user",
            text: "Continue autonomously.",
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          createdAt: "2026-01-01T00:00:07.000Z",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-agent-atomic-followup-stopped-running"),
          threadId: stoppedThreadId,
          session: {
            threadId: stoppedThreadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: stoppedTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:08.000Z",
          },
          createdAt: "2026-01-01T00:00:08.000Z",
        });
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-agent-atomic-followup-stopped-interrupt"),
          threadId: stoppedThreadId,
          turnId: stoppedTurnId,
          createdAt: "2026-01-01T00:00:09.000Z",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("browser-tab-cleanup-command:stopped-race"),
          threadId: stoppedThreadId,
          session: {
            threadId: stoppedThreadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:10.000Z",
          },
          atomicFollowupTurn: {
            sourceTurnId: stoppedTurnId,
            message: {
              messageId: stoppedCleanupMessageId,
              role: "user",
              text: "Browser tab check: 2 tabs are open.",
              inputOrigin: "agent-loop",
              attachments: [],
            },
          },
          createdAt: "2026-01-01T00:00:10.000Z",
        });

        const stoppedCleanupMessages = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_thread_messages
          WHERE message_id = ${stoppedCleanupMessageId}
        `;
        assert.deepEqual(stoppedCleanupMessages, [{ count: 0 }]);
        const [stoppedSession] = yield* sql<{ readonly status: string }>`
          SELECT status
          FROM projection_thread_sessions
          WHERE thread_id = ${stoppedThreadId}
        `;
        assert.deepEqual(stoppedSession, { status: "ready" });
      }),
  );

  it.effect("continues exactly once after a successful cleanup turn", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const suffix = "agent-cleanup-positive";
      const projectId = ProjectId.make(`project-${suffix}`);
      const threadId = ThreadId.make(`thread-${suffix}`);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const sourceTurnId = TurnId.make(`turn-${suffix}-source`);
      const cleanupTurnId = TurnId.make(`turn-${suffix}-cleanup`);
      const cleanupMessageId = MessageId.make(
        `browser-tab-cleanup-message:${threadId}:${sourceTurnId}`,
      );
      const cleanupAssistantMessageId = MessageId.make(`assistant-${suffix}-cleanup`);

      yield* createAgentThread({
        projectId,
        threadId,
        providerInstanceId,
        suffix,
      });
      yield* queueCleanupAfterContinuableTurn({
        threadId,
        providerInstanceId,
        sourceTurnId,
        cleanupMessageId,
        suffix,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-${suffix}-cleanup-running`),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: cleanupTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
        createdAt: "2026-01-01T00:00:05.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`cmd-${suffix}-cleanup-delta`),
        threadId,
        messageId: cleanupAssistantMessageId,
        delta: "Closed the unused browser tabs.",
        turnId: cleanupTurnId,
        createdAt: "2026-01-01T00:00:06.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`cmd-${suffix}-cleanup-complete`),
        threadId,
        messageId: cleanupAssistantMessageId,
        turnId: cleanupTurnId,
        createdAt: "2026-01-01T00:00:06.500Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-${suffix}-cleanup-ready`),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:07.000Z",
        },
        createdAt: "2026-01-01T00:00:07.000Z",
      });

      const pendingContinuations = yield* sql<{ readonly sourceTurnId: string }>`
        SELECT source_turn_id AS "sourceTurnId"
        FROM thread_work_obligations
        WHERE thread_id = ${threadId}
          AND kind = 'agent-continuation'
          AND state = 'pending'
      `;
      assert.deepEqual(pendingContinuations, [{ sourceTurnId: cleanupTurnId }]);
    }),
  );

  it.effect("does not continue cleanup behind a real user turn queued before its reply", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const suffix = "agent-cleanup-user-race";
      const projectId = ProjectId.make(`project-${suffix}`);
      const threadId = ThreadId.make(`thread-${suffix}`);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const sourceTurnId = TurnId.make(`turn-${suffix}-source`);
      const cleanupTurnId = TurnId.make(`turn-${suffix}-cleanup`);
      const cleanupMessageId = MessageId.make(
        `browser-tab-cleanup-message:${threadId}:${sourceTurnId}`,
      );
      const queuedUserMessageId = MessageId.make(`message-${suffix}-queued-user`);
      const cleanupAssistantMessageId = MessageId.make(`assistant-${suffix}-cleanup`);

      yield* createAgentThread({
        projectId,
        threadId,
        providerInstanceId,
        suffix,
      });
      yield* queueCleanupAfterContinuableTurn({
        threadId,
        providerInstanceId,
        sourceTurnId,
        cleanupMessageId,
        suffix,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-${suffix}-cleanup-running`),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: cleanupTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      // B is persisted after cleanup C's source, but before C's assistant.
      // The source-order guard, not the later-than-assistant guard, must win.
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-${suffix}-queued-user-start`),
        threadId,
        message: {
          messageId: queuedUserMessageId,
          role: "user",
          text: "Use this newer direction next.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:05.500Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`cmd-${suffix}-cleanup-delta`),
        threadId,
        messageId: cleanupAssistantMessageId,
        delta: "Closed the unused browser tabs.",
        turnId: cleanupTurnId,
        createdAt: "2026-01-01T00:00:06.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`cmd-${suffix}-cleanup-complete`),
        threadId,
        messageId: cleanupAssistantMessageId,
        turnId: cleanupTurnId,
        createdAt: "2026-01-01T00:00:06.500Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-${suffix}-cleanup-ready`),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:07.000Z",
        },
        createdAt: "2026-01-01T00:00:07.000Z",
      });

      const staleCleanupContinuations = yield* sql<{ readonly state: string }>`
        SELECT state
        FROM thread_work_obligations
        WHERE thread_id = ${threadId}
          AND source_turn_id = ${cleanupTurnId}
          AND kind = 'agent-continuation'
      `;
      assert.deepEqual(staleCleanupContinuations, []);
      const queuedUserDelivery = yield* sql<{ readonly state: string }>`
        SELECT state
        FROM thread_work_obligations
        WHERE thread_id = ${threadId}
          AND source_turn_id = ${`turn-start:${queuedUserMessageId}`}
          AND kind = 'active-turn-recovery'
      `;
      assert.deepEqual(queuedUserDelivery, [{ state: "pending" }]);
    }),
  );

  it.effect("settles without cleanup when a newer turn becomes active after planning", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const suffix = "agent-cleanup-newer-active";
      const projectId = ProjectId.make(`project-${suffix}`);
      const threadId = ThreadId.make(`thread-${suffix}`);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const sourceTurnId = TurnId.make(`turn-${suffix}-source`);
      const newerTurnId = TurnId.make(`turn-${suffix}-newer`);
      const cleanupMessageId = MessageId.make(
        `browser-tab-cleanup-message:${threadId}:${sourceTurnId}`,
      );

      yield* createAgentThread({
        projectId,
        threadId,
        providerInstanceId,
        suffix,
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-${suffix}-source-start`),
        threadId,
        message: {
          messageId: MessageId.make(`message-${suffix}-source`),
          role: "user",
          text: "Begin the source turn.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-${suffix}-source-running`),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      });

      const plannedCleanup = {
        type: "thread.session.set",
        commandId: CommandId.make(`browser-tab-cleanup-command:${suffix}`),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
        atomicFollowupTurn: {
          sourceTurnId,
          message: {
            messageId: cleanupMessageId,
            role: "user",
            text: "Browser tab check: 2 tabs are open.",
            inputOrigin: "agent-loop",
            attachments: [],
          },
        },
        createdAt: "2026-01-01T00:00:05.000Z",
      } as const;

      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-${suffix}-newer-start`),
        threadId,
        message: {
          messageId: MessageId.make(`message-${suffix}-newer`),
          role: "user",
          text: "A newer turn is now active.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-${suffix}-newer-running`),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: newerTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      });
      yield* engine.dispatch(plannedCleanup);

      const sessions = yield* sql<{
        readonly status: string;
        readonly activeTurnId: string | null;
      }>`
        SELECT status, active_turn_id AS "activeTurnId"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(sessions, [{ status: "ready", activeTurnId: null }]);
      const cleanupMessages = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_thread_messages
        WHERE message_id = ${cleanupMessageId}
      `;
      assert.deepEqual(cleanupMessages, [{ count: 0 }]);
    }),
  );

  it.effect("rejects an atomic follow-up on a non-ready active session", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const suffix = "agent-cleanup-invalid-session";
      const projectId = ProjectId.make(`project-${suffix}`);
      const threadId = ThreadId.make(`thread-${suffix}`);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const turnId = TurnId.make(`turn-${suffix}`);
      const cleanupMessageId = MessageId.make(`browser-tab-cleanup-message:${threadId}:${turnId}`);

      yield* createAgentThread({
        projectId,
        threadId,
        providerInstanceId,
        suffix,
      });
      const error = yield* Effect.flip(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`browser-tab-cleanup-command:${suffix}`),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          atomicFollowupTurn: {
            sourceTurnId: turnId,
            message: {
              messageId: cleanupMessageId,
              role: "user",
              text: "Browser tab check: 2 tabs are open.",
              inputOrigin: "agent-loop",
              attachments: [],
            },
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
      assert.strictEqual(error._tag, "OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        assert.include(error.detail, "requires a ready session with no active turn");
      }

      const projectionRows = yield* sql<{
        readonly sessionCount: number;
        readonly messageCount: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM projection_thread_sessions WHERE thread_id = ${threadId})
            AS "sessionCount",
          (SELECT COUNT(*) FROM projection_thread_messages WHERE message_id = ${cleanupMessageId})
            AS "messageCount"
      `;
      assert.deepEqual(projectionRows, [{ sessionCount: 0, messageCount: 0 }]);
    }),
  );

  it.effect("does not queue a continuation behind cleanup when an older user turn runs first", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-agent-cleanup-fifo");
      const threadId = ThreadId.make("thread-agent-cleanup-fifo");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const turnA = TurnId.make("turn-agent-cleanup-fifo-a");
      const turnB = TurnId.make("turn-agent-cleanup-fifo-b");
      const messageB = MessageId.make("message-agent-cleanup-fifo-b");
      const cleanupMessage = MessageId.make(`browser-tab-cleanup-message:${threadId}:${turnA}`);

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-project"),
        projectId,
        title: "Agent cleanup FIFO",
        workspaceRoot: "/tmp/project-agent-cleanup-fifo",
        defaultModelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5.6-sol",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-thread"),
        threadId,
        projectId,
        title: "Agent cleanup FIFO",
        modelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5.6-sol",
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-a-start"),
        threadId,
        message: {
          messageId: MessageId.make("message-agent-cleanup-fifo-a"),
          role: "user",
          text: "Begin A and continue autonomously.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-a-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: turnA,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      });

      // B is a real user turn already waiting while A is still running.
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-b-start"),
        threadId,
        message: {
          messageId: messageB,
          role: "user",
          text: "Do B next.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-a-delta"),
        threadId,
        messageId: MessageId.make("assistant-agent-cleanup-fifo-a"),
        delta: "A is complete and autonomous work remains.",
        turnId: turnA,
        createdAt: "2026-01-01T00:00:04.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-a-complete"),
        threadId,
        messageId: MessageId.make("assistant-agent-cleanup-fifo-a"),
        turnId: turnA,
        createdAt: "2026-01-01T00:00:04.500Z",
      });

      // A's successful settle queues cleanup C atomically. B remains ahead
      // of C because both are durable real/synthetic turn deliveries.
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("browser-tab-cleanup-command:agent-cleanup-fifo-a"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
        atomicFollowupTurn: {
          sourceTurnId: turnA,
          message: {
            messageId: cleanupMessage,
            role: "user",
            text: "Browser tab check: 2 tabs are open.",
            inputOrigin: "agent-loop",
            attachments: [],
          },
        },
        createdAt: "2026-01-01T00:00:05.000Z",
      });

      const queuedDeliveries = yield* sql<{
        readonly sourceTurnId: string;
        readonly state: string;
      }>`
          SELECT source_turn_id AS "sourceTurnId", state
          FROM thread_work_obligations
          WHERE thread_id = ${threadId}
            AND kind = 'active-turn-recovery'
            AND source_turn_id IN (
              ${`turn-start:${messageB}`},
              ${`turn-start:${cleanupMessage}`}
            )
          ORDER BY created_at ASC
        `;
      assert.deepEqual(queuedDeliveries, [
        { sourceTurnId: `turn-start:${messageB}`, state: "pending" },
        { sourceTurnId: `turn-start:${cleanupMessage}`, state: "pending" },
      ]);

      // B runs first and finishes successfully. C's prompt is older than B's
      // assistant message, so only the durable-work guard can keep a stale B
      // continuation from being appended behind C.
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-b-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: turnB,
          lastError: null,
          updatedAt: "2026-01-01T00:00:06.000Z",
        },
        createdAt: "2026-01-01T00:00:06.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-b-delta"),
        threadId,
        messageId: MessageId.make("assistant-agent-cleanup-fifo-b"),
        delta: "B is complete and autonomous work remains.",
        turnId: turnB,
        createdAt: "2026-01-01T00:00:07.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-b-complete"),
        threadId,
        messageId: MessageId.make("assistant-agent-cleanup-fifo-b"),
        turnId: turnB,
        createdAt: "2026-01-01T00:00:07.500Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-agent-cleanup-fifo-b-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:08.000Z",
        },
        createdAt: "2026-01-01T00:00:08.000Z",
      });

      const staleContinuation = yield* sql<{ readonly state: string }>`
          SELECT state
          FROM thread_work_obligations
          WHERE thread_id = ${threadId}
            AND kind = 'agent-continuation'
            AND source_turn_id = ${turnB}
        `;
      assert.deepEqual(staleContinuation, []);
    }),
  );

  it.effect(
    "does not let interleaved cleanup replies restart an Agent after the latest real turn stops",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-agent-cleanup-stop-chain");
        const threadId = ThreadId.make("thread-agent-cleanup-stop-chain");
        const providerInstanceId = ProviderInstanceId.make("codex");
        const turnA = TurnId.make("turn-agent-cleanup-stop-chain-a");
        const turnB = TurnId.make("turn-agent-cleanup-stop-chain-b");
        const cleanupTurnC = TurnId.make("turn-agent-cleanup-stop-chain-c");
        const cleanupTurnD = TurnId.make("turn-agent-cleanup-stop-chain-d");
        const messageA = MessageId.make("message-agent-cleanup-stop-chain-a");
        const messageB = MessageId.make("message-agent-cleanup-stop-chain-b");
        const assistantMessageB = MessageId.make("assistant-agent-cleanup-stop-chain-b");
        const cleanupMessageC = MessageId.make(`browser-tab-cleanup-message:${threadId}:${turnA}`);
        const cleanupMessageD = MessageId.make(`browser-tab-cleanup-message:${threadId}:${turnB}`);

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-agent-cleanup-stop-chain-project"),
          projectId,
          title: "Agent cleanup stop chain",
          workspaceRoot: "/tmp/project-agent-cleanup-stop-chain",
          defaultModelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5.6-sol",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-agent-cleanup-stop-chain-thread"),
          threadId,
          projectId,
          title: "Agent cleanup stop chain",
          modelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5.6-sol",
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-agent-cleanup-stop-chain-a-start"),
          threadId,
          message: {
            messageId: messageA,
            role: "user",
            text: "Start A and continue autonomously.",
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-agent-cleanup-stop-chain-a-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: turnA,
            lastError: null,
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-agent-cleanup-stop-chain-b-start"),
          threadId,
          message: {
            messageId: messageB,
            role: "user",
            text: "Do B next.",
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-agent-cleanup-stop-chain-a-delta"),
          threadId,
          messageId: MessageId.make("assistant-agent-cleanup-stop-chain-a"),
          delta: "A is done and the loop should continue.",
          turnId: turnA,
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-agent-cleanup-stop-chain-a-complete"),
          threadId,
          messageId: MessageId.make("assistant-agent-cleanup-stop-chain-a"),
          turnId: turnA,
          createdAt: "2026-01-01T00:00:04.500Z",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("browser-tab-cleanup-command:agent-cleanup-stop-chain-a"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:05.000Z",
          },
          atomicFollowupTurn: {
            sourceTurnId: turnA,
            message: {
              messageId: cleanupMessageC,
              role: "user",
              text: "Browser tab check: 3 tabs are open.",
              inputOrigin: "agent-loop",
              attachments: [],
            },
          },
          createdAt: "2026-01-01T00:00:05.000Z",
        });

        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-agent-cleanup-stop-chain-b-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: turnB,
            lastError: null,
            updatedAt: "2026-01-01T00:00:06.000Z",
          },
          createdAt: "2026-01-01T00:00:06.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-agent-cleanup-stop-chain-b-delta"),
          threadId,
          messageId: assistantMessageB,
          delta: "B is complete.\n\nAGENT_STOP",
          turnId: turnB,
          createdAt: "2026-01-01T00:00:07.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-agent-cleanup-stop-chain-b-complete"),
          threadId,
          messageId: assistantMessageB,
          turnId: turnB,
          createdAt: "2026-01-01T00:00:07.500Z",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("browser-tab-cleanup-command:agent-cleanup-stop-chain-b"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:08.000Z",
          },
          atomicFollowupTurn: {
            sourceTurnId: turnB,
            message: {
              messageId: cleanupMessageD,
              role: "user",
              text: "Browser tab check: 2 tabs are open.",
              inputOrigin: "agent-loop",
              attachments: [],
            },
          },
          createdAt: "2026-01-01T00:00:08.000Z",
        });

        // Grok can finish the substantive reply immediately before its queued
        // cleanup begins. The live projection then associates that reply row
        // with the cleanup turn even though the substantive turn still points
        // at the same assistant message. The cleanup verdict must follow that
        // immutable source-turn pointer, not infer ancestry from message rows.
        yield* sql`
          UPDATE projection_thread_messages
          SET turn_id = ${cleanupTurnD}
          WHERE message_id = ${assistantMessageB}
        `;

        for (const cleanup of [
          {
            suffix: "c",
            turnId: cleanupTurnC,
            assistantMessageId: MessageId.make("assistant-agent-cleanup-stop-chain-c"),
            runningAt: "2026-01-01T00:00:09.000Z",
            replyAt: "2026-01-01T00:00:10.000Z",
            completeAt: "2026-01-01T00:00:10.500Z",
            readyAt: "2026-01-01T00:00:11.000Z",
          },
          {
            suffix: "d",
            turnId: cleanupTurnD,
            assistantMessageId: MessageId.make("assistant-agent-cleanup-stop-chain-d"),
            runningAt: "2026-01-01T00:00:12.000Z",
            replyAt: "2026-01-01T00:00:13.000Z",
            completeAt: "2026-01-01T00:00:13.500Z",
            readyAt: "2026-01-01T00:00:14.000Z",
          },
        ] as const) {
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-agent-cleanup-stop-chain-${cleanup.suffix}-running`),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId,
              runtimeMode: "full-access",
              activeTurnId: cleanup.turnId,
              lastError: null,
              updatedAt: cleanup.runningAt,
            },
            createdAt: cleanup.runningAt,
          });
          yield* engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make(`cmd-agent-cleanup-stop-chain-${cleanup.suffix}-delta`),
            threadId,
            messageId: cleanup.assistantMessageId,
            delta: "Closed the unused browser tabs.",
            turnId: cleanup.turnId,
            createdAt: cleanup.replyAt,
          });
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`cmd-agent-cleanup-stop-chain-${cleanup.suffix}-complete`),
            threadId,
            messageId: cleanup.assistantMessageId,
            turnId: cleanup.turnId,
            createdAt: cleanup.completeAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-agent-cleanup-stop-chain-${cleanup.suffix}-ready`),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId,
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: cleanup.readyAt,
            },
            createdAt: cleanup.readyAt,
          });
        }

        const pendingContinuations = yield* sql<{ readonly sourceTurnId: string }>`
          SELECT source_turn_id AS "sourceTurnId"
          FROM thread_work_obligations
          WHERE thread_id = ${threadId}
            AND kind = 'agent-continuation'
            AND state = 'pending'
        `;
        assert.deepEqual(pendingContinuations, []);
      }),
  );

  it.effect(
    "still enqueues Agent continuation when a checkpoint lands after the turn settles",
    () =>
      Effect.gen(function* () {
        // The production race this pins down: codex emits `turn.diff.updated`
        // mid-turn, which creates a placeholder checkpoint; the CheckpointReactor
        // then captures the real git state asynchronously and its
        // `thread.turn.diff.complete` — stamped with the *placeholder's* mid-turn
        // timestamp — can land between the session-set that settled the turn and
        // the assistant message finalize. That rewrite used to break the gate's
        // freshness check permanently, so an agent thread just stopped at its
        // final output with no continuation and no error.
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-agent-checkpoint-race");
        const threadId = ThreadId.make("thread-agent-checkpoint-race");
        const turnId = TurnId.make("turn-agent-checkpoint-race");
        const providerInstanceId = ProviderInstanceId.make("codex");

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-checkpoint-race-project"),
          projectId,
          title: "Checkpoint race",
          workspaceRoot: "/tmp/project-agent-checkpoint-race",
          defaultModelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5.6-sol",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-checkpoint-race-thread"),
          threadId,
          projectId,
          title: "Checkpoint race thread",
          modelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5.6-sol",
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-checkpoint-race-start"),
          threadId,
          message: {
            messageId: MessageId.make("message-checkpoint-race"),
            role: "user",
            text: "Continue working autonomously.",
            attachments: [],
          },
          interactionMode: "agent",
          runtimeMode: "full-access",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-checkpoint-race-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-checkpoint-race-delta"),
          threadId,
          messageId: MessageId.make("assistant-checkpoint-race"),
          delta: "Phase one is done; starting phase two next.",
          turnId,
          createdAt: "2026-01-01T00:00:03.000Z",
        });

        // The turn settles while the final assistant segment is still streaming —
        // the gate defers to the finalize below, exactly like production.
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-checkpoint-race-ready"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:05.000Z",
          },
          createdAt: "2026-01-01T00:00:05.000Z",
        });

        // The async checkpoint capture lands in the settle→finalize window,
        // carrying the mid-turn placeholder timestamp it inherited.
        yield* engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-checkpoint-race-diff"),
          threadId,
          turnId,
          completedAt: "2026-01-01T00:00:04.000Z",
          checkpointRef: CheckpointRef.make("refs/t3/checkpoint-race"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-checkpoint-race"),
          checkpointTurnCount: 1,
          createdAt: "2026-01-01T00:00:05.500Z",
        });

        // The finalize is the gate's deciding run for this ordering.
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-checkpoint-race-complete"),
          threadId,
          messageId: MessageId.make("assistant-checkpoint-race"),
          turnId,
          createdAt: "2026-01-01T00:00:06.000Z",
        });

        // The checkpoint must not rewind the settled turn's completion time…
        const turnRows = yield* sql<{ readonly completedAt: string | null }>`
        SELECT completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
        assert.deepEqual(turnRows, [{ completedAt: "2026-01-01T00:00:05.000Z" }]);

        // …and the continuation must exist despite the interleaved checkpoint.
        const continuationRows = yield* sql<{ readonly state: string }>`
        SELECT state
        FROM thread_work_obligations
        WHERE kind = 'agent-continuation' AND thread_id = ${threadId}
      `;
        assert.deepEqual(continuationRows, [{ state: "pending" }]);
      }),
  );

  it.effect("enqueues Agent continuation when a post-settle session refresh lands first", () =>
    Effect.gen(function* () {
      // Variant of the same stall: a session-set that merely refreshes an
      // already-ready session (codex `session/ready` notifications, reconnects)
      // used to advance the session row past the turn's completion time and
      // fail the gate's strict equality forever.
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-agent-session-refresh");
      const threadId = ThreadId.make("thread-agent-session-refresh");
      const turnId = TurnId.make("turn-agent-session-refresh");
      const providerInstanceId = ProviderInstanceId.make("codex");

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-session-refresh-project"),
        projectId,
        title: "Session refresh race",
        workspaceRoot: "/tmp/project-agent-session-refresh",
        defaultModelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5.6-sol",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-session-refresh-thread"),
        threadId,
        projectId,
        title: "Session refresh thread",
        modelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5.6-sol",
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-session-refresh-start"),
        threadId,
        message: {
          messageId: MessageId.make("message-session-refresh"),
          role: "user",
          text: "Continue working autonomously.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-refresh-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-session-refresh-delta"),
        threadId,
        messageId: MessageId.make("assistant-session-refresh"),
        delta: "Phase one is done; starting phase two next.",
        turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-refresh-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
        createdAt: "2026-01-01T00:00:05.000Z",
      });
      // A status refresh with nothing new in it, stamped a moment later.
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-refresh-refresh"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:05.700Z",
        },
        createdAt: "2026-01-01T00:00:05.700Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-session-refresh-complete"),
        threadId,
        messageId: MessageId.make("assistant-session-refresh"),
        turnId,
        createdAt: "2026-01-01T00:00:06.000Z",
      });

      const continuationRows = yield* sql<{ readonly state: string }>`
        SELECT state
        FROM thread_work_obligations
        WHERE kind = 'agent-continuation' AND thread_id = ${threadId}
      `;
      assert.deepEqual(continuationRows, [{ state: "pending" }]);
    }),
  );

  it.effect("atomically replaces active turn work with an authentication pause", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-auth-work-handoff");
      const threadId = ThreadId.make("thread-auth-work-handoff");
      const turnId = TurnId.make("turn-auth-work-handoff");
      const messageId = MessageId.make("message-auth-work-handoff");
      const assistantMessageId = MessageId.make("assistant-auth-work-handoff");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const authFailure =
        "Failed to authenticate: OAuth session expired and could not be refreshed";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-auth-work-project"),
        projectId,
        title: "Authentication Work Project",
        workspaceRoot: "/tmp/project-auth-work-handoff",
        defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-auth-work-thread"),
        threadId,
        projectId,
        title: "Authentication Work Thread",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
        interactionMode: "agent",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-auth-work-turn"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "Continue after credentials recover.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-auth-work-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-auth-work-delta"),
        threadId,
        messageId: assistantMessageId,
        delta: authFailure,
        turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-auth-work-complete"),
        threadId,
        messageId: assistantMessageId,
        turnId,
        createdAt: "2026-01-01T00:00:04.000Z",
      });

      const obligations = yield* sql<{
        readonly sourceTurnId: string;
        readonly kind: string;
        readonly state: string;
        readonly blockedReason: string | null;
      }>`
        SELECT
          source_turn_id AS "sourceTurnId",
          kind,
          state,
          blocked_reason AS "blockedReason"
        FROM thread_work_obligations
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, obligation_id ASC
      `;
      assert.deepEqual(obligations, [
        {
          sourceTurnId: `turn-start:${messageId}`,
          kind: "active-turn-recovery",
          state: "cancelled",
          blockedReason: "replaced by authentication-resume",
        },
        {
          sourceTurnId: turnId,
          kind: "authentication-resume",
          state: "blocked-authentication",
          blockedReason: "provider authentication required",
        },
      ]);

      const supersededThreadId = ThreadId.make("thread-auth-work-superseded");
      const supersededTurnId = TurnId.make("turn-auth-work-superseded");
      const supersededMessageId = MessageId.make("message-auth-work-superseded");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-auth-work-superseded-thread"),
        threadId: supersededThreadId,
        projectId,
        title: "Superseded Authentication Work Thread",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
        interactionMode: "agent",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-auth-work-superseded-turn"),
        threadId: supersededThreadId,
        message: {
          messageId: supersededMessageId,
          role: "user",
          text: "Continue after credentials recover.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-auth-work-superseded-running"),
        threadId: supersededThreadId,
        session: {
          threadId: supersededThreadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: supersededTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      // This command is appended later but carries a clock-skewed earlier
      // timestamp. It still supersedes replaying the failed source turn.
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-auth-work-superseding-user"),
        threadId: supersededThreadId,
        message: {
          messageId: MessageId.make("message-auth-work-superseding-user"),
          role: "user",
          text: "Use this newer direction after login.",
          attachments: [],
        },
        interactionMode: "agent",
        runtimeMode: "full-access",
        createdAt: "2025-12-31T23:59:59.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-auth-work-superseded-delta"),
        threadId: supersededThreadId,
        messageId: MessageId.make("assistant-auth-work-superseded"),
        delta: authFailure,
        turnId: supersededTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-auth-work-superseded-complete"),
        threadId: supersededThreadId,
        messageId: MessageId.make("assistant-auth-work-superseded"),
        turnId: supersededTurnId,
        createdAt: "2026-01-01T00:00:04.000Z",
      });

      const supersededAuthenticationRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_work_obligations
        WHERE thread_id = ${supersededThreadId}
          AND kind = 'authentication-resume'
      `;
      assert.deepEqual(supersededAuthenticationRows, [{ count: 0 }]);

      for (const interactionMode of ["default", "plan"] as const) {
        const modeThreadId = ThreadId.make(`thread-auth-work-${interactionMode}`);
        const modeTurnId = TurnId.make(`turn-auth-work-${interactionMode}`);
        const modeMessageId = MessageId.make(`message-auth-work-${interactionMode}`);
        const modeAssistantMessageId = MessageId.make(`assistant-auth-work-${interactionMode}`);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-auth-work-${interactionMode}-thread`),
          threadId: modeThreadId,
          projectId,
          title: `${interactionMode} Authentication Work Thread`,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
          interactionMode,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-auth-work-${interactionMode}-turn`),
          threadId: modeThreadId,
          message: {
            messageId: modeMessageId,
            role: "user",
            text: "Wait for me after credentials recover.",
            attachments: [],
          },
          interactionMode,
          runtimeMode: "full-access",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-auth-work-${interactionMode}-running`),
          threadId: modeThreadId,
          session: {
            threadId: modeThreadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: modeTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`cmd-auth-work-${interactionMode}-delta`),
          threadId: modeThreadId,
          messageId: modeAssistantMessageId,
          delta: authFailure,
          turnId: modeTurnId,
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(`cmd-auth-work-${interactionMode}-complete`),
          threadId: modeThreadId,
          messageId: modeAssistantMessageId,
          turnId: modeTurnId,
          createdAt: "2026-01-01T00:00:04.000Z",
        });
      }

      const nonAgentAuthenticationRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_work_obligations
        WHERE thread_id IN ('thread-auth-work-default', 'thread-auth-work-plan')
          AND kind = 'authentication-resume'
      `;
      assert.deepEqual(nonAgentAuthenticationRows, [{ count: 0 }]);
    }),
  );

  it.effect("routes lifecycle events to thread-terminal and turn-interrupt cancellation", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-work-cancel-modes");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const seededAt = "2026-01-01T00:00:00.000Z";
      const scenarios = [
        { key: "deleted", deliverySurvives: false },
        { key: "settled", deliverySurvives: false },
        { key: "stopped", deliverySurvives: true },
        { key: "interrupted", deliverySurvives: true },
        { key: "pending-interrupted", deliverySurvives: false },
      ] as const;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-work-cancel-project"),
        projectId,
        title: "Cancellation Mode Project",
        workspaceRoot: "/tmp/project-work-cancel-modes",
        defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
        createdAt: seededAt,
      });
      for (const scenario of scenarios) {
        const threadId = ThreadId.make(`thread-work-cancel-${scenario.key}`);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-work-cancel-thread-${scenario.key}`),
          threadId,
          projectId,
          title: `Cancellation ${scenario.key} thread`,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
          interactionMode: "agent",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: seededAt,
        });
        // A parked user delivery and queued synthetic work, both awaiting the
        // scheduler — exactly the state a terminal command must clean up.
        yield* sql`
          INSERT INTO thread_work_obligations (
            obligation_id, thread_id, source_turn_id, kind, state,
            provider_instance_id, attempt, next_attempt_at, claimed_at,
            lease_expires_at, blocked_reason, created_at, updated_at
          ) VALUES
            (
              ${`work-cancel-${scenario.key}-delivery`}, ${threadId},
              ${`turn-start:user-message-${scenario.key}`}, 'active-turn-recovery', 'pending',
              ${providerInstanceId}, 0, NULL, NULL, NULL, NULL, ${seededAt}, ${seededAt}
            ),
            (
              ${`work-cancel-${scenario.key}-continuation`}, ${threadId},
              ${`turn-work-cancel-${scenario.key}`}, 'agent-continuation', 'pending',
              ${providerInstanceId}, 0, NULL, NULL, NULL, NULL, ${seededAt}, ${seededAt}
            )
        `;
      }

      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-work-cancel-delete"),
        threadId: ThreadId.make("thread-work-cancel-deleted"),
      });
      yield* engine.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("cmd-work-cancel-settle"),
        threadId: ThreadId.make("thread-work-cancel-settled"),
      });
      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-work-cancel-stop"),
        threadId: ThreadId.make("thread-work-cancel-stopped"),
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-work-cancel-interrupt"),
        threadId: ThreadId.make("thread-work-cancel-interrupted"),
        turnId: TurnId.make("turn-work-cancel-interrupted"),
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-work-cancel-pending-interrupt"),
        threadId: ThreadId.make("thread-work-cancel-pending-interrupted"),
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      for (const scenario of scenarios) {
        const rows = yield* sql<{ readonly kind: string; readonly state: string }>`
          SELECT kind, state
          FROM thread_work_obligations
          WHERE thread_id = ${ThreadId.make(`thread-work-cancel-${scenario.key}`)}
          ORDER BY kind ASC
        `;
        assert.deepEqual(
          rows,
          [
            {
              kind: "active-turn-recovery",
              state: scenario.deliverySurvives ? "pending" : "cancelled",
            },
            { kind: "agent-continuation", state: "cancelled" },
          ],
          `unexpected obligation states after thread ${scenario.key}`,
        );
      }
    }),
  );
});

it.layer(makeProjectionPipelinePrefixedTestLayer("t3-startup-resume-backfill-test-"))(
  "OrchestrationProjectionPipeline startup resume backfill",
  (it) => {
    const seedThread = (input: {
      readonly threadId: string;
      readonly turnId: string;
      readonly assistantMessageId: string;
      readonly turnState: string;
      readonly isStreaming: number;
      readonly sessionStatus: string;
      readonly activeTurnId: string | null;
      readonly completedAt: string | null;
      readonly assistantText: string;
      readonly assistantAttachmentsJson?: string;
      readonly interactionMode?: string;
      readonly pendingMessageId?: string;
    }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, branch, worktree_path, latest_turn_id,
            created_at, updated_at, deleted_at, runtime_mode, interaction_mode,
            model_selection_json, latest_user_message_at,
            pending_approval_count, pending_user_input_count
          ) VALUES (
            ${input.threadId}, 'project-recovery', 'Recovery Thread', NULL, NULL, ${input.turnId},
            '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:05.000Z', NULL,
            'full-access', ${input.interactionMode ?? "agent"},
            '{"instanceId":"codex","model":"gpt-5.6-sol"}', '2026-03-02T10:00:01.000Z',
            0, 0
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, attachments_json,
            is_streaming, created_at, updated_at
          ) VALUES (
            ${input.assistantMessageId}, ${input.threadId}, ${input.turnId}, 'assistant',
            ${input.assistantText}, ${input.assistantAttachmentsJson ?? null}, ${input.isStreaming},
            '2026-03-02T10:00:03.000Z', '2026-03-02T10:00:03.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (
            ${input.threadId}, ${input.turnId}, ${input.pendingMessageId ?? null}, ${input.assistantMessageId}, ${input.turnState},
            '2026-03-02T10:00:01.000Z', '2026-03-02T10:00:02.000Z', ${input.completedAt}, '[]'
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, provider_session_id, provider_thread_id,
            active_turn_id, last_error, updated_at, runtime_mode, provider_instance_id
          ) VALUES (
            ${input.threadId}, ${input.sessionStatus}, 'codex', NULL, NULL,
            ${input.activeTurnId}, NULL, '2026-03-02T10:00:02.000Z', 'full-access', 'codex'
          )
        `;
      });

    it.effect(
      "retires live synthetic resume owners after attachment-only or tool-only output",
      () =>
        Effect.gen(function* () {
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const eventStore = yield* OrchestrationEventStore;
          const sql = yield* SqlClient.SqlClient;

          for (const outputKind of ["attachment", "tool"] as const) {
            const threadId = `thread-live-${outputKind}-resume-output`;
            const sourceTurnId = `turn-before-live-${outputKind}-resume-output`;
            const resumedTurnId = `turn-live-${outputKind}-resume-output`;
            const resumeMessageId = `startup-auto-resume-message:${threadId}:${sourceTurnId}`;

            yield* seedThread({
              threadId,
              turnId: resumedTurnId,
              assistantMessageId: `assistant-live-${outputKind}-resume-output`,
              turnState: "running",
              isStreaming: 0,
              sessionStatus: "running",
              activeTurnId: resumedTurnId,
              completedAt: null,
              assistantText: " \n\t ",
              ...(outputKind === "attachment"
                ? {
                    assistantAttachmentsJson:
                      '[{"type":"image","id":"proof","name":"proof.png","mimeType":"image/png","sizeBytes":1}]',
                  }
                : {}),
              pendingMessageId: resumeMessageId,
            });
            yield* sql`
            INSERT INTO thread_work_obligations (
              obligation_id, thread_id, source_turn_id, kind, state,
              provider_instance_id, attempt, next_attempt_at, claimed_at,
              lease_expires_at, blocked_reason, created_at, updated_at
            ) VALUES (
              ${`live-${outputKind}-resume-owner`}, ${threadId}, ${sourceTurnId},
              'startup-resume', 'executing', 'codex', 1, NULL,
              '2026-03-02T10:00:02.000Z', '2026-03-02T10:01:02.000Z', NULL,
              '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:02.000Z'
            )
          `;
            if (outputKind === "tool") {
              yield* sql`
              INSERT INTO projection_thread_activities (
                activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
              ) VALUES (
                'activity-live-tool-resume-output', ${threadId}, ${resumedTurnId},
                'info', 'tool.completed', 'Tool completed', '{}',
                '2026-03-02T10:00:03.000Z'
              )
            `;
            }

            const sessionReadyEvent = yield* eventStore.append({
              type: "thread.session-set",
              eventId: EventId.make(`evt-live-${outputKind}-resume-ready`),
              aggregateKind: "thread",
              aggregateId: ThreadId.make(threadId),
              occurredAt: "2026-03-02T10:00:04.000Z",
              commandId: CommandId.make(`cmd-live-${outputKind}-resume-ready`),
              causationEventId: null,
              correlationId: CorrelationId.make(`cmd-live-${outputKind}-resume-ready`),
              metadata: {},
              payload: {
                threadId: ThreadId.make(threadId),
                session: {
                  threadId: ThreadId.make(threadId),
                  status: "ready",
                  providerName: "codex",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  runtimeMode: "full-access",
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: "2026-03-02T10:00:04.000Z",
                },
              },
            });
            yield* projectionPipeline.projectEvent(sessionReadyEvent);

            const obligations = yield* sql<{ readonly state: string }>`
            SELECT state
            FROM thread_work_obligations
            WHERE obligation_id = ${`live-${outputKind}-resume-owner`}
          `;
            assert.deepEqual(obligations, [{ state: "completed" }]);
          }
        }),
    );

    it.effect("retires delivered steers and recovers only falsely terminal steer owners", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const deliveredThreadId = "thread-startup-delivered-steer";
        const deliveredHostTurnId = "turn-startup-delivered-host";
        const deliveredHostMessageId = "message-startup-delivered-host";
        const deliveredMessageId = "message-startup-delivered-steer";
        const unconfirmedThreadId = "thread-startup-unconfirmed-steer";
        const unconfirmedMessageId = "message-startup-unconfirmed-steer";
        const legacyUnknownThreadId = "thread-startup-legacy-unknown-steer";
        const legacyUnknownMessageId = "message-startup-legacy-unknown-steer";
        const falseSupersededThreadId = "thread-startup-false-superseded-steer";
        const falseSupersededMessageId = "message-startup-false-superseded-steer";
        const trulySupersededThreadId = "thread-startup-truly-superseded-steer";
        const trulySupersededMessageId = "message-startup-truly-superseded-steer";
        const seededAt = "2026-03-02T09:00:00.000Z";

        for (const [threadId, messageId, state, blockedReason, hasPlaceholder] of [
          [
            deliveredThreadId,
            deliveredMessageId,
            "completed",
            ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
            true,
          ],
          [
            unconfirmedThreadId,
            unconfirmedMessageId,
            "completed",
            ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
            true,
          ],
          [
            legacyUnknownThreadId,
            legacyUnknownMessageId,
            "completed",
            ACTIVE_TURN_STEER_DELIVERY_UNKNOWN_REASON,
            false,
          ],
          [
            falseSupersededThreadId,
            falseSupersededMessageId,
            "cancelled",
            "turn-start was superseded",
            false,
          ],
          [
            trulySupersededThreadId,
            trulySupersededMessageId,
            "cancelled",
            "turn-start was superseded",
            false,
          ],
        ] as const) {
          yield* sql`
            INSERT INTO projection_threads (
              thread_id, project_id, title, branch, worktree_path, latest_turn_id,
              created_at, updated_at, deleted_at, runtime_mode, interaction_mode,
              model_selection_json, latest_user_message_at,
              pending_approval_count, pending_user_input_count
            ) VALUES (
              ${threadId}, 'project-steer-repair', 'Steer Repair', NULL, NULL, NULL,
              ${seededAt}, ${seededAt}, NULL, 'full-access', 'default',
              '{"instanceId":"codex","model":"gpt-5.6-sol"}', ${seededAt}, 0, 0
            )
          `;
          yield* sql`
            INSERT INTO projection_thread_messages (
              message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
            ) VALUES (
              ${messageId}, ${threadId}, NULL, 'user', 'Continue the work', 0,
              ${seededAt}, ${seededAt}
            )
          `;
          if (hasPlaceholder) {
            yield* sql`
              INSERT INTO projection_turns (
                thread_id, turn_id, pending_message_id, assistant_message_id, state,
                requested_at, started_at, completed_at, checkpoint_files_json
              ) VALUES (
                ${threadId}, NULL, ${messageId}, NULL, 'pending',
                ${seededAt}, NULL, NULL, '[]'
              )
            `;
          }
          yield* sql`
            INSERT INTO thread_work_obligations (
              obligation_id, thread_id, source_turn_id, kind, state,
              provider_instance_id, attempt, next_attempt_at, claimed_at,
              lease_expires_at, blocked_reason, created_at, updated_at
            ) VALUES (
              ${`work-${threadId}`}, ${threadId}, ${`turn-start:${messageId}`},
              'active-turn-recovery', ${state}, 'codex', 0, NULL, NULL, NULL,
              ${blockedReason},
              ${seededAt}, ${seededAt}
            )
          `;
          yield* eventStore.append({
            type: "thread.turn-start-requested",
            eventId: EventId.make(`evt-startup-steer-start-${threadId}`),
            aggregateKind: "thread",
            aggregateId: ThreadId.make(threadId),
            occurredAt: seededAt,
            commandId: CommandId.make(`cmd-startup-steer-start-${threadId}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-startup-steer-start-${threadId}`),
            metadata: {},
            payload: {
              threadId: ThreadId.make(threadId),
              messageId: MessageId.make(messageId),
              runtimeMode: "full-access",
              createdAt: seededAt,
            },
          });
        }

        for (const [threadId, messageId, inputOrigin] of [
          [
            falseSupersededThreadId,
            `startup-auto-resume-message:${falseSupersededThreadId}:turn-interrupted`,
            null,
          ],
          [trulySupersededThreadId, "message-startup-truly-later-user", null],
        ] as const) {
          yield* sql`
            INSERT INTO projection_thread_messages (
              message_id, thread_id, turn_id, role, text, input_origin,
              is_streaming, created_at, updated_at
            ) VALUES (
              ${messageId}, ${threadId}, NULL, 'user', 'Later message', ${inputOrigin},
              0, '2026-03-02T09:00:01.000Z', '2026-03-02T09:00:01.000Z'
            )
          `;
          yield* eventStore.append({
            type: "thread.turn-start-requested",
            eventId: EventId.make(`evt-startup-steer-later-${threadId}`),
            aggregateKind: "thread",
            aggregateId: ThreadId.make(threadId),
            occurredAt: "2026-03-02T09:00:01.000Z",
            commandId: CommandId.make(`cmd-startup-steer-later-${threadId}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-startup-steer-later-${threadId}`),
            metadata: {},
            payload: {
              threadId: ThreadId.make(threadId),
              messageId: MessageId.make(messageId),
              runtimeMode: "full-access",
              createdAt: "2026-03-02T09:00:01.000Z",
            },
          });
        }

        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (
            ${deliveredThreadId}, ${deliveredHostTurnId}, ${deliveredHostMessageId}, NULL,
            'completed', '2026-03-02T08:00:00.000Z', '2026-03-02T08:00:00.000Z',
            '2026-03-02T09:01:00.000Z', '[]'
          )
        `;
        yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make("evt-startup-delivered-steer-receipt"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make(deliveredThreadId),
          occurredAt: "2026-03-02T08:00:00.100Z",
          commandId: CommandId.make("cmd-startup-delivered-steer-receipt"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-startup-delivered-steer-receipt"),
          metadata: {},
          payload: {
            threadId: ThreadId.make(deliveredThreadId),
            activity: {
              id: EventId.make("activity-startup-delivered-steer"),
              tone: "info",
              kind: "message.delivered",
              summary: "Message delivered to the provider",
              payload: { messageId: MessageId.make(deliveredMessageId) },
              turnId: TurnId.make(deliveredHostTurnId),
              // Intentionally clock-skewed earlier than the user event: durable
              // event sequence, not client/provider wall clocks, proves freshness.
              createdAt: "2026-03-02T08:00:00.100Z",
            },
          },
        });

        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const pendingRows = yield* sql<{
          readonly threadId: string;
          readonly messageId: string;
        }>`
          SELECT thread_id AS "threadId", pending_message_id AS "messageId"
          FROM projection_turns
          WHERE turn_id IS NULL AND state = 'pending'
            AND thread_id IN (
              ${deliveredThreadId}, ${unconfirmedThreadId}, ${legacyUnknownThreadId},
              ${falseSupersededThreadId}, ${trulySupersededThreadId}
            )
          ORDER BY thread_id ASC
        `;
        assert.deepEqual(pendingRows, [
          { threadId: falseSupersededThreadId, messageId: falseSupersededMessageId },
          { threadId: legacyUnknownThreadId, messageId: legacyUnknownMessageId },
          { threadId: unconfirmedThreadId, messageId: unconfirmedMessageId },
        ]);

        const obligations = yield* sql<{
          readonly threadId: string;
          readonly state: string;
          readonly blockedReason: string | null;
        }>`
          SELECT thread_id AS "threadId", state, blocked_reason AS "blockedReason"
          FROM thread_work_obligations
          WHERE thread_id IN (
            ${deliveredThreadId}, ${unconfirmedThreadId}, ${legacyUnknownThreadId},
            ${falseSupersededThreadId}, ${trulySupersededThreadId}
          )
          ORDER BY thread_id ASC
        `;
        assert.deepEqual(obligations, [
          { threadId: deliveredThreadId, state: "completed", blockedReason: null },
          { threadId: falseSupersededThreadId, state: "pending", blockedReason: null },
          { threadId: legacyUnknownThreadId, state: "pending", blockedReason: null },
          {
            threadId: trulySupersededThreadId,
            state: "cancelled",
            blockedReason: "turn-start was superseded",
          },
          {
            threadId: unconfirmedThreadId,
            state: "pending",
            blockedReason: null,
          },
        ]);
      }),
    );

    it.effect("uses exact receipt sequence at boot without reviving stopped deliveries", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const freshThreadId = "thread-startup-fresh-ordinary-receipt";
        const freshMessageId = "message-startup-fresh-ordinary-receipt";
        const siblingMessageId = "message-startup-fresh-sibling";
        const staleThreadId = "thread-startup-stale-receipt";
        const staleMessageId = "message-startup-stale-receipt";
        const cancelledThreadId = "thread-startup-cancelled-receipt";
        const cancelledMessageId = "message-startup-cancelled-receipt";
        const seededAt = "2026-03-02T09:10:00.000Z";

        const seedPending = (input: {
          readonly threadId: string;
          readonly messageId: string;
          readonly state: "pending" | "cancelled";
          readonly offset: number;
        }) =>
          Effect.gen(function* () {
            yield* sql`
              INSERT OR IGNORE INTO projection_threads (
                thread_id, project_id, title, branch, worktree_path, latest_turn_id,
                created_at, updated_at, deleted_at, runtime_mode, interaction_mode,
                model_selection_json, latest_user_message_at,
                pending_approval_count, pending_user_input_count
              ) VALUES (
                ${input.threadId}, 'project-receipt-sequence', 'Receipt Sequence',
                NULL, NULL, NULL, ${seededAt}, ${seededAt}, NULL, 'full-access',
                'default', '{"instanceId":"codex","model":"gpt-5.6-sol"}',
                ${seededAt}, 0, 0
              )
            `;
            yield* sql`
              INSERT INTO projection_thread_messages (
                message_id, thread_id, turn_id, role, text, is_streaming,
                created_at, updated_at
              ) VALUES (
                ${input.messageId}, ${input.threadId}, NULL, 'user', 'Continue', 0,
                ${seededAt}, ${seededAt}
              )
            `;
            yield* sql`
              INSERT INTO projection_turns (
                thread_id, turn_id, pending_message_id, assistant_message_id, state,
                requested_at, started_at, completed_at, checkpoint_files_json
              ) VALUES (
                ${input.threadId}, NULL, ${input.messageId}, NULL, 'pending',
                ${`2026-03-02T09:10:0${input.offset}.000Z`}, NULL, NULL, '[]'
              )
            `;
            yield* sql`
              INSERT INTO thread_work_obligations (
                obligation_id, thread_id, source_turn_id, kind, state,
                provider_instance_id, attempt, next_attempt_at, claimed_at,
                lease_expires_at, blocked_reason, created_at, updated_at
              ) VALUES (
                ${`work-${input.messageId}`}, ${input.threadId},
                ${`turn-start:${input.messageId}`}, 'active-turn-recovery', ${input.state},
                'codex', 0, NULL, NULL, NULL,
                ${input.state === "cancelled" ? "user stopped the delivery" : null},
                ${seededAt}, ${seededAt}
              )
            `;
          });

        yield* seedPending({
          threadId: freshThreadId,
          messageId: freshMessageId,
          state: "pending",
          offset: 1,
        });
        yield* seedPending({
          threadId: freshThreadId,
          messageId: siblingMessageId,
          state: "pending",
          offset: 2,
        });
        yield* seedPending({
          threadId: staleThreadId,
          messageId: staleMessageId,
          state: "pending",
          offset: 3,
        });
        yield* seedPending({
          threadId: cancelledThreadId,
          messageId: cancelledMessageId,
          state: "cancelled",
          offset: 4,
        });

        const appendStart = (suffix: string, threadId: string, messageId: string) =>
          eventStore.append({
            type: "thread.turn-start-requested",
            eventId: EventId.make(`evt-receipt-sequence-start-${suffix}`),
            aggregateKind: "thread",
            aggregateId: ThreadId.make(threadId),
            occurredAt: seededAt,
            commandId: CommandId.make(`cmd-receipt-sequence-start-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-receipt-sequence-start-${suffix}`),
            metadata: {},
            payload: {
              threadId: ThreadId.make(threadId),
              messageId: MessageId.make(messageId),
              runtimeMode: "full-access" as const,
              createdAt: seededAt,
            },
          });
        const appendReceipt = (suffix: string, threadId: string, messageId: string) =>
          eventStore.append({
            type: "thread.activity-appended",
            eventId: EventId.make(`evt-receipt-sequence-delivered-${suffix}`),
            aggregateKind: "thread",
            aggregateId: ThreadId.make(threadId),
            occurredAt: "2026-03-02T09:10:09.000Z",
            commandId: CommandId.make(`cmd-receipt-sequence-delivered-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-receipt-sequence-delivered-${suffix}`),
            metadata: {},
            payload: {
              threadId: ThreadId.make(threadId),
              activity: {
                id: EventId.make(`activity-receipt-sequence-${suffix}`),
                tone: "info" as const,
                kind: "message.delivered" as const,
                summary: "Message delivered to the provider",
                payload: { messageId: MessageId.make(messageId) },
                turnId: null,
                createdAt: "2026-03-02T09:10:09.000Z",
              },
            },
          });

        yield* appendStart("fresh", freshThreadId, freshMessageId);
        yield* appendReceipt("fresh", freshThreadId, freshMessageId);
        yield* appendStart("sibling", freshThreadId, siblingMessageId);
        // A receipt from an earlier attempt cannot prove the later exact start.
        yield* appendReceipt("stale", staleThreadId, staleMessageId);
        yield* appendStart("stale", staleThreadId, staleMessageId);
        yield* appendStart("cancelled", cancelledThreadId, cancelledMessageId);
        yield* appendReceipt("cancelled", cancelledThreadId, cancelledMessageId);

        yield* projectionPipeline.reconcileOrphanedInFlightWork;
        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const pending = yield* sql<{
          readonly threadId: string;
          readonly messageId: string;
        }>`
          SELECT thread_id AS "threadId", pending_message_id AS "messageId"
          FROM projection_turns
          WHERE turn_id IS NULL AND state = 'pending'
            AND thread_id IN (${freshThreadId}, ${staleThreadId}, ${cancelledThreadId})
          ORDER BY thread_id ASC, pending_message_id ASC
        `;
        assert.deepEqual(pending, [
          { threadId: freshThreadId, messageId: siblingMessageId },
          { threadId: staleThreadId, messageId: staleMessageId },
        ]);

        const owners = yield* sql<{
          readonly messageId: string;
          readonly state: string;
          readonly blockedReason: string | null;
        }>`
          SELECT
            substr(source_turn_id, length('turn-start:') + 1) AS "messageId",
            state,
            blocked_reason AS "blockedReason"
          FROM thread_work_obligations
          WHERE thread_id IN (${freshThreadId}, ${staleThreadId}, ${cancelledThreadId})
          ORDER BY messageId ASC
        `;
        assert.deepEqual(owners, [
          {
            messageId: cancelledMessageId,
            state: "cancelled",
            blockedReason: "user stopped the delivery",
          },
          { messageId: freshMessageId, state: "completed", blockedReason: null },
          { messageId: siblingMessageId, state: "pending", blockedReason: null },
          { messageId: staleMessageId, state: "pending", blockedReason: null },
        ]);
      }),
    );

    it.effect("reconstructs owned queue rows and retires inactive-thread work at boot", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const activeThreadId = "thread-reconstruct-owned-pending";
        const activeMessageId = "message-reconstruct-owned-pending";
        const inactiveThreadId = "thread-retire-inactive-pending";
        const inactiveMessageId = "message-retire-inactive-pending";
        const seededAt = "2026-03-02T09:20:00.000Z";

        for (const [threadId, messageId, archivedAt] of [
          [activeThreadId, activeMessageId, null],
          [inactiveThreadId, inactiveMessageId, "2026-03-02T09:21:00.000Z"],
        ] as const) {
          yield* sql`
            INSERT INTO projection_threads (
              thread_id, project_id, title, branch, worktree_path, latest_turn_id,
              created_at, updated_at, deleted_at, archived_at, runtime_mode,
              interaction_mode, model_selection_json, latest_user_message_at,
              pending_approval_count, pending_user_input_count
            ) VALUES (
              ${threadId}, 'project-startup-queue-repair', 'Startup Queue Repair',
              NULL, NULL, NULL, ${seededAt}, ${seededAt}, NULL, ${archivedAt},
              'full-access', 'default',
              '{"instanceId":"codex","model":"gpt-5.6-sol"}', ${seededAt}, 0, 0
            )
          `;
          yield* sql`
            INSERT INTO projection_thread_messages (
              message_id, thread_id, turn_id, role, text, is_streaming,
              created_at, updated_at
            ) VALUES (
              ${messageId}, ${threadId}, NULL, 'user', 'Continue', 0,
              ${seededAt}, ${seededAt}
            )
          `;
          yield* sql`
            INSERT INTO thread_work_obligations (
              obligation_id, thread_id, source_turn_id, kind, state,
              provider_instance_id, attempt, next_attempt_at, claimed_at,
              lease_expires_at, blocked_reason, created_at, updated_at
            ) VALUES (
              ${`work-${messageId}`}, ${threadId}, ${`turn-start:${messageId}`},
              'active-turn-recovery', 'pending', 'codex', 0, NULL, NULL, NULL,
              NULL, ${seededAt}, ${seededAt}
            )
          `;
          yield* eventStore.append({
            type: "thread.turn-start-requested",
            eventId: EventId.make(`evt-startup-queue-repair-${messageId}`),
            aggregateKind: "thread",
            aggregateId: ThreadId.make(threadId),
            occurredAt: seededAt,
            commandId: CommandId.make(`cmd-startup-queue-repair-${messageId}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-startup-queue-repair-${messageId}`),
            metadata: {},
            payload: {
              threadId: ThreadId.make(threadId),
              messageId: MessageId.make(messageId),
              runtimeMode: "full-access",
              createdAt: seededAt,
            },
          });
        }
        // Only the inactive thread starts with a visible legacy row. The
        // active thread simulates B having been overwritten by old single-slot
        // queue code while its durable owner and event survived.
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (
            ${inactiveThreadId}, NULL, ${inactiveMessageId}, NULL, 'pending',
            ${seededAt}, NULL, NULL, '[]'
          )
        `;

        yield* projectionPipeline.reconcileOrphanedInFlightWork;
        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const pending = yield* sql<{
          readonly threadId: string;
          readonly messageId: string;
        }>`
          SELECT thread_id AS "threadId", pending_message_id AS "messageId"
          FROM projection_turns
          WHERE turn_id IS NULL AND state = 'pending'
            AND thread_id IN (${activeThreadId}, ${inactiveThreadId})
          ORDER BY thread_id ASC
        `;
        assert.deepEqual(pending, [{ threadId: activeThreadId, messageId: activeMessageId }]);

        const inactiveOwner = yield* sql<{
          readonly state: string;
          readonly blockedReason: string | null;
        }>`
          SELECT state, blocked_reason AS "blockedReason"
          FROM thread_work_obligations
          WHERE thread_id = ${inactiveThreadId}
        `;
        assert.deepEqual(inactiveOwner, [
          { state: "cancelled", blockedReason: "thread is inactive after restart" },
        ]);
      }),
    );

    // The 2026-08-05 incident: a hard kill (deploy/SIGKILL) projects no
    // session-set, so the turn stays "running" — invisible to the recovery
    // scan, which only considers settled turns. It sat "running" for 95
    // minutes while the UI counted up, and only settled when the user typed.
    it.effect("settles a turn a hard kill left running, then enqueues its resume", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = "thread-hard-kill-running";
        const turnId = "turn-hard-kill-running";
        const assistantMessageId = "assistant-hard-kill-running";

        // Killed mid-stream: turn still "running", assistant still streaming.
        yield* seedThread({
          threadId,
          turnId,
          assistantMessageId,
          turnState: "running",
          isStreaming: 1,
          sessionStatus: "running",
          activeTurnId: turnId,
          completedAt: null,
          assistantText: "Deploying the new build now.",
        });

        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const [turnRow] = yield* sql<{
          readonly state: string;
          readonly completedAt: string | null;
        }>`
          SELECT state, completed_at AS "completedAt" FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        `;
        assert.equal(turnRow?.state, "incomplete");
        assert.notEqual(turnRow?.completedAt, null);

        const [messageRow] = yield* sql<{ readonly isStreaming: number }>`
          SELECT is_streaming AS "isStreaming" FROM projection_thread_messages
          WHERE message_id = ${assistantMessageId}
        `;
        assert.equal(messageRow?.isStreaming, 0);

        const [sessionRow] = yield* sql<{
          readonly status: string;
          readonly activeTurnId: string | null;
        }>`
          SELECT status, active_turn_id AS "activeTurnId"
          FROM projection_thread_sessions WHERE thread_id = ${threadId}
        `;
        assert.equal(sessionRow?.status, "stopped");
        assert.equal(sessionRow?.activeTurnId, null);

        // And the now-settled turn is visible to the recovery scan.
        const obligations = yield* sql<{ readonly kind: string; readonly state: string }>`
          SELECT kind, state FROM thread_work_obligations WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(obligations, [{ kind: "startup-resume", state: "pending" }]);
      }),
    );

    it.effect("does not re-arm a terminal local provider timeout on restart", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = "thread-local-control-timeout";
        const turnId = "turn-local-control-timeout";

        yield* seedThread({
          threadId,
          turnId,
          assistantMessageId: "assistant-local-control-timeout",
          turnState: "incomplete",
          isStreaming: 0,
          sessionStatus: "error",
          activeTurnId: null,
          completedAt: "2026-03-02T10:00:04.000Z",
          assistantText: "The provider could not finish starting.",
        });
        yield* sql`
          UPDATE projection_thread_sessions
          SET failure_kind = 'local-control-timeout',
              last_error = 'Codex App Server did not respond to thread/start within 90000ms.',
              updated_at = '2026-03-02T10:00:04.000Z'
          WHERE thread_id = ${threadId}
        `;
        yield* sql`
          INSERT INTO thread_work_obligations (
            obligation_id, thread_id, source_turn_id, kind, state,
            provider_instance_id, attempt, next_attempt_at, claimed_at,
            lease_expires_at, blocked_reason, created_at, updated_at
          ) VALUES (
            'terminal-timeout-owner', ${threadId}, ${turnId},
            'startup-resume', 'executing', 'codex', 1, NULL,
            '2026-03-02T10:00:03.000Z', '2026-03-02T10:01:03.000Z', NULL,
            '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:03.000Z'
          )
        `;
        yield* sql`
          INSERT INTO thread_work_obligations (
            obligation_id, thread_id, source_turn_id, kind, state,
            provider_instance_id, attempt, next_attempt_at, claimed_at,
            lease_expires_at, blocked_reason, created_at, updated_at
          ) VALUES (
            'post-timeout-user-owner', ${threadId}, 'turn-start:newer-user-message',
            'active-turn-recovery', 'pending', 'codex', 0, NULL,
            NULL, NULL, NULL,
            '2026-03-02T10:00:02.000Z', '2026-03-02T10:00:02.000Z'
          )
        `;

        yield* projectionPipeline.reconcileOrphanedInFlightWork;
        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const sessions = yield* sql<{
          readonly status: string;
          readonly failureKind: string | null;
        }>`
          SELECT status, failure_kind AS "failureKind"
          FROM projection_thread_sessions
          WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(sessions, [{ status: "error", failureKind: "local-control-timeout" }]);
        const obligations = yield* sql<{
          readonly kind: string;
          readonly state: string;
          readonly blockedReason: string | null;
        }>`
          SELECT kind, state, blocked_reason AS "blockedReason"
          FROM thread_work_obligations
          WHERE thread_id = ${threadId}
          ORDER BY created_at
        `;
        assert.deepEqual(obligations, [
          {
            kind: "startup-resume",
            state: "cancelled",
            blockedReason: "Codex App Server did not respond to thread/start within 90000ms.",
          },
          {
            kind: "active-turn-recovery",
            state: "pending",
            blockedReason: null,
          },
        ]);
      }),
    );

    it.effect("retires a completed synthetic resume owner during restart recovery", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = "thread-completed-synthetic-resume";
        const sourceTurnId = "turn-before-completed-synthetic-resume";
        const resumedTurnId = "turn-completed-synthetic-resume";
        const resumeMessageId = `startup-auto-resume-message:${threadId}:${sourceTurnId}`;

        yield* seedThread({
          threadId,
          turnId: resumedTurnId,
          assistantMessageId: "assistant-completed-synthetic-resume",
          turnState: "completed",
          isStreaming: 0,
          sessionStatus: "ready",
          activeTurnId: null,
          completedAt: "2026-03-02T10:00:04.000Z",
          assistantText: "Everything requested is complete.\n\nAGENT_STOP",
          pendingMessageId: resumeMessageId,
        });
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, input_origin,
            is_streaming, created_at, updated_at
          ) VALUES (
            ${resumeMessageId}, ${threadId}, ${resumedTurnId}, 'user',
            'Please resume your current task.', 'agent-loop',
            0, '2026-03-02T10:00:01.000Z', '2026-03-02T10:00:01.000Z'
          )
        `;
        yield* sql`
          INSERT INTO thread_work_obligations (
            obligation_id, thread_id, source_turn_id, kind, state,
            provider_instance_id, attempt, next_attempt_at, claimed_at,
            lease_expires_at, blocked_reason, created_at, updated_at
          ) VALUES (
            'completed-synthetic-resume-owner', ${threadId}, ${sourceTurnId},
            'startup-resume', 'executing', 'codex', 1, NULL,
            '2026-03-02T10:00:01.000Z', '2026-03-02T10:01:01.000Z', NULL,
            '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:01.000Z'
          )
        `;
        yield* sql`
          UPDATE projection_threads
          SET pending_work_kind = 'startup-resume',
              pending_work_state = 'executing',
              pending_work_since = '2026-03-02T10:00:00.000Z'
          WHERE thread_id = ${threadId}
        `;

        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const obligations = yield* sql<{
          readonly state: string;
          readonly claimedAt: string | null;
          readonly leaseExpiresAt: string | null;
        }>`
          SELECT
            state,
            claimed_at AS "claimedAt",
            lease_expires_at AS "leaseExpiresAt"
          FROM thread_work_obligations
          WHERE obligation_id = 'completed-synthetic-resume-owner'
        `;
        assert.deepEqual(obligations, [
          { state: "completed", claimedAt: null, leaseExpiresAt: null },
        ]);

        const pendingWork = yield* sql<{
          readonly kind: string | null;
          readonly state: string | null;
        }>`
          SELECT
            pending_work_kind AS "kind",
            pending_work_state AS "state"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(pendingWork, [{ kind: null, state: null }]);
      }),
    );

    it.effect(
      "retires completed synthetic resume owners with attachment-only or tool-only output on restart",
      () =>
        Effect.gen(function* () {
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const sql = yield* SqlClient.SqlClient;

          for (const outputKind of ["attachment", "tool"] as const) {
            const threadId = `thread-restart-${outputKind}-resume-output`;
            const sourceTurnId = `turn-before-restart-${outputKind}-resume-output`;
            const resumedTurnId = `turn-restart-${outputKind}-resume-output`;
            const resumeMessageId = `startup-auto-resume-message:${threadId}:${sourceTurnId}`;

            yield* seedThread({
              threadId,
              turnId: resumedTurnId,
              assistantMessageId: `assistant-restart-${outputKind}-resume-output`,
              turnState: "completed",
              isStreaming: 0,
              sessionStatus: "ready",
              activeTurnId: null,
              completedAt: "2026-03-02T10:00:04.000Z",
              assistantText: " \n\t ",
              ...(outputKind === "attachment"
                ? {
                    assistantAttachmentsJson:
                      '[{"type":"image","id":"proof","name":"proof.png","mimeType":"image/png","sizeBytes":1}]',
                  }
                : {}),
              pendingMessageId: resumeMessageId,
            });
            yield* sql`
              INSERT INTO thread_work_obligations (
                obligation_id, thread_id, source_turn_id, kind, state,
                provider_instance_id, attempt, next_attempt_at, claimed_at,
                lease_expires_at, blocked_reason, created_at, updated_at
              ) VALUES (
                ${`restart-${outputKind}-resume-owner`}, ${threadId}, ${sourceTurnId},
                'startup-resume', 'executing', 'codex', 1, NULL,
                '2026-03-02T10:00:02.000Z', '2026-03-02T10:01:02.000Z', NULL,
                '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:02.000Z'
              )
            `;
            if (outputKind === "tool") {
              yield* sql`
                INSERT INTO projection_thread_activities (
                  activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
                ) VALUES (
                  'activity-restart-tool-resume-output', ${threadId}, ${resumedTurnId},
                  'info', 'tool.completed', 'Tool completed', '{}',
                  '2026-03-02T10:00:03.000Z'
                )
              `;
            }
          }

          yield* projectionPipeline.reconcileOrphanedInFlightWork;

          const obligations = yield* sql<{
            readonly obligationId: string;
            readonly state: string;
          }>`
            SELECT obligation_id AS "obligationId", state
            FROM thread_work_obligations
            WHERE obligation_id IN (
              'restart-attachment-resume-owner',
              'restart-tool-resume-owner'
            )
            ORDER BY obligation_id ASC
          `;
          assert.deepEqual(obligations, [
            { obligationId: "restart-attachment-resume-owner", state: "completed" },
            { obligationId: "restart-tool-resume-owner", state: "completed" },
          ]);
        }),
    );

    it.effect("does not synthesize Agent continuation from a completed cleanup turn at boot", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = "thread-completed-browser-cleanup";
        const turnId = "turn-completed-browser-cleanup";
        const cleanupMessageId = `browser-tab-cleanup-message:${threadId}:source-turn`;

        yield* seedThread({
          threadId,
          turnId,
          assistantMessageId: "assistant-completed-browser-cleanup",
          turnState: "completed",
          isStreaming: 0,
          sessionStatus: "ready",
          activeTurnId: null,
          completedAt: "2026-03-02T10:00:04.000Z",
          assistantText: "Closed the unused browser tabs.",
          pendingMessageId: cleanupMessageId,
        });
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, input_origin,
            is_streaming, created_at, updated_at
          ) VALUES (
            ${cleanupMessageId}, ${threadId}, ${turnId}, 'user',
            'Browser tab check: 2 tabs are open.', 'agent-loop',
            0, '2026-03-02T10:00:01.000Z', '2026-03-02T10:00:01.000Z'
          )
        `;
        yield* sql`
          UPDATE projection_thread_sessions
          SET updated_at = '2026-03-02T10:00:04.000Z'
          WHERE thread_id = ${threadId}
        `;

        yield* projectionPipeline.reconcileOrphanedInFlightWork;
        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const continuations = yield* sql<{ readonly state: string }>`
          SELECT state
          FROM thread_work_obligations
          WHERE thread_id = ${threadId}
            AND kind = 'agent-continuation'
        `;
        assert.deepEqual(continuations, []);
      }),
    );

    it.effect("never revives terminal startup-resume verdicts during reconciliation", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const scenarios = [
          {
            suffix: "completed",
            state: "completed",
            blockedReason: null,
          },
          {
            suffix: "agent-stop",
            state: "cancelled",
            blockedReason: "agent signed off with AGENT_STOP",
          },
          {
            suffix: "user-stop",
            state: "cancelled",
            blockedReason: "thread.turn-interrupt-requested",
          },
        ] as const;

        for (const scenario of scenarios) {
          const threadId = `thread-terminal-resume-${scenario.suffix}`;
          const sourceTurnId = `turn-terminal-resume-${scenario.suffix}`;
          yield* seedThread({
            threadId,
            turnId: sourceTurnId,
            assistantMessageId: `assistant-terminal-resume-${scenario.suffix}`,
            turnState: "incomplete",
            isStreaming: 0,
            sessionStatus: "stopped",
            activeTurnId: null,
            completedAt: "2026-03-02T10:00:04.000Z",
            assistantText: "The previous provider process stopped.",
          });
          yield* sql`
            INSERT INTO thread_work_obligations (
              obligation_id, thread_id, source_turn_id, kind, state,
              provider_instance_id, attempt, next_attempt_at, claimed_at,
              lease_expires_at, blocked_reason, created_at, updated_at
            ) VALUES (
              ${`terminal-resume-owner-${scenario.suffix}`}, ${threadId}, ${sourceTurnId},
              'startup-resume', ${scenario.state}, 'codex', 3, NULL, NULL, NULL,
              ${scenario.blockedReason}, '2026-03-02T10:00:00.000Z',
              '2026-03-02T10:00:05.000Z'
            )
          `;
        }

        yield* projectionPipeline.reconcileOrphanedInFlightWork;
        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const owners = yield* sql<{
          readonly obligationId: string;
          readonly state: string;
          readonly attempt: number;
          readonly blockedReason: string | null;
        }>`
          SELECT
            obligation_id AS "obligationId",
            state,
            attempt,
            blocked_reason AS "blockedReason"
          FROM thread_work_obligations
          WHERE obligation_id LIKE 'terminal-resume-owner-%'
          ORDER BY obligation_id ASC
        `;
        assert.deepEqual(owners, [
          {
            obligationId: "terminal-resume-owner-agent-stop",
            state: "cancelled",
            attempt: 3,
            blockedReason: "agent signed off with AGENT_STOP",
          },
          {
            obligationId: "terminal-resume-owner-completed",
            state: "completed",
            attempt: 3,
            blockedReason: null,
          },
          {
            obligationId: "terminal-resume-owner-user-stop",
            state: "cancelled",
            attempt: 3,
            blockedReason: "thread.turn-interrupt-requested",
          },
        ]);
      }),
    );

    it.effect("keeps an empty completed synthetic resume eligible for retry after restart", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = "thread-empty-synthetic-resume";
        const sourceTurnId = "turn-before-empty-synthetic-resume";
        const resumedTurnId = "turn-empty-synthetic-resume";
        const resumeMessageId = `startup-auto-resume-message:${threadId}:${sourceTurnId}`;

        yield* seedThread({
          threadId,
          turnId: resumedTurnId,
          assistantMessageId: "assistant-empty-synthetic-resume",
          turnState: "completed",
          isStreaming: 0,
          sessionStatus: "ready",
          activeTurnId: null,
          completedAt: "2026-03-02T10:00:04.000Z",
          assistantText: " \n\t\r ",
          pendingMessageId: resumeMessageId,
        });
        yield* sql`
          INSERT INTO thread_work_obligations (
            obligation_id, thread_id, source_turn_id, kind, state,
            provider_instance_id, attempt, next_attempt_at, claimed_at,
            lease_expires_at, blocked_reason, created_at, updated_at
          ) VALUES (
            'empty-synthetic-resume-owner', ${threadId}, ${sourceTurnId},
            'startup-resume', 'executing', 'codex', 1, NULL,
            '2026-03-02T10:00:01.000Z', '2026-03-02T10:01:01.000Z', NULL,
            '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:01.000Z'
          )
        `;

        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const obligations = yield* sql<{ readonly state: string }>`
          SELECT state
          FROM thread_work_obligations
          WHERE obligation_id = 'empty-synthetic-resume-owner'
        `;
        assert.deepEqual(obligations, [{ state: "executing" }]);
      }),
    );

    // A turn that did settle to "incomplete" (graceful quit projects
    // session-set(stopped)) is neither an auth pause nor an agent continuation
    // — continuation requires "completed" — so before the startup-resume branch
    // existed the scan skipped it and the thread stayed dead until the user
    // typed, despite --auto-resume and a registered startup-resume handler.
    it.effect("enqueues a startup resume for an already-incomplete turn", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = "thread-incomplete-resume";
        const turnId = "turn-incomplete-resume";

        yield* seedThread({
          threadId,
          turnId,
          assistantMessageId: "assistant-incomplete-resume",
          turnState: "incomplete",
          isStreaming: 0,
          sessionStatus: "stopped",
          activeTurnId: null,
          completedAt: "2026-03-02T10:00:04.000Z",
          assistantText: "Deploying the new build now.",
        });

        yield* projectionPipeline.bootstrap;

        const obligations = yield* sql<{
          readonly sourceTurnId: string;
          readonly kind: string;
          readonly state: string;
        }>`
          SELECT source_turn_id AS "sourceTurnId", kind, state
          FROM thread_work_obligations WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(obligations, [
          { sourceTurnId: turnId, kind: "startup-resume", state: "pending" },
        ]);
      }),
    );

    it.effect("enqueues a startup resume for an incomplete default-mode turn", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = "thread-incomplete-default-resume";
        const turnId = "turn-incomplete-default-resume";

        yield* seedThread({
          threadId,
          turnId,
          assistantMessageId: "assistant-incomplete-default-resume",
          turnState: "incomplete",
          isStreaming: 0,
          sessionStatus: "stopped",
          activeTurnId: null,
          completedAt: "2026-03-02T10:00:04.000Z",
          assistantText: "Still working through the install.",
          interactionMode: "default",
        });

        yield* projectionPipeline.bootstrap;

        const obligations = yield* sql<{
          readonly sourceTurnId: string;
          readonly kind: string;
          readonly state: string;
        }>`
          SELECT source_turn_id AS "sourceTurnId", kind, state
          FROM thread_work_obligations WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(obligations, [
          { sourceTurnId: turnId, kind: "startup-resume", state: "pending" },
        ]);
      }),
    );

    it.effect(
      "uses event sequence for restart supersession and ignores synthetic descendants",
      () =>
        Effect.gen(function* () {
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const sql = yield* SqlClient.SqlClient;
          const realThreadId = "thread-restart-later-real-user";
          const realTurnId = "turn-restart-later-real-user";
          const realSourceMessageId = "message-restart-before-real-user";
          const syntheticThreadId = "thread-restart-later-synthetic";
          const syntheticTurnId = "turn-restart-later-synthetic";
          const syntheticSourceMessageId = "message-restart-before-synthetic";

          yield* seedThread({
            threadId: realThreadId,
            turnId: realTurnId,
            assistantMessageId: "assistant-restart-later-real-user",
            turnState: "incomplete",
            isStreaming: 0,
            sessionStatus: "stopped",
            activeTurnId: null,
            completedAt: "2026-03-02T10:00:04.000Z",
            assistantText: "Still working through the install.",
            pendingMessageId: realSourceMessageId,
          });
          yield* seedThread({
            threadId: syntheticThreadId,
            turnId: syntheticTurnId,
            assistantMessageId: "assistant-restart-later-synthetic",
            turnState: "incomplete",
            isStreaming: 0,
            sessionStatus: "stopped",
            activeTurnId: null,
            completedAt: "2026-03-02T10:00:04.000Z",
            assistantText: "Still working through the install.",
            pendingMessageId: syntheticSourceMessageId,
          });

          const insertStartEvent = (input: {
            readonly threadId: string;
            readonly messageId: string;
            readonly eventSuffix: string;
            readonly streamVersion: number;
            readonly occurredAt: string;
          }) => {
            const payload = JSON.stringify({
              threadId: input.threadId,
              messageId: input.messageId,
              runtimeMode: "full-access",
              createdAt: input.occurredAt,
            });
            return sql`
              INSERT INTO orchestration_events (
                event_id, aggregate_kind, stream_id, stream_version, event_type,
                occurred_at, command_id, causation_event_id, correlation_id,
                actor_kind, payload_json, metadata_json
              ) VALUES (
                ${`evt-${input.eventSuffix}`}, 'thread', ${input.threadId},
                ${input.streamVersion}, 'thread.turn-start-requested',
                ${input.occurredAt}, ${`cmd-${input.eventSuffix}`}, NULL,
                ${`cmd-${input.eventSuffix}`}, 'client', ${payload}, '{}'
              )
            `;
          };

          for (const source of [
            {
              threadId: realThreadId,
              messageId: realSourceMessageId,
              eventSuffix: "restart-real-source",
            },
            {
              threadId: syntheticThreadId,
              messageId: syntheticSourceMessageId,
              eventSuffix: "restart-synthetic-source",
            },
          ]) {
            yield* insertStartEvent({
              ...source,
              streamVersion: 1,
              occurredAt: "2026-03-02T10:00:01.000Z",
            });
          }
          // Appended later, despite a clock-skewed earlier timestamp: this is
          // newer real intent and must suppress replay of the source turn.
          yield* insertStartEvent({
            threadId: realThreadId,
            messageId: "message-restart-later-real-user",
            eventSuffix: "restart-real-later",
            streamVersion: 2,
            occurredAt: "2026-03-02T09:00:00.000Z",
          });
          // Startup/continuation descendants are implementation-owned resumes,
          // not new user intent, and therefore do not supersede their source.
          yield* insertStartEvent({
            threadId: syntheticThreadId,
            messageId: `startup-auto-resume-message:${syntheticThreadId}:${syntheticTurnId}`,
            eventSuffix: "restart-synthetic-later",
            streamVersion: 2,
            occurredAt: "2026-03-02T11:00:00.000Z",
          });
          yield* insertStartEvent({
            threadId: syntheticThreadId,
            messageId: `agent-auto-resume-message:${syntheticThreadId}:${syntheticTurnId}`,
            eventSuffix: "restart-agent-synthetic-later",
            streamVersion: 3,
            occurredAt: "2026-03-02T12:00:00.000Z",
          });

          yield* projectionPipeline.reconcileOrphanedInFlightWork;

          const obligations = yield* sql<{
            readonly threadId: string;
            readonly sourceTurnId: string;
            readonly kind: string;
          }>`
            SELECT
              thread_id AS "threadId",
              source_turn_id AS "sourceTurnId",
              kind
            FROM thread_work_obligations
            WHERE thread_id IN (${realThreadId}, ${syntheticThreadId})
            ORDER BY thread_id ASC
          `;
          assert.deepEqual(obligations, [
            {
              threadId: syntheticThreadId,
              sourceTurnId: syntheticTurnId,
              kind: "startup-resume",
            },
          ]);
        }),
    );

    // Observed 2026-08-28 on thread e526d4c2: Grok follow-ups during a live
    // turn emit thread.turn-start-requested and are then delivered into that
    // same turn. The restart scan treated those starts as later user intent
    // and skipped startup-resume, so the user had to press Resume by hand.
    it.effect(
      "enqueues a startup resume when later starts were delivered into the incomplete turn",
      () =>
        Effect.gen(function* () {
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const sql = yield* SqlClient.SqlClient;
          const threadId = "thread-queued-followup-resume";
          const turnId = "turn-queued-followup-resume";
          const sourceMessageId = "message-queued-followup-source";
          const followUpMessageId = "message-queued-followup-later";

          yield* seedThread({
            threadId,
            turnId,
            assistantMessageId: "assistant-queued-followup-resume",
            turnState: "incomplete",
            isStreaming: 0,
            sessionStatus: "stopped",
            activeTurnId: null,
            completedAt: "2026-08-28T16:45:23.000Z",
            assistantText: "Still placing the aisle board.",
            pendingMessageId: sourceMessageId,
          });

          const insertEvent = (input: {
            readonly eventId: string;
            readonly streamVersion: number;
            readonly eventType: string;
            readonly occurredAt: string;
            readonly payload: string;
          }) =>
            sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, causation_event_id, correlation_id,
              actor_kind, payload_json, metadata_json
            ) VALUES (
              ${input.eventId}, 'thread', ${threadId}, ${input.streamVersion},
              ${input.eventType}, ${input.occurredAt}, ${`cmd-${input.eventId}`},
              NULL, ${`cmd-${input.eventId}`}, 'client', ${input.payload}, '{}'
            )
          `;

          yield* insertEvent({
            eventId: "evt-queued-followup-source",
            streamVersion: 1,
            eventType: "thread.turn-start-requested",
            occurredAt: "2026-08-28T16:38:19.000Z",
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            payload: JSON.stringify({
              threadId,
              messageId: sourceMessageId,
              runtimeMode: "full-access",
              createdAt: "2026-08-28T16:38:19.000Z",
            }),
          });
          yield* insertEvent({
            eventId: "evt-queued-followup-later-start",
            streamVersion: 2,
            eventType: "thread.turn-start-requested",
            occurredAt: "2026-08-28T16:41:19.000Z",
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            payload: JSON.stringify({
              threadId,
              messageId: followUpMessageId,
              runtimeMode: "full-access",
              createdAt: "2026-08-28T16:41:19.000Z",
            }),
          });
          yield* insertEvent({
            eventId: "evt-queued-followup-delivered",
            streamVersion: 3,
            eventType: "thread.activity-appended",
            occurredAt: "2026-08-28T16:41:33.000Z",
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            payload: JSON.stringify({
              threadId,
              activity: {
                id: "activity-queued-followup-delivered",
                tone: "info",
                kind: "message.delivered",
                summary: "Message delivered to the provider",
                payload: { messageId: followUpMessageId },
                turnId,
                createdAt: "2026-08-28T16:41:33.000Z",
              },
            }),
          });

          yield* projectionPipeline.bootstrap;

          const obligations = yield* sql<{
            readonly sourceTurnId: string;
            readonly kind: string;
            readonly state: string;
          }>`
          SELECT source_turn_id AS "sourceTurnId", kind, state
          FROM thread_work_obligations WHERE thread_id = ${threadId}
        `;
          assert.deepEqual(obligations, [
            { sourceTurnId: turnId, kind: "startup-resume", state: "pending" },
          ]);
        }),
    );

    // Reported 2026-08-15 (thread ed9e1e19): an in-place app update killed the
    // CLI 68s into a turn, before it emitted a single assistant token. The
    // shutdown settled the turn as "completed" — not "incomplete"/"error" —
    // and recorded the failure alongside it as a `runtime.error`. The
    // continuation branch needs assistant text to continue from and the resume
    // branch only took incomplete/error, so the thread was skipped entirely and
    // sat on an unanswered user message with no obligation of any kind.
    it.effect("enqueues a resume for a turn killed before it produced any output", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = "thread-killed-before-output";
        const turnId = "turn-killed-before-output";

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, branch, worktree_path, latest_turn_id,
            created_at, updated_at, deleted_at, runtime_mode, interaction_mode,
            model_selection_json, latest_user_message_at,
            pending_approval_count, pending_user_input_count
          ) VALUES (
            ${threadId}, 'project-recovery', 'Recovery Thread', NULL, NULL, ${turnId},
            '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:05.000Z', NULL,
            'full-access', 'agent',
            '{"instanceId":"codex","model":"gpt-5.6-sol"}', '2026-03-02T10:00:01.000Z',
            0, 0
          )
        `;
        // No assistant row at all: the stream died before the first token.
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (
            ${threadId}, ${turnId}, NULL, NULL, 'completed',
            '2026-03-02T10:00:01.000Z', '2026-03-02T10:00:02.000Z',
            '2026-03-02T10:00:04.000Z', '[]'
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
          ) VALUES (
            'activity-runtime-error', ${threadId}, ${turnId}, 'error', 'runtime.error',
            'Runtime error', '{"message":"Claude runtime stream failed."}',
            '2026-03-02T10:00:04.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, provider_session_id, provider_thread_id,
            active_turn_id, last_error, updated_at, runtime_mode, provider_instance_id
          ) VALUES (
            ${threadId}, 'stopped', 'codex', NULL, NULL,
            NULL, 'Claude runtime stream failed.', '2026-03-02T10:00:04.000Z',
            'full-access', 'codex'
          )
        `;

        yield* projectionPipeline.bootstrap;

        const obligations = yield* sql<{
          readonly sourceTurnId: string;
          readonly kind: string;
          readonly state: string;
        }>`
          SELECT source_turn_id AS "sourceTurnId", kind, state
          FROM thread_work_obligations WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(obligations, [
          { sourceTurnId: turnId, kind: "startup-resume", state: "pending" },
        ]);
      }),
    );

    it.effect("recovers a completed whitespace-only failure but keeps real output terminal", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const emptyThreadId = "thread-killed-with-whitespace-output";
        const emptyTurnId = "turn-killed-with-whitespace-output";
        const attachmentThreadId = "thread-killed-with-attachment-output";
        const attachmentTurnId = "turn-killed-with-attachment-output";
        const toolThreadId = "thread-killed-with-tool-output";
        const toolTurnId = "turn-killed-with-tool-output";

        yield* seedThread({
          threadId: emptyThreadId,
          turnId: emptyTurnId,
          assistantMessageId: "assistant-killed-with-whitespace-output",
          turnState: "completed",
          isStreaming: 0,
          sessionStatus: "stopped",
          activeTurnId: null,
          completedAt: "2026-03-02T10:00:04.000Z",
          assistantText: " \n\t\r ",
        });
        yield* seedThread({
          threadId: attachmentThreadId,
          turnId: attachmentTurnId,
          assistantMessageId: "assistant-killed-with-attachment-output",
          turnState: "completed",
          isStreaming: 0,
          sessionStatus: "stopped",
          activeTurnId: null,
          completedAt: "2026-03-02T10:00:04.000Z",
          assistantText: "",
          assistantAttachmentsJson: '[{"type":"file","name":"proof.txt"}]',
        });
        yield* seedThread({
          threadId: toolThreadId,
          turnId: toolTurnId,
          assistantMessageId: "assistant-killed-with-tool-output",
          turnState: "completed",
          isStreaming: 0,
          sessionStatus: "stopped",
          activeTurnId: null,
          completedAt: "2026-03-02T10:00:04.000Z",
          assistantText: "",
        });
        yield* sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
            ) VALUES
              (
                'activity-whitespace-runtime-error', ${emptyThreadId}, ${emptyTurnId},
                'error', 'runtime.error', 'Runtime error', '{}',
                '2026-03-02T10:00:04.000Z'
              ),
              (
                'activity-attachment-runtime-error', ${attachmentThreadId}, ${attachmentTurnId},
                'error', 'runtime.error', 'Runtime error', '{}',
                '2026-03-02T10:00:04.000Z'
              ),
              (
                'activity-tool-runtime-error', ${toolThreadId}, ${toolTurnId},
                'error', 'runtime.error', 'Runtime error', '{}',
                '2026-03-02T10:00:04.000Z'
              ),
              (
                'activity-tool-output', ${toolThreadId}, ${toolTurnId},
                'info', 'tool.completed', 'Tool completed', '{}',
                '2026-03-02T10:00:03.000Z'
              )
          `;

        yield* projectionPipeline.bootstrap;

        const obligations = yield* sql<{
          readonly threadId: string;
          readonly kind: string;
          readonly state: string;
        }>`
            SELECT thread_id AS "threadId", kind, state
            FROM thread_work_obligations
            WHERE thread_id IN (${emptyThreadId}, ${attachmentThreadId}, ${toolThreadId})
            ORDER BY thread_id ASC
          `;
        assert.deepEqual(obligations, [
          { threadId: emptyThreadId, kind: "startup-resume", state: "pending" },
        ]);
      }),
    );

    // Reported 2026-08-15: an in-place update kills the CLI mid-turn, the
    // stream failure marks the session `error`, and the continuation the turn
    // settle had already enqueued was cancelled ~1s after boot with "source
    // turn is no longer continuable" — because the continuation gate treats
    // `error` as terminal. The process that owned that session is gone, so the
    // error cannot still be current.
    it.effect("clears a stale error session left by the dead process", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = "thread-stale-error-session";
        const turnId = "turn-stale-error-session";

        yield* seedThread({
          threadId,
          turnId,
          assistantMessageId: "assistant-stale-error-session",
          turnState: "completed",
          isStreaming: 0,
          sessionStatus: "error",
          activeTurnId: null,
          completedAt: "2026-03-02T10:00:04.000Z",
          assistantText: "Installing the new build now.",
        });
        yield* sql`
          UPDATE projection_thread_sessions
          SET last_error = 'Claude runtime stream failed.'
          WHERE thread_id = ${threadId}
        `;

        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const sessions = yield* sql<{
          readonly status: string;
          readonly lastError: string | null;
        }>`
          SELECT status, last_error AS "lastError"
          FROM projection_thread_sessions WHERE thread_id = ${threadId}
        `;
        assert.equal(sessions[0]?.status, "stopped");
        // Preserved: the recovery scan reads it to classify the thread.
        assert.equal(sessions[0]?.lastError, "Claude runtime stream failed.");
      }),
    );

    // Authentication replay is an Agent-mode contract. Default and Plan stay
    // manual after restart just as they do on the live projection path.
    it.effect("keeps authentication restart recovery Agent-only", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const scenarios = ["agent", "default", "plan"] as const;

        for (const interactionMode of scenarios) {
          const threadId = `thread-auth-error-${interactionMode}`;
          yield* seedThread({
            threadId,
            turnId: `turn-auth-error-${interactionMode}`,
            assistantMessageId: `assistant-auth-error-${interactionMode}`,
            turnState: "completed",
            isStreaming: 0,
            sessionStatus: "error",
            activeTurnId: null,
            completedAt: "2026-03-02T10:00:04.000Z",
            assistantText: "Working on it.",
            interactionMode,
          });
          yield* sql`
            UPDATE projection_thread_sessions
            SET last_error = 'Failed to authenticate: OAuth session expired and could not be refreshed'
            WHERE thread_id = ${threadId}
          `;
        }

        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        const sessions = yield* sql<{ readonly threadId: string; readonly status: string }>`
          SELECT thread_id AS "threadId", status
          FROM projection_thread_sessions
          WHERE thread_id LIKE 'thread-auth-error-%'
          ORDER BY thread_id ASC
        `;
        assert.deepEqual(sessions, [
          { threadId: "thread-auth-error-agent", status: "error" },
          { threadId: "thread-auth-error-default", status: "error" },
          { threadId: "thread-auth-error-plan", status: "error" },
        ]);

        const obligations = yield* sql<{
          readonly threadId: string;
          readonly kind: string;
          readonly state: string;
        }>`
          SELECT thread_id AS "threadId", kind, state
          FROM thread_work_obligations
          WHERE thread_id LIKE 'thread-auth-error-%'
          ORDER BY thread_id ASC
        `;
        assert.deepEqual(obligations, [
          {
            threadId: "thread-auth-error-agent",
            kind: "authentication-resume",
            state: "blocked-authentication",
          },
        ]);
      }),
    );

    // The same shape without a recorded failure is an ordinary empty turn, not
    // a casualty, and must stay untouched — otherwise every quiet turn in the
    // database would resume itself on the next boot.
    it.effect("leaves an output-free turn alone when nothing recorded a failure", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = "thread-quiet-completed";
        const turnId = "turn-quiet-completed";

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, branch, worktree_path, latest_turn_id,
            created_at, updated_at, deleted_at, runtime_mode, interaction_mode,
            model_selection_json, latest_user_message_at,
            pending_approval_count, pending_user_input_count
          ) VALUES (
            ${threadId}, 'project-recovery', 'Recovery Thread', NULL, NULL, ${turnId},
            '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:05.000Z', NULL,
            'full-access', 'agent',
            '{"instanceId":"codex","model":"gpt-5.6-sol"}', '2026-03-02T10:00:01.000Z',
            0, 0
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (
            ${threadId}, ${turnId}, NULL, NULL, 'completed',
            '2026-03-02T10:00:01.000Z', '2026-03-02T10:00:02.000Z',
            '2026-03-02T10:00:04.000Z', '[]'
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, provider_session_id, provider_thread_id,
            active_turn_id, last_error, updated_at, runtime_mode, provider_instance_id
          ) VALUES (
            ${threadId}, 'ready', 'codex', NULL, NULL,
            NULL, NULL, '2026-03-02T10:00:04.000Z', 'full-access', 'codex'
          )
        `;

        yield* projectionPipeline.bootstrap;

        const obligations = yield* sql<{ readonly kind: string }>`
          SELECT kind FROM thread_work_obligations WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(obligations, []);
      }),
    );

    // A turn that backgrounds work and signs off to wait ends perfectly
    // normally, in any mode. Its wake comes from the provider harness
    // re-invoking the agent when the task exits — an owner that dies with the
    // process, leaving the thread parked on "I'll report back" forever
    // (reported 2026-08-12, a default-mode thread waiting on Unity test runs).
    const seedTaskWaitThread = (input: {
      readonly threadId: string;
      readonly turnId: string;
      readonly assistantText: string;
      readonly taskActivities: ReadonlyArray<{
        readonly kind: string;
        readonly createdAt: string;
        readonly status?: string;
      }>;
    }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const assistantMessageId = `assistant-${input.threadId}`;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, branch, worktree_path, latest_turn_id,
            created_at, updated_at, deleted_at, runtime_mode, interaction_mode,
            model_selection_json, latest_user_message_at,
            pending_approval_count, pending_user_input_count
          ) VALUES (
            ${input.threadId}, 'project-task-wait', 'Task Wait Thread', NULL, NULL, ${input.turnId},
            '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:05.000Z', NULL,
            'full-access', 'default',
            '{"instanceId":"codex","model":"gpt-5.6-sol"}', '2026-03-02T10:00:01.000Z',
            0, 0
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (
            ${assistantMessageId}, ${input.threadId}, ${input.turnId}, 'assistant',
            ${input.assistantText}, 0, '2026-03-02T10:00:03.000Z', '2026-03-02T10:00:03.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_files_json
          ) VALUES (
            ${input.threadId}, ${input.turnId}, NULL, ${assistantMessageId}, 'completed',
            '2026-03-02T10:00:01.000Z', '2026-03-02T10:00:02.000Z',
            '2026-03-02T10:00:10.000Z', '[]'
          )
        `;
        let index = 0;
        for (const activity of input.taskActivities) {
          index += 1;
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          const payload = JSON.stringify({
            taskId: "bash-1",
            taskType: "local_bash",
            ...(activity.status === undefined ? {} : { status: activity.status }),
          });
          yield* sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
              created_at, sequence
            ) VALUES (
              ${`${input.threadId}-activity-${index}`}, ${input.threadId}, NULL, 'info',
              ${activity.kind}, 'task', ${payload}, ${activity.createdAt}, ${index}
            )
          `;
        }
      });

    const obligationsFor = (threadId: string) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly kind: string; readonly state: string }>`
          SELECT kind, state FROM thread_work_obligations WHERE thread_id = ${threadId}
        `;
      });

    it.effect("enqueues a resume when a background task died with the process", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const threadId = "thread-task-killed";

        yield* seedTaskWaitThread({
          threadId,
          turnId: "turn-task-killed",
          assistantText: "I'll report both results as soon as they land.",
          taskActivities: [
            { kind: "task.started", createdAt: "2026-03-02T10:00:05.000Z" },
            // The provider reports its tasks stopped on the way out, after the
            // turn had already settled.
            { kind: "task.completed", createdAt: "2026-03-02T10:00:20.000Z", status: "stopped" },
          ],
        });

        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        assert.deepEqual(yield* obligationsFor(threadId), [
          { kind: "startup-resume", state: "pending" },
        ]);
      }),
    );

    it.effect("leaves a completed turn alone when its background task finished", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const threadId = "thread-task-finished";

        yield* seedTaskWaitThread({
          threadId,
          turnId: "turn-task-finished",
          assistantText: "Both runs came back clean.",
          taskActivities: [
            { kind: "task.started", createdAt: "2026-03-02T10:00:05.000Z" },
            { kind: "task.completed", createdAt: "2026-03-02T10:00:08.000Z", status: "completed" },
          ],
        });

        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        assert.deepEqual(yield* obligationsFor(threadId), []);
      }),
    );

    it.effect("honors AGENT_STOP over a killed background task", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const threadId = "thread-task-signed-off";

        yield* seedTaskWaitThread({
          threadId,
          turnId: "turn-task-signed-off",
          assistantText: "Done, and I am not waiting on the run.\n\nAGENT_STOP",
          taskActivities: [
            { kind: "task.started", createdAt: "2026-03-02T10:00:05.000Z" },
            { kind: "task.completed", createdAt: "2026-03-02T10:00:20.000Z", status: "stopped" },
          ],
        });

        yield* projectionPipeline.reconcileOrphanedInFlightWork;

        assert.deepEqual(yield* obligationsFor(threadId), []);
      }),
    );
  },
);

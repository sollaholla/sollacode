import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";

const threadId = ThreadId.make("thread-history-test");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-history-test"),
  threadId,
  providerSessionId: "provider-session-history-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["history"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "history-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const TestLayer = McpHttpServer.ThreadHistoryToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const seedHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
      settled_override, settled_at, snoozed_until, snoozed_at, latest_user_message_at,
      pending_approval_count, pending_user_input_count, has_actionable_proposed_plan, deleted_at
    ) VALUES (
      ${threadId}, 'project-history-test', 'History test thread',
      '{"instanceId":"codex","model":"gpt-5.6-sol"}', 'full-access', 'default',
      NULL, NULL, 'turn-3', '2026-07-31T10:00:00.000Z', '2026-07-31T10:04:00.000Z', NULL,
      NULL, NULL, NULL, NULL, '2026-07-31T10:03:00.000Z', 0, 0, 0, NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_sessions (
      thread_id, status, provider_name, provider_session_id, provider_thread_id,
      runtime_mode, active_turn_id, last_error, provider_instance_id, updated_at
    ) VALUES (
      ${threadId}, 'running', 'Codex', NULL, NULL, 'full-access', 'turn-3', NULL, 'codex',
      '2026-07-31T10:04:00.000Z'
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, input_origin, attachments_json,
      is_streaming, created_at, updated_at
    ) VALUES
      ('message-1', ${threadId}, 'turn-1', 'user', 'Fix the scroll anchoring bug', NULL, NULL, 0,
        '2026-07-31T10:01:00.000Z', '2026-07-31T10:01:00.000Z'),
      ('message-2', ${threadId}, 'turn-1', 'assistant', 'Implemented the scroll fix and verified it', NULL, NULL, 0,
        '2026-07-31T10:02:00.000Z', '2026-07-31T10:02:00.000Z'),
      ('message-3', ${threadId}, 'turn-3', 'user', 'Now add advanced thread history lookup', NULL, NULL, 0,
        '2026-07-31T10:03:00.000Z', '2026-07-31T10:03:00.000Z'),
      ('message-4', ${threadId}, 'turn-3', 'assistant', 'Still streaming and should be excluded', NULL, NULL, 1,
        '2026-07-31T10:04:00.000Z', '2026-07-31T10:04:00.000Z')
  `;
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    ) VALUES (
      'activity-1', ${threadId}, 'turn-1', 'tool', 'command.completed',
      'Ran focused tests successfully', '{"command":"vp test"}', 1,
      '2026-07-31T10:02:30.000Z'
    )
  `;
  yield* sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
      source_proposed_plan_id, assistant_message_id, state, requested_at, started_at,
      completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
      checkpoint_files_json
    ) VALUES (
      ${threadId}, 'turn-3', 'message-3', NULL, NULL, 'message-4', 'running',
      '2026-07-31T10:03:00.000Z', '2026-07-31T10:03:01.000Z', NULL,
      NULL, NULL, NULL, '[]'
    )
  `;
});

const callHistory = (arguments_: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "thread_history_query", arguments: arguments_ })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("registers the history query as a read-only idempotent MCP tool", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tool = server.tools.find(({ tool }) => tool.name === "thread_history_query");
    expect(tool?.tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool?.tool._meta).toMatchObject({ "anthropic/alwaysLoad": true });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("queries scoped history with resume context and stable cursor pagination", () =>
  Effect.gen(function* () {
    yield* seedHistory;
    const first = yield* callHistory({ pageSize: 2 });
    expect(first.isError).toBe(false);
    expect(first.content[0]).toMatchObject({ type: "text" });
    expect(first.structuredContent).toMatchObject({
      resolvedThreadIdFromInvocation: true,
      thread: {
        threadId,
        title: "History test thread",
        session: { status: "running", activeTurnId: "turn-3" },
      },
      entries: [
        { entryType: "message", id: "message-3", role: "user" },
        { entryType: "activity", id: "activity-1", activityKind: "command.completed" },
      ],
      resumeContext: {
        latestUserMessage: { id: "message-3" },
        latestAssistantMessage: { id: "message-2" },
        latestActivity: { id: "activity-1" },
        activeTurn: { turnId: "turn-3", state: "running" },
      },
      pagination: { returned: 2, hasMore: true, scanLimitReached: false },
    });

    const firstStructured = first.structuredContent as {
      readonly pagination: { readonly nextCursor: string };
    };
    const second = yield* callHistory({
      pageSize: 2,
      cursor: firstStructured.pagination.nextCursor,
    });
    expect(second.isError).toBe(false);
    expect(second.structuredContent).toMatchObject({
      entries: [
        { entryType: "message", id: "message-2", role: "assistant" },
        { entryType: "message", id: "message-1", role: "user" },
      ],
      pagination: { returned: 2, hasMore: false, nextCursor: null },
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("supports bounded regex, role, source, and payload controls", () =>
  Effect.gen(function* () {
    yield* seedHistory;
    const result = yield* callHistory({
      query: "scroll\\s+anchor",
      matchMode: "regex",
      regexFlags: "i",
      sources: ["messages"],
      roles: ["user"],
      includePayload: true,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      entries: [{ entryType: "message", id: "message-1", role: "user" }],
      pagination: { returned: 1, scanned: 2, hasMore: false },
      query: { matchMode: "regex", regexFlags: "i", sources: ["messages"], roles: ["user"] },
    });

    const activity = yield* callHistory({
      query: "focused tests",
      sources: ["activities"],
      includePayload: true,
    });
    expect(activity.structuredContent).toMatchObject({
      entries: [
        {
          entryType: "activity",
          id: "activity-1",
          payload: { command: "vp test" },
          payloadTruncated: false,
        },
      ],
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps cursor pagination stable when entry timestamps are identical", () =>
  Effect.gen(function* () {
    yield* seedHistory;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, input_origin, attachments_json,
        is_streaming, created_at, updated_at
      ) VALUES
        ('message-tie-a', ${threadId}, 'turn-3', 'assistant', 'First tied message', NULL, NULL, 0,
          '2026-07-31T10:05:00.000Z', '2026-07-31T10:05:00.000Z'),
        ('message-tie-b', ${threadId}, 'turn-3', 'assistant', 'Second tied message', NULL, NULL, 0,
          '2026-07-31T10:05:00.000Z', '2026-07-31T10:05:00.000Z')
    `;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      ) VALUES (
        'activity-tie', ${threadId}, 'turn-3', 'tool', 'command.completed',
        'Tied activity', '{}', 2, '2026-07-31T10:05:00.000Z'
      )
    `;

    const ids: Array<string> = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const page = yield* callHistory({
        since: "2026-07-31T10:05:00.000Z",
        order: "asc",
        pageSize: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const result = page.structuredContent as {
        readonly entries: ReadonlyArray<{ readonly id: string }>;
        readonly pagination: { readonly nextCursor: string | null };
      };
      ids.push(result.entries[0]!.id);
      cursor = result.pagination.nextCursor ?? undefined;
    }

    expect(ids).toEqual(["message-tie-a", "message-tie-b", "activity-tie"]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects cross-thread access and cursors reused with changed filters", () =>
  Effect.gen(function* () {
    yield* seedHistory;
    const denied = yield* callHistory({ threadId: "thread-other" });
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([
      {
        type: "text",
        text: "The requested thread is outside this agent's MCP credential scope.",
      },
    ]);

    const first = yield* callHistory({ pageSize: 1 });
    const cursor = (
      first.structuredContent as { readonly pagination: { readonly nextCursor: string } }
    ).pagination.nextCursor;
    const invalidCursor = yield* callHistory({ pageSize: 1, cursor, roles: ["user"] });
    expect(invalidCursor.isError).toBe(true);
    expect(invalidCursor.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Invalid thread-history cursor"),
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("returns bounded errors for invalid regular expressions", () =>
  Effect.gen(function* () {
    yield* seedHistory;
    const invalidRegex = yield* callHistory({ query: "[", matchMode: "regex" });
    expect(invalidRegex.isError).toBe(true);
    expect(invalidRegex.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Invalid thread-history regular expression"),
    });
  }).pipe(Effect.provide(TestLayer)),
);

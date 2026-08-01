// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - A hard timeout must terminate pathological regex workers.
import * as NodeCrypto from "node:crypto";
import * as NodeTimers from "node:timers";
import * as NodeWorkerThreads from "node:worker_threads";

import {
  OrchestrationSessionStatus,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type IsoDateTime,
  type OrchestrationMessageRole,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  ThreadHistoryInvalidCursorError,
  ThreadHistoryInvalidRegexError,
  ThreadHistoryQueryFailedError,
  ThreadHistoryRegexTimeoutError,
  ThreadHistoryThreadNotFoundError,
  type ThreadHistoryActivityEntry,
  type ThreadHistoryEntry,
  type ThreadHistoryLatestActivity,
  type ThreadHistoryLatestMessage,
  type ThreadHistoryMessageEntry,
  type ThreadHistoryQueryResult,
  type ThreadHistorySource,
} from "./types.ts";

const DEFAULT_PAGE_SIZE = 40;
const DEFAULT_MAX_TEXT_CHARS = 12_000;
const DEFAULT_MAX_PAYLOAD_CHARS = 8_000;
const DEFAULT_MAX_SCAN_RECORDS = 2_500;
const REGEX_PATTERN_MAX_CHARS = 512;
const REGEX_BATCH_SIZE = 250;
const REGEX_BATCH_TIMEOUT_MS = 750;

export interface ThreadHistoryQueryRequest {
  readonly threadId: ThreadId;
  readonly resolvedThreadIdFromInvocation: boolean;
  readonly query?: string | undefined;
  readonly matchMode?: "literal" | "regex" | undefined;
  readonly regexFlags?: string | undefined;
  readonly caseSensitive?: boolean | undefined;
  readonly sources?: ReadonlyArray<ThreadHistorySource> | undefined;
  readonly roles?: ReadonlyArray<OrchestrationMessageRole> | undefined;
  readonly activityKinds?: ReadonlyArray<string> | undefined;
  readonly turnIds?: ReadonlyArray<TurnId> | undefined;
  readonly since?: IsoDateTime | undefined;
  readonly until?: IsoDateTime | undefined;
  readonly order?: "asc" | "desc" | undefined;
  readonly pageSize?: number | undefined;
  readonly cursor?: string | undefined;
  readonly includeAttachments?: boolean | undefined;
  readonly includePayload?: boolean | undefined;
  readonly includeStreaming?: boolean | undefined;
  readonly maxTextChars?: number | undefined;
  readonly maxPayloadChars?: number | undefined;
  readonly maxScanRecords?: number | undefined;
}

interface NormalizedQuery {
  readonly threadId: ThreadId;
  readonly resolvedThreadIdFromInvocation: boolean;
  readonly query: string | null;
  readonly matchMode: "literal" | "regex";
  readonly regexFlags: string | null;
  readonly caseSensitive: boolean;
  readonly sources: ReadonlyArray<ThreadHistorySource>;
  readonly roles: ReadonlyArray<OrchestrationMessageRole>;
  readonly activityKinds: ReadonlyArray<string>;
  readonly turnIds: ReadonlyArray<TurnId>;
  readonly since: IsoDateTime | null;
  readonly until: IsoDateTime | null;
  readonly order: "asc" | "desc";
  readonly pageSize: number;
  readonly includeAttachments: boolean;
  readonly includePayload: boolean;
  readonly includeStreaming: boolean;
  readonly maxTextChars: number;
  readonly maxPayloadChars: number;
  readonly maxScanRecords: number;
}

const RawHistoryRow = Schema.Struct({
  entryType: Schema.Literals(["message", "activity"]),
  sortRank: Schema.Number,
  id: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
  activityKind: Schema.NullOr(Schema.String),
  tone: Schema.NullOr(Schema.String),
  text: Schema.String,
  attachmentsJson: Schema.NullOr(Schema.String),
  payloadJson: Schema.NullOr(Schema.String),
  isStreaming: Schema.NullOr(Schema.Number),
  sequence: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type RawHistoryRow = typeof RawHistoryRow.Type;

const QueryPageRequest = Schema.Struct({
  threadId: Schema.String,
  includeMessages: Schema.Number,
  includeActivities: Schema.Number,
  rolesJson: Schema.String,
  activityKindsJson: Schema.String,
  turnIdsJson: Schema.String,
  since: Schema.NullOr(Schema.String),
  until: Schema.NullOr(Schema.String),
  includeAttachments: Schema.Number,
  includePayload: Schema.Number,
  includeStreaming: Schema.Number,
  literalQuery: Schema.NullOr(Schema.String),
  caseSensitive: Schema.Number,
  cursorAt: Schema.NullOr(Schema.String),
  cursorRank: Schema.NullOr(Schema.Number),
  cursorId: Schema.NullOr(Schema.String),
  limit: Schema.Number,
});
type QueryPageRequest = typeof QueryPageRequest.Type;

const ThreadStateRow = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  modelSelectionJson: Schema.String,
  runtimeMode: Schema.String,
  interactionMode: Schema.String,
  updatedAt: Schema.String,
  sessionStatus: Schema.NullOr(Schema.String),
  providerName: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  activeTurnId: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  sessionUpdatedAt: Schema.NullOr(Schema.String),
});

const LatestMessageRow = Schema.Struct({
  id: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  role: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
});

const LatestActivityRow = Schema.Struct({
  id: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  activityKind: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
});

const ActiveTurnRow = Schema.Struct({
  turnId: Schema.NullOr(Schema.String),
  state: Schema.Literals(["pending", "running"]),
  requestedAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
});

const HistoryCursor = Schema.Struct({
  version: Schema.Literal(1),
  fingerprint: Schema.String,
  createdAt: Schema.String,
  sortRank: Schema.Literals([0, 1]),
  id: Schema.String,
});
type HistoryCursor = typeof HistoryCursor.Type;
const HistoryCursorJson = Schema.fromJsonString(HistoryCursor);
const encodeHistoryCursorJson = Schema.encodeSync(HistoryCursorJson);
const decodeHistoryCursorJson = Schema.decodeUnknownSync(HistoryCursorJson);
const decodeUnknownJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const isThreadHistoryInvalidRegexError = Schema.is(ThreadHistoryInvalidRegexError);
const isThreadHistoryRegexTimeoutError = Schema.is(ThreadHistoryRegexTimeoutError);

function fingerprintQuery(query: NormalizedQuery): string {
  const serialized = JSON.stringify({
    threadId: query.threadId,
    query: query.query,
    matchMode: query.matchMode,
    regexFlags: query.regexFlags,
    caseSensitive: query.caseSensitive,
    sources: query.sources,
    roles: query.roles,
    activityKinds: query.activityKinds,
    turnIds: query.turnIds,
    since: query.since,
    until: query.until,
    order: query.order,
    includeStreaming: query.includeStreaming,
  });
  return NodeCrypto.createHash("sha256").update(serialized).digest("base64url").slice(0, 24);
}

function cursorFromRow(row: RawHistoryRow, fingerprint: string): HistoryCursor {
  return {
    version: 1,
    fingerprint,
    createdAt: row.createdAt,
    sortRank: row.sortRank === 0 ? 0 : 1,
    id: row.id,
  };
}

function encodeCursorValue(cursor: HistoryCursor): string {
  return Buffer.from(encodeHistoryCursorJson(cursor)).toString("base64url");
}

function encodeCursor(row: RawHistoryRow, fingerprint: string): string {
  return encodeCursorValue(cursorFromRow(row, fingerprint));
}

function decodeCursor(
  encoded: string | undefined,
  fingerprint: string,
): Effect.Effect<HistoryCursor | null, ThreadHistoryInvalidCursorError> {
  if (!encoded) return Effect.succeed(null);
  return Effect.try({
    try: () => {
      const parsed = decodeHistoryCursorJson(Buffer.from(encoded, "base64url").toString("utf8"));
      if (parsed.fingerprint !== fingerprint || parsed.id.length === 0) {
        throw new Error("cursor does not match this query");
      }
      return parsed;
    },
    catch: (cause) =>
      new ThreadHistoryInvalidCursorError({
        detail: cause instanceof Error ? cause.message : "cursor could not be decoded",
      }),
  });
}

function unique<T>(values: ReadonlyArray<T> | undefined): ReadonlyArray<T> {
  return values === undefined ? [] : Array.from(new Set(values));
}

function normalizeRequest(
  request: ThreadHistoryQueryRequest,
): Effect.Effect<NormalizedQuery, ThreadHistoryInvalidRegexError> {
  const queryText =
    request.query === undefined || request.query.length === 0 ? null : request.query;
  const matchMode = request.matchMode ?? "literal";
  let regexFlags: string | null = null;
  if (matchMode === "regex" && queryText !== null) {
    regexFlags = request.regexFlags ?? "i";
    if (queryText.length > REGEX_PATTERN_MAX_CHARS) {
      return Effect.fail(
        new ThreadHistoryInvalidRegexError({
          detail: `pattern exceeds ${REGEX_PATTERN_MAX_CHARS} characters`,
        }),
      );
    }
    if (new Set(regexFlags).size !== regexFlags.length) {
      return Effect.fail(
        new ThreadHistoryInvalidRegexError({ detail: "regex flags must not repeat" }),
      );
    }
    try {
      void new RegExp(queryText, regexFlags);
    } catch (cause) {
      return Effect.fail(
        new ThreadHistoryInvalidRegexError({
          detail: cause instanceof Error ? cause.message : "pattern could not be compiled",
        }),
      );
    }
  }

  return Effect.succeed({
    threadId: request.threadId,
    resolvedThreadIdFromInvocation: request.resolvedThreadIdFromInvocation,
    query: queryText,
    matchMode,
    regexFlags,
    caseSensitive: request.caseSensitive ?? false,
    sources:
      request.sources === undefined || request.sources.length === 0
        ? ["messages", "activities"]
        : unique(request.sources),
    roles: unique(request.roles),
    activityKinds: unique(request.activityKinds),
    turnIds: unique(request.turnIds),
    since: request.since ?? null,
    until: request.until ?? null,
    order: request.order ?? "desc",
    pageSize: request.pageSize ?? DEFAULT_PAGE_SIZE,
    includeAttachments: request.includeAttachments ?? true,
    includePayload: request.includePayload ?? false,
    includeStreaming: request.includeStreaming ?? false,
    maxTextChars: request.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    maxPayloadChars: request.maxPayloadChars ?? DEFAULT_MAX_PAYLOAD_CHARS,
    maxScanRecords: request.maxScanRecords ?? DEFAULT_MAX_SCAN_RECORDS,
  });
}

function truncateText(text: string, maxChars: number) {
  return text.length <= maxChars
    ? { text, textChars: text.length, textTruncated: false }
    : { text: text.slice(0, maxChars), textChars: text.length, textTruncated: true };
}

function parseAttachments(json: string | null): ReadonlyArray<ChatAttachment> | undefined {
  if (json === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ReadonlyArray<ChatAttachment>) : undefined;
  } catch {
    return undefined;
  }
}

function toHistoryEntry(row: RawHistoryRow, query: NormalizedQuery): ThreadHistoryEntry {
  const text = truncateText(row.text, query.maxTextChars);
  if (row.entryType === "message") {
    return {
      entryType: "message",
      id: row.id,
      turnId: row.turnId === null ? null : TurnId.make(row.turnId),
      role: row.role as OrchestrationMessageRole,
      ...text,
      isStreaming: row.isStreaming === 1,
      createdAt: row.createdAt as IsoDateTime,
      updatedAt: row.updatedAt as IsoDateTime,
      ...(query.includeAttachments
        ? { attachments: parseAttachments(row.attachmentsJson) ?? [] }
        : {}),
    } satisfies ThreadHistoryMessageEntry;
  }

  const base = {
    entryType: "activity" as const,
    id: row.id,
    turnId: row.turnId === null ? null : TurnId.make(row.turnId),
    ...text,
    activityKind: row.activityKind ?? "unknown",
    tone: (row.tone ?? "neutral") as ThreadHistoryActivityEntry["tone"],
    sequence: row.sequence,
    createdAt: row.createdAt as IsoDateTime,
  };
  if (!query.includePayload || row.payloadJson === null) return base;
  if (row.payloadJson.length > query.maxPayloadChars) {
    return {
      ...base,
      payloadExcerpt: row.payloadJson.slice(0, query.maxPayloadChars),
      payloadTruncated: true,
    };
  }
  try {
    return { ...base, payload: JSON.parse(row.payloadJson), payloadTruncated: false };
  } catch {
    return { ...base, payloadExcerpt: row.payloadJson, payloadTruncated: false };
  }
}

const REGEX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
try {
  const expression = new RegExp(workerData.pattern, workerData.flags);
  const matches = [];
  for (let index = 0; index < workerData.texts.length; index += 1) {
    if (expression.test(workerData.texts[index])) matches.push(index);
  }
  parentPort.postMessage({ ok: true, matches });
} catch (cause) {
  parentPort.postMessage({
    ok: false,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}
`;

type RegexWorkerResult =
  | { readonly ok: true; readonly matches: ReadonlyArray<number> }
  | { readonly ok: false; readonly message: string };

function matchRegexBatch(
  pattern: string,
  flags: string,
  rows: ReadonlyArray<RawHistoryRow>,
): Effect.Effect<
  ReadonlySet<number>,
  ThreadHistoryInvalidRegexError | ThreadHistoryRegexTimeoutError
> {
  return Effect.tryPromise({
    try: () =>
      new Promise<ReadonlySet<number>>((resolve, reject) => {
        const worker = new NodeWorkerThreads.Worker(REGEX_WORKER_SOURCE, {
          eval: true,
          workerData: { pattern, flags, texts: rows.map((row) => row.text) },
        });
        let settled = false;
        const timeout = NodeTimers.setTimeout(() => {
          if (settled) return;
          settled = true;
          void worker.terminate();
          reject(new ThreadHistoryRegexTimeoutError({ timeoutMs: REGEX_BATCH_TIMEOUT_MS }));
        }, REGEX_BATCH_TIMEOUT_MS);
        const finish = (effect: () => void) => {
          if (settled) return;
          settled = true;
          NodeTimers.clearTimeout(timeout);
          void worker.terminate();
          effect();
        };
        worker.once("message", (result: RegexWorkerResult) => {
          finish(() =>
            result.ok
              ? resolve(new Set(result.matches))
              : reject(new ThreadHistoryInvalidRegexError({ detail: result.message })),
          );
        });
        worker.once("error", (cause) => finish(() => reject(cause)));
        worker.once("exit", (code) => {
          if (settled || code === 0) return;
          finish(() => reject(new Error(`regex worker exited with code ${code}`)));
        });
      }),
    catch: (cause) =>
      isThreadHistoryInvalidRegexError(cause) || isThreadHistoryRegexTimeoutError(cause)
        ? cause
        : new ThreadHistoryInvalidRegexError({
            detail: cause instanceof Error ? cause.message : "regex worker failed",
          }),
  });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const queryPageAsc = SqlSchema.findAll({
    Request: QueryPageRequest,
    Result: RawHistoryRow,
    execute: (request) => sql`
      WITH history AS (
        SELECT
          'message' AS "entryType", 0 AS "sortRank", message_id AS id,
          turn_id AS "turnId", role, NULL AS "activityKind", NULL AS tone,
          text, CASE WHEN ${request.includeAttachments} = 1 THEN attachments_json ELSE NULL END AS "attachmentsJson",
          NULL AS "payloadJson", is_streaming AS "isStreaming", NULL AS sequence,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${request.threadId}
          AND ${request.includeMessages} = 1
          AND (${request.includeStreaming} = 1 OR is_streaming = 0)
          AND (json_array_length(${request.rolesJson}) = 0 OR role IN (SELECT value FROM json_each(${request.rolesJson})))
          AND (json_array_length(${request.turnIdsJson}) = 0 OR turn_id IN (SELECT value FROM json_each(${request.turnIdsJson})))
          AND (${request.since} IS NULL OR created_at >= ${request.since})
          AND (${request.until} IS NULL OR created_at <= ${request.until})
          AND (
            ${request.literalQuery} IS NULL
            OR (${request.caseSensitive} = 1 AND instr(text, ${request.literalQuery}) > 0)
            OR (${request.caseSensitive} = 0 AND instr(lower(text), lower(${request.literalQuery})) > 0)
          )
          AND (
            ${request.cursorAt} IS NULL
            OR created_at > ${request.cursorAt}
            OR (created_at = ${request.cursorAt} AND 0 > ${request.cursorRank})
            OR (created_at = ${request.cursorAt} AND 0 = ${request.cursorRank} AND message_id > ${request.cursorId})
          )
        UNION ALL
        SELECT
          'activity' AS "entryType", 1 AS "sortRank", activity_id AS id,
          turn_id AS "turnId", NULL AS role, kind AS "activityKind", tone,
          summary AS text, NULL AS "attachmentsJson",
          CASE WHEN ${request.includePayload} = 1 THEN payload_json ELSE NULL END AS "payloadJson",
          NULL AS "isStreaming", sequence,
          created_at AS "createdAt", created_at AS "updatedAt"
        FROM projection_thread_activities
        WHERE thread_id = ${request.threadId}
          AND ${request.includeActivities} = 1
          AND (json_array_length(${request.activityKindsJson}) = 0 OR kind IN (SELECT value FROM json_each(${request.activityKindsJson})))
          AND (json_array_length(${request.turnIdsJson}) = 0 OR turn_id IN (SELECT value FROM json_each(${request.turnIdsJson})))
          AND (${request.since} IS NULL OR created_at >= ${request.since})
          AND (${request.until} IS NULL OR created_at <= ${request.until})
          AND (
            ${request.literalQuery} IS NULL
            OR (${request.caseSensitive} = 1 AND instr(summary, ${request.literalQuery}) > 0)
            OR (${request.caseSensitive} = 0 AND instr(lower(summary), lower(${request.literalQuery})) > 0)
          )
          AND (
            ${request.cursorAt} IS NULL
            OR created_at > ${request.cursorAt}
            OR (created_at = ${request.cursorAt} AND 1 > ${request.cursorRank})
            OR (created_at = ${request.cursorAt} AND 1 = ${request.cursorRank} AND activity_id > ${request.cursorId})
          )
      )
      SELECT * FROM history
      ORDER BY "createdAt" ASC, "sortRank" ASC, id ASC
      LIMIT ${request.limit}
    `,
  });

  const queryPageDesc = SqlSchema.findAll({
    Request: QueryPageRequest,
    Result: RawHistoryRow,
    execute: (request) => sql`
      WITH history AS (
        SELECT
          'message' AS "entryType", 0 AS "sortRank", message_id AS id,
          turn_id AS "turnId", role, NULL AS "activityKind", NULL AS tone,
          text, CASE WHEN ${request.includeAttachments} = 1 THEN attachments_json ELSE NULL END AS "attachmentsJson",
          NULL AS "payloadJson", is_streaming AS "isStreaming", NULL AS sequence,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${request.threadId}
          AND ${request.includeMessages} = 1
          AND (${request.includeStreaming} = 1 OR is_streaming = 0)
          AND (json_array_length(${request.rolesJson}) = 0 OR role IN (SELECT value FROM json_each(${request.rolesJson})))
          AND (json_array_length(${request.turnIdsJson}) = 0 OR turn_id IN (SELECT value FROM json_each(${request.turnIdsJson})))
          AND (${request.since} IS NULL OR created_at >= ${request.since})
          AND (${request.until} IS NULL OR created_at <= ${request.until})
          AND (
            ${request.literalQuery} IS NULL
            OR (${request.caseSensitive} = 1 AND instr(text, ${request.literalQuery}) > 0)
            OR (${request.caseSensitive} = 0 AND instr(lower(text), lower(${request.literalQuery})) > 0)
          )
          AND (
            ${request.cursorAt} IS NULL
            OR created_at < ${request.cursorAt}
            OR (created_at = ${request.cursorAt} AND 0 < ${request.cursorRank})
            OR (created_at = ${request.cursorAt} AND 0 = ${request.cursorRank} AND message_id < ${request.cursorId})
          )
        UNION ALL
        SELECT
          'activity' AS "entryType", 1 AS "sortRank", activity_id AS id,
          turn_id AS "turnId", NULL AS role, kind AS "activityKind", tone,
          summary AS text, NULL AS "attachmentsJson",
          CASE WHEN ${request.includePayload} = 1 THEN payload_json ELSE NULL END AS "payloadJson",
          NULL AS "isStreaming", sequence,
          created_at AS "createdAt", created_at AS "updatedAt"
        FROM projection_thread_activities
        WHERE thread_id = ${request.threadId}
          AND ${request.includeActivities} = 1
          AND (json_array_length(${request.activityKindsJson}) = 0 OR kind IN (SELECT value FROM json_each(${request.activityKindsJson})))
          AND (json_array_length(${request.turnIdsJson}) = 0 OR turn_id IN (SELECT value FROM json_each(${request.turnIdsJson})))
          AND (${request.since} IS NULL OR created_at >= ${request.since})
          AND (${request.until} IS NULL OR created_at <= ${request.until})
          AND (
            ${request.literalQuery} IS NULL
            OR (${request.caseSensitive} = 1 AND instr(summary, ${request.literalQuery}) > 0)
            OR (${request.caseSensitive} = 0 AND instr(lower(summary), lower(${request.literalQuery})) > 0)
          )
          AND (
            ${request.cursorAt} IS NULL
            OR created_at < ${request.cursorAt}
            OR (created_at = ${request.cursorAt} AND 1 < ${request.cursorRank})
            OR (created_at = ${request.cursorAt} AND 1 = ${request.cursorRank} AND activity_id < ${request.cursorId})
          )
      )
      SELECT * FROM history
      ORDER BY "createdAt" DESC, "sortRank" DESC, id DESC
      LIMIT ${request.limit}
    `,
  });

  const getThreadState = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: ThreadStateRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread.thread_id AS "threadId",
        thread.title,
        thread.model_selection_json AS "modelSelectionJson",
        thread.runtime_mode AS "runtimeMode",
        thread.interaction_mode AS "interactionMode",
        thread.updated_at AS "updatedAt",
        session.status AS "sessionStatus",
        session.provider_name AS "providerName",
        session.provider_instance_id AS "providerInstanceId",
        session.active_turn_id AS "activeTurnId",
        session.last_error AS "lastError",
        session.updated_at AS "sessionUpdatedAt"
      FROM projection_threads AS thread
      LEFT JOIN projection_thread_sessions AS session ON session.thread_id = thread.thread_id
      WHERE thread.thread_id = ${threadId} AND thread.deleted_at IS NULL
      LIMIT 1
    `,
  });

  const getLatestMessage = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String, role: Schema.String }),
    Result: LatestMessageRow,
    execute: ({ threadId, role }) => sql`
      SELECT message_id AS id, turn_id AS "turnId", role, text, created_at AS "createdAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = ${role} AND is_streaming = 0
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `,
  });

  const getLatestActivity = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: LatestActivityRow,
    execute: ({ threadId }) => sql`
      SELECT activity_id AS id, turn_id AS "turnId", kind AS "activityKind",
        summary AS text, created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC, activity_id DESC
      LIMIT 1
    `,
  });

  const getActiveTurn = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: ActiveTurnRow,
    execute: ({ threadId }) => sql`
      SELECT turn_id AS "turnId", state, requested_at AS "requestedAt", started_at AS "startedAt"
      FROM projection_turns
      WHERE thread_id = ${threadId} AND state IN ('pending', 'running')
      ORDER BY requested_at DESC, row_id DESC
      LIMIT 1
    `,
  });

  const mapQueryError = (operation: string) => (_cause: unknown) =>
    new ThreadHistoryQueryFailedError({ operation });

  const loadPage = (
    query: NormalizedQuery,
    cursor: HistoryCursor | null,
    limit: number,
  ): Effect.Effect<ReadonlyArray<RawHistoryRow>, ThreadHistoryQueryFailedError> => {
    const request: QueryPageRequest = {
      threadId: query.threadId,
      includeMessages: query.sources.includes("messages") ? 1 : 0,
      includeActivities: query.sources.includes("activities") ? 1 : 0,
      rolesJson: JSON.stringify(query.roles),
      activityKindsJson: JSON.stringify(query.activityKinds),
      turnIdsJson: JSON.stringify(query.turnIds),
      since: query.since,
      until: query.until,
      includeAttachments: query.includeAttachments ? 1 : 0,
      includePayload: query.includePayload ? 1 : 0,
      includeStreaming: query.includeStreaming ? 1 : 0,
      literalQuery: query.matchMode === "literal" ? query.query : null,
      caseSensitive: query.caseSensitive ? 1 : 0,
      cursorAt: cursor?.createdAt ?? null,
      cursorRank: cursor?.sortRank ?? null,
      cursorId: cursor?.id ?? null,
      limit,
    };
    return (query.order === "asc" ? queryPageAsc(request) : queryPageDesc(request)).pipe(
      Effect.mapError(mapQueryError("history page")),
    );
  };

  const query = Effect.fn("ThreadHistoryQuery.query")(function* (
    request: ThreadHistoryQueryRequest,
  ) {
    const normalized = yield* normalizeRequest(request);
    const fingerprint = fingerprintQuery(normalized);
    const initialCursor = yield* decodeCursor(request.cursor, fingerprint);

    const [
      threadStateOption,
      latestUserOption,
      latestAssistantOption,
      latestActivityOption,
      activeTurnOption,
    ] = yield* Effect.all(
      [
        getThreadState({ threadId: normalized.threadId }),
        getLatestMessage({ threadId: normalized.threadId, role: "user" }),
        getLatestMessage({ threadId: normalized.threadId, role: "assistant" }),
        getLatestActivity({ threadId: normalized.threadId }),
        getActiveTurn({ threadId: normalized.threadId }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(mapQueryError("resume context")));

    if (Option.isNone(threadStateOption)) {
      return yield* new ThreadHistoryThreadNotFoundError({ threadId: normalized.threadId });
    }

    let rows: ReadonlyArray<RawHistoryRow> = [];
    let hasMore = false;
    let scanLimitReached = false;
    let scanned = 0;
    let nextCursor: string | null = null;

    if (normalized.matchMode !== "regex" || normalized.query === null) {
      const page = yield* loadPage(normalized, initialCursor, normalized.pageSize + 1);
      hasMore = page.length > normalized.pageSize;
      rows = page.slice(0, normalized.pageSize);
      scanned = rows.length;
      nextCursor = hasMore && rows.length > 0 ? encodeCursor(rows.at(-1)!, fingerprint) : null;
    } else {
      const matches: Array<RawHistoryRow> = [];
      let cursor = initialCursor;
      let exhausted = false;
      while (matches.length < normalized.pageSize && scanned < normalized.maxScanRecords) {
        const remainingScan = normalized.maxScanRecords - scanned;
        const batchSize = Math.min(REGEX_BATCH_SIZE, remainingScan);
        const page = yield* loadPage(normalized, cursor, batchSize + 1);
        const batch = page.slice(0, batchSize);
        if (batch.length === 0) {
          exhausted = true;
          break;
        }
        const matchingIndices = yield* matchRegexBatch(
          normalized.query,
          normalized.regexFlags ?? "i",
          batch,
        );
        let lastInspected: RawHistoryRow | undefined;
        for (let index = 0; index < batch.length; index += 1) {
          const row = batch[index]!;
          lastInspected = row;
          scanned += 1;
          if (matchingIndices.has(index)) matches.push(row);
          if (matches.length >= normalized.pageSize || scanned >= normalized.maxScanRecords) break;
        }
        if (lastInspected) cursor = cursorFromRow(lastInspected, fingerprint);
        if (matches.length >= normalized.pageSize) {
          hasMore = page.length > batch.indexOf(lastInspected!) + 1 || page.length > batchSize;
          break;
        }
        if (scanned >= normalized.maxScanRecords) {
          // The extra fetched row tells us whether the scan ceiling actually
          // stopped the search. Hitting the numeric ceiling on the final row
          // is still an exhausted result, not a resumable partial page.
          scanLimitReached = page.length > batch.length;
          hasMore = scanLimitReached;
          if (!scanLimitReached) exhausted = true;
          break;
        }
        if (page.length <= batchSize) {
          exhausted = true;
          break;
        }
      }
      rows = matches;
      if (!exhausted && (hasMore || scanLimitReached) && cursor !== null) {
        nextCursor = encodeCursorValue(cursor);
      }
    }

    const thread = threadStateOption.value;
    const latestMessage = (
      option: Option.Option<typeof LatestMessageRow.Type>,
    ): ThreadHistoryLatestMessage | null => {
      if (Option.isNone(option)) return null;
      return {
        id: option.value.id,
        turnId: option.value.turnId === null ? null : TurnId.make(option.value.turnId),
        role: option.value.role as OrchestrationMessageRole,
        ...truncateText(option.value.text, normalized.maxTextChars),
        createdAt: option.value.createdAt as IsoDateTime,
      };
    };
    const latestActivity = (): ThreadHistoryLatestActivity | null => {
      if (Option.isNone(latestActivityOption)) return null;
      return {
        id: latestActivityOption.value.id,
        turnId:
          latestActivityOption.value.turnId === null
            ? null
            : TurnId.make(latestActivityOption.value.turnId),
        activityKind: latestActivityOption.value.activityKind,
        ...truncateText(latestActivityOption.value.text, normalized.maxTextChars),
        createdAt: latestActivityOption.value.createdAt as IsoDateTime,
      };
    };

    const modelSelection = Option.getOrElse(
      decodeUnknownJsonOption(thread.modelSelectionJson),
      () => thread.modelSelectionJson,
    );

    return {
      thread: {
        threadId: ThreadId.make(thread.threadId),
        title: thread.title,
        modelSelection,
        runtimeMode: thread.runtimeMode as RuntimeMode,
        interactionMode: thread.interactionMode as ProviderInteractionMode,
        updatedAt: thread.updatedAt as IsoDateTime,
        session:
          thread.sessionStatus === null || thread.sessionUpdatedAt === null
            ? null
            : {
                status: thread.sessionStatus as OrchestrationSessionStatus,
                providerName: thread.providerName,
                providerInstanceId:
                  thread.providerInstanceId === null
                    ? null
                    : ProviderInstanceId.make(thread.providerInstanceId),
                activeTurnId:
                  thread.activeTurnId === null ? null : TurnId.make(thread.activeTurnId),
                lastError: thread.lastError,
                updatedAt: thread.sessionUpdatedAt as IsoDateTime,
              },
      },
      resolvedThreadIdFromInvocation: normalized.resolvedThreadIdFromInvocation,
      entries: rows.map((row) => toHistoryEntry(row, normalized)),
      resumeContext: {
        latestUserMessage: latestMessage(latestUserOption),
        latestAssistantMessage: latestMessage(latestAssistantOption),
        latestActivity: latestActivity(),
        activeTurn: Option.isNone(activeTurnOption)
          ? null
          : {
              turnId:
                activeTurnOption.value.turnId === null
                  ? null
                  : TurnId.make(activeTurnOption.value.turnId),
              state: activeTurnOption.value.state,
              requestedAt: activeTurnOption.value.requestedAt as IsoDateTime,
              startedAt: activeTurnOption.value.startedAt as IsoDateTime | null,
            },
      },
      pagination: {
        pageSize: normalized.pageSize,
        returned: rows.length,
        scanned,
        hasMore,
        nextCursor,
        scanLimitReached,
      },
      query: {
        text: normalized.query,
        matchMode: normalized.matchMode,
        regexFlags: normalized.regexFlags,
        sources: normalized.sources,
        roles: normalized.roles,
        activityKinds: normalized.activityKinds,
        turnIds: normalized.turnIds,
        since: normalized.since,
        until: normalized.until,
        order: normalized.order,
      },
    } satisfies ThreadHistoryQueryResult;
  });

  return ThreadHistoryQuery.of({ query });
});

export interface ThreadHistoryQueryShape {
  readonly query: (
    request: ThreadHistoryQueryRequest,
  ) => Effect.Effect<ThreadHistoryQueryResult, import("./types.ts").ThreadHistoryError>;
}

export class ThreadHistoryQuery extends Context.Service<
  ThreadHistoryQuery,
  ThreadHistoryQueryShape
>()("t3/mcp/toolkits/history/ThreadHistoryQuery") {}

export const layer = Layer.effect(ThreadHistoryQuery, make);

export const __testing = {
  decodeCursor,
  encodeCursor,
  fingerprintQuery,
  normalizeRequest,
};

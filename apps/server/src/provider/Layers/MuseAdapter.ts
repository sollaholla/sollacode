import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  EventId,
  type ApprovalRequestId,
  type CanonicalRequestType,
  type ChatAttachment,
  type MessageId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventBase,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { collaborationModePrompt } from "../collaborationMode.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { providerOverloadRetryReason } from "../providerOverloadRetry.ts";
import { museTurnHealthAction, type MuseTurnHealthLimits } from "../museTurnHealth.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  classifyMuseToolItemType,
  encodeMuseFrame,
  museCommandId,
  museItemFailed,
  museModelsFromCatalog,
  type MuseModelCatalogEntry,
  museCompletionCost,
  type MuseModelCost,
  museReasoningEffort,
  museReasoningText,
  museServeArgs,
  museToolDetail,
  museToolTitle,
  parseMuseMessage,
  type MuseItem,
  MUSE_CLIENT_NAME,
  MUSE_DRIVER_KIND,
  MUSE_VERIFIED_SCHEMA_FINGERPRINT,
} from "../museProtocol.ts";

/** How long a single MSP request may wait for its response. */
const REQUEST_TIMEOUT = "120 seconds";
/**
 * How long an admitted steer may wait to surface inside its turn. A tool call
 * can run for a long time before the run reaches its next model boundary,
 * so this is a ceiling for a wedged host, not an expectation.
 */
const STEER_ABSORPTION_TIMEOUT = "30 minutes";

interface SessionContext {
  session: ProviderSession;
  readonly sessionId: string;
  effort: string | undefined;
  activeTurnId: TurnId | null;
  /** Turn ids this adapter interrupted, so their terminal is not a failure. */
  readonly interrupted: Set<string>;
  /** Items already opened, so `item/updated` does not re-open a row. */
  readonly openItems: Set<string>;
  /**
   * Steers the host has acknowledged but not yet shown inside the turn.
   *
   * Keyed by the steer's command id. An accepted `turn/steer` is only a
   * promise: the input is absorbed when the run next reaches a model boundary,
   * and it surfaces on the view as a `userMessage` item carrying this command
   * id. A turn that reaches its terminal first has dropped the input -- Muse
   * says nothing about it -- so the steer is settled as failed and the caller
   * sends the message again as a fresh turn.
   */
  readonly pendingSteers: Map<string, PendingSteer>;
  /** Tool approvals the host is waiting on, by Muse approval id. */
  readonly pendingApprovals: Map<string, PendingApproval>;
  /** Structured prompts the host is waiting on, by Muse user-input id. */
  readonly pendingUserInputs: Map<string, PendingUserInput>;
  /**
   * The last `session/contextUsage` triple, which is the only authority on
   * context occupancy: MSP emits it when the value changes, so a per-completion
   * `session/tokenUsage` that followed it must not move the meter back down to
   * its own single-call total.
   */
  contextUsedTokens: number | undefined;
  contextWindowTokens: number | undefined;
  /** What this session has cost so far, in the catalog's currency. */
  spend: number;
  /** Completions that could not be priced because their model had no catalog cost. */
  unpricedCompletions: number;
  /**
   * A `view/gap` splice-fill in flight. While set, live notifications for
   * this session are held here and replayed after the paged events, so the
   * hole is filled in order rather than around whatever arrived meanwhile.
   */
  gapFill: { readonly buffered: Array<{ method: string; params: Record<string, unknown> }> } | null;
  viewCursor: string | undefined;
  readonly seenViewCursors: Set<string>;
  readonly pricedViewCursors: Set<string>;
  readonly streamedItems: Map<string, { kind: string; turnId: string; text: string }>;
  lastProgressAtMs: number;
  lastReconcileAtMs: number;
  retrySinceMs: number | null;
  viewBacklog: boolean;
  pendingPageCursor: string | undefined;
  historicalReplayPending: boolean;
  pageOnlyView: boolean;
  pageCursor: string | undefined;
  pendingPageTerminal: { readonly turnId: string; readonly receivedAtMs: number } | null;
}

interface PendingApproval {
  readonly requirementId: unknown;
  readonly requestType: CanonicalRequestType;
  readonly choices: ReadonlyArray<{
    readonly choiceId: string;
    readonly decision: string;
    readonly scope: string;
  }>;
}

interface PendingUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect: boolean;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<PendingUserInputQuestion>;
}

interface PendingSteer {
  readonly turnId: string;
  readonly messageId: MessageId | undefined;
  readonly settled: Deferred.Deferred<void, ProviderAdapterRequestError>;
}

/** Pages a `view/gap` fill will read before giving up on it. */
const MAX_GAP_FILL_PAGES = 20;
const GAP_FILL_PAGE_LIMIT = 200;
const DELIVERY_CURSOR_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** A token counter, or `undefined` when the field is absent or unusable. */
function countField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

function answerValues(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const text = stringField(entry);
      return text ? [text] : [];
    });
  }
  const text = stringField(value);
  return text ? [text] : [];
}

function museUserInputQuestions(
  params: Record<string, unknown>,
): ReadonlyArray<PendingUserInputQuestion> {
  const rawQuestions = Array.isArray(params["questions"]) ? params["questions"] : [];
  return rawQuestions.flatMap((rawQuestion) => {
    const question = asRecord(rawQuestion);
    const id = stringField(question["id"]);
    const prompt = stringField(question["question"]);
    if (!id || !prompt) return [];
    const header = stringField(question["header"]) ?? prompt;
    const options = (Array.isArray(question["options"]) ? question["options"] : []).flatMap(
      (rawOption) => {
        const option = asRecord(rawOption);
        const label = stringField(option["label"]);
        return label ? [{ label, description: stringField(option["description"]) ?? label }] : [];
      },
    );
    return [
      {
        id,
        header,
        question: prompt,
        options,
        multiSelect: stringField(asRecord(question["selection"])["mode"]) === "multiple",
      },
    ];
  });
}

/** Folded incomplete tails are provisional: later durable events reuse their cursors. */
function isIncompleteViewTail(method: string, params: Record<string, unknown>): boolean {
  const item = asRecord(params["item"]);
  return (
    (method === "item/completed" &&
      item["status"] === "failed" &&
      item["reason"] === "incomplete") ||
    (method === "turn/completed" &&
      params["terminal"] === "failed" &&
      params["reason"] === "incomplete" &&
      params["error"] == null)
  );
}

function itemFrom(params: Record<string, unknown>): MuseItem | null {
  const raw = asRecord(params["item"]);
  const itemId = raw["itemId"];
  const kind = raw["kind"];
  if (typeof itemId !== "string" || typeof kind !== "string") {
    return null;
  }
  const summary = Array.isArray(raw["summary"])
    ? raw["summary"].filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    itemId,
    kind,
    status: typeof raw["status"] === "string" ? raw["status"] : "inProgress",
    revision: typeof raw["revision"] === "number" ? raw["revision"] : 1,
    ...(stringField(raw["text"]) ? { text: raw["text"] as string } : {}),
    ...(summary && summary.length > 0 ? { summary } : {}),
    ...(stringField(raw["tool"]) ? { tool: raw["tool"] as string } : {}),
    ...(stringField(raw["args"]) ? { args: raw["args"] as string } : {}),
    ...(stringField(raw["commandText"]) ? { commandText: raw["commandText"] as string } : {}),
    ...(stringField(raw["visibleOutput"]) ? { visibleOutput: raw["visibleOutput"] as string } : {}),
    ...(stringField(raw["failureReason"]) ? { failureReason: raw["failureReason"] as string } : {}),
    ...(stringField(raw["objective"]) ? { objective: raw["objective"] as string } : {}),
  };
}

/**
 * The adapter surface plus the one method only this driver reads.
 *
 * Spelled out rather than inferred: the returned object closes over the same
 * helpers its own type would describe, and letting inference chase that cycle
 * collapses the whole adapter's requirements to `unknown` at every call site.
 */
export interface MuseAdapterShape extends ProviderAdapterShape<ProviderAdapterRequestError> {
  readonly listModels: () => Effect.Effect<
    ReadonlyArray<MuseModelCatalogEntry>,
    ProviderAdapterRequestError
  >;
}

/**
 * Adapter for Meta Muse Code over MSP.
 *
 * One `muse serve` host backs one thread: its sandbox posture is immutable.
 * MSP is a session protocol, so a session outlives its turns and a mid-turn message
 * joins the running turn natively rather than waiting for the process to exit.
 * That is the whole reason this is a persistent connection instead of a
 * per-turn spawn.
 */
const makeMuseHostAdapter = Effect.fn("makeMuseHostAdapter")(function* (config: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly trustWorkspace?: boolean;
  readonly disableSandbox?: boolean;
  /**
   * Routing for new sessions. Left unset in production so the host picks its own.
   * A provider id is not a guarantee that a turn avoids a model request.
   */
  readonly providerId?: string;
  readonly attachmentsDir?: string;
  /** Never-loaded host reads avoid a legacy owner's stale folded view. */
  readonly readStoredPage?: (
    params: Record<string, unknown>,
  ) => Effect.Effect<unknown, ProviderAdapterRequestError>;
  /** Override only in a host fixture; production uses the shared bounded policy. */
  readonly turnHealth?: {
    readonly checkIntervalMs?: number;
    readonly finalDeliveryTimeoutMs?: number;
    readonly thresholds?: MuseTurnHealthLimits;
  };
}) {
  const clock = yield* Clock.Clock;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const events = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const sessions = new Map<ThreadId, SessionContext>();
  const threadsBySessionId = new Map<string, ThreadId>();
  const pending = new Map<number, Deferred.Deferred<unknown, ProviderAdapterRequestError>>();
  const requestId = yield* Ref.make(0);
  let sessionMcpAvailable = false;
  let sequence = 0;
  let connection: ChildProcessSpawner.ChildProcessHandle | null = null;

  const now = () => DateTime.formatIso(DateTime.nowUnsafe());
  /** MSP requires a UUIDv7 idempotency handle on every command. */
  const commandId = () => museCommandId(DateTime.toEpochMillis(DateTime.nowUnsafe()));
  const base = (threadId: ThreadId, turnId?: TurnId): ProviderRuntimeEventBase => ({
    eventId: EventId.make(`muse:${config.instanceId}:${threadId}:${now()}:${++sequence}`),
    provider: MUSE_DRIVER_KIND,
    providerInstanceId: config.instanceId,
    threadId,
    createdAt: now(),
    ...(turnId ? { turnId } : {}),
  });
  let viewDelivery: {
    cursor: string | undefined;
    replay: boolean;
    historical: boolean;
    recordedAt?: string;
  } | null = null;
  const emit = (event: ProviderRuntimeEvent) => {
    if (viewDelivery?.replay && event.type === "content.delta") return;
    PubSub.publishUnsafe(events, {
      ...event,
      ...(viewDelivery?.historical
        ? {
            historicalReplay: true as const,
            ...(viewDelivery.recordedAt ? { createdAt: viewDelivery.recordedAt } : {}),
          }
        : {}),
      ...(viewDelivery?.cursor
        ? {
            eventId: EventId.make(
              `muse:${config.instanceId}:${event.threadId}:${viewDelivery.cursor}:${event.type}:${event.itemId ?? event.turnId ?? "session"}`,
            ),
          }
        : {}),
    });
  };
  const error = (method: string, detail: string) =>
    new ProviderAdapterRequestError({ provider: MUSE_DRIVER_KIND, method, detail });
  const unsupported = (method: string) =>
    Effect.fail(error(method, `Muse Code does not support ${method}.`));

  const contextForSession = (sessionId: string): SessionContext | undefined => {
    const threadId = threadsBySessionId.get(sessionId);
    return threadId ? sessions.get(threadId) : undefined;
  };

  // ── Wire ────────────────────────────────────────────────────────────────

  /**
   * Frames queued for the host's stdin.
   *
   * The host's stdin is a sink that is consumed exactly once, so one
   * long-lived stream drains this queue for the connection's whole life.
   * Running a fresh `Stream.run` per frame looks equivalent and passes a
   * single-request smoke test, but the second write then blocks forever
   * against a sink that is already finished - which stalls the handshake at
   * the `initialized` notification and hangs every turn after it.
   */
  const outbox = yield* Queue.unbounded<string>();

  const write = (frame: string) =>
    Effect.suspend(() => {
      return connection === null
        ? Effect.fail(error("write", "The Muse session host is not running."))
        : Queue.offer(outbox, frame).pipe(
            Effect.mapError((cause) =>
              error("write", `Could not write to the Muse session host: ${String(cause)}`),
            ),
            Effect.asVoid,
          );
    });

  const notify = (method: string, params: unknown) =>
    write(encodeMuseFrame({ jsonrpc: "2.0", method, params }));

  const request = Effect.fn("MuseAdapter.request")(function* (method: string, params: unknown) {
    const id = yield* Ref.updateAndGet(requestId, (value) => value + 1);
    const deferred = yield* Deferred.make<unknown, ProviderAdapterRequestError>();
    pending.set(id, deferred);
    const cleanup = Effect.sync(() => {
      pending.delete(id);
    });
    return yield* write(encodeMuseFrame({ jsonrpc: "2.0", id, method, params })).pipe(
      Effect.andThen(
        Deferred.await(deferred).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(error(method, `Muse did not answer ${method} in time.`)),
          ),
        ),
      ),
      Effect.ensuring(cleanup),
    );
  });

  // ── Notifications ───────────────────────────────────────────────────────

  /** The steer's input is inside the turn: receipt the message and release the sender. */
  const settleAbsorbedSteer = (context: SessionContext, steerCommandId: string) => {
    const steer = context.pendingSteers.get(steerCommandId);
    if (!steer) return;
    context.pendingSteers.delete(steerCommandId);
    if (steer.messageId) {
      emit({
        ...base(context.session.threadId, TurnId.make(steer.turnId)),
        type: "message.delivered",
        payload: { messageId: steer.messageId },
      });
    }
    Deferred.doneUnsafe(steer.settled, Effect.void);
  };

  /**
   * The turn is over and these steers never surfaced inside it: the host
   * dropped their input. Observed 2026-09-12 -- a message sent while Muse was
   * still winding a finished answer down (its reminder tail) was admitted,
   * the turn closed 5 ms later, and Muse's own log then rejected the same
   * command as `already_terminal` without a word on the wire. Failing the
   * sender here is what gets the message re-sent as a fresh turn.
   */
  const failUnabsorbedSteers = (context: SessionContext, turnId: string, detail: string) => {
    for (const [steerCommandId, steer] of context.pendingSteers) {
      if (steer.turnId !== turnId) continue;
      context.pendingSteers.delete(steerCommandId);
      Deferred.doneUnsafe(steer.settled, Effect.fail(error("turn/steer", detail)));
    }
  };

  const failAllPendingSteers = (context: SessionContext, detail: string) => {
    for (const [steerCommandId, steer] of context.pendingSteers) {
      context.pendingSteers.delete(steerCommandId);
      Deferred.doneUnsafe(steer.settled, Effect.fail(error("turn/steer", detail)));
    }
  };

  const onItem = (params: Record<string, unknown>, phase: "started" | "updated" | "completed") => {
    const sessionId = stringField(params["sessionId"]);
    if (!sessionId) return;
    const context = contextForSession(sessionId);
    if (!context) return;
    const item = itemFrom(params);
    if (!item) return;
    const threadId = context.session.threadId;
    const turnId =
      stringField(asRecord(params["item"])["turnId"]) ?? context.activeTurnId ?? undefined;

    // A steered submission shows up as the user's own message inside the
    // turn, naming the steer's command id. That, not the ack, is the receipt.
    if (item.kind === "userMessage") {
      const steerCommandId = stringField(asRecord(params["item"])["commandId"]);
      if (steerCommandId) settleAbsorbedSteer(context, steerCommandId);
      return;
    }
    const previousText = context.streamedItems.get(item.itemId)?.text ?? "";
    context.streamedItems.set(item.itemId, {
      kind: item.kind,
      turnId: turnId ?? "",
      text: item.kind === "reasoning" ? museReasoningText(item) : (item.text ?? ""),
    });
    const eventBase = {
      ...base(threadId, turnId ? TurnId.make(turnId) : undefined),
      itemId: RuntimeItemId.make(item.itemId),
    };

    if (item.kind === "reasoning") {
      const detail = museReasoningText(item);
      if (detail.length === 0) return;
      // Left untitled on purpose: a provider title marks reasoning as a bridge
      // narrating its own state, which the client keeps inline in the work
      // group. An untitled row is the model thinking, drawn as its own thought
      // between the tool calls it narrates.
      emit({ ...eventBase, type: "item.updated", payload: { itemType: "reasoning", detail } });
      return;
    }

    if (item.kind === "agentMessage") {
      const text = item.text ?? "";
      if (text.length === 0) return;
      const suffix = text.startsWith(previousText)
        ? text.slice(previousText.length)
        : previousText
          ? ""
          : text;
      if (viewDelivery?.replay && phase !== "completed")
        emit({
          ...eventBase,
          type: "item.updated",
          payload: { itemType: "assistant_message", detail: text },
        });
      if (suffix && !viewDelivery?.replay)
        emit({
          ...eventBase,
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: suffix },
        });
      if (phase === "completed")
        emit({
          ...eventBase,
          type: "item.completed",
          payload: { itemType: "assistant_message", detail: text },
        });
      return;
    }

    if (item.kind === "toolCall" || item.kind === "userShell") {
      const toolName = item.tool ?? (item.kind === "userShell" ? "shell" : "tool");
      const itemType = classifyMuseToolItemType(toolName);
      const title = museToolTitle(itemType);
      const detail = museToolDetail(item);
      if (phase !== "completed" && !context.openItems.has(item.itemId)) {
        context.openItems.add(item.itemId);
        emit({
          ...eventBase,
          type: "item.started",
          payload: { itemType, title, ...(detail ? { detail } : {}) },
        });
        return;
      }
      if (phase === "completed") {
        context.openItems.delete(item.itemId);
        const output = item.visibleOutput?.trim();
        const failure = item.failureReason?.trim();
        emit({
          ...eventBase,
          type: "item.completed",
          payload: {
            itemType,
            title,
            status: museItemFailed(item.status) ? ("failed" as const) : ("completed" as const),
            ...(failure
              ? { detail: failure }
              : output
                ? { detail: output }
                : detail
                  ? { detail }
                  : {}),
          },
        });
      }
      return;
    }
  };

  /**
   * Per-model prices from the account's catalog, keyed by model id.
   *
   * Loaded once per host connection: a catalog is a snapshot at call time and
   * the prices in it do not move within a session. Empty when the catalog
   * could not be read, in which case nothing gets priced and no spend is
   * reported -- an unpriced figure is worse than none.
   */
  const costByModel = new Map<string, MuseModelCost>();
  let catalogLoaded = false;
  const ensureCatalog = Effect.gen(function* () {
    if (catalogLoaded) return;
    catalogLoaded = true;
    const catalog = yield* listModels().pipe(Effect.orElseSucceed(() => []));
    for (const entry of catalog) {
      if (entry.cost) costByModel.set(entry.modelId, entry.cost);
    }
  });

  /**
   * Muse's account usage, as far as Muse can report it.
   *
   * Muse has no balance, credit or quota call anywhere -- not in the CLI, not
   * in either MSP surface; its own `/upgrade` knows only whether the account
   * is subscribed or pay-as-you-go, and a quota hit arrives as a failed
   * request. What it does serve is per-1M-token prices in the catalog and
   * counted-once token totals per completion, and that is enough for the one
   * figure a pay-as-you-go account is actually charged by: spend. This is the
   * arithmetic the TUI's own `/cost` does. It is per session, and labelled as
   * such; the billed amount itself lives in Meta Account Center (no slash
   * command, MSP method, or API the CLI touches reports it — checked 1.1.1).
   */
  const emitSpend = (context: SessionContext) => {
    emit({
      ...base(context.session.threadId, context.activeTurnId ?? undefined),
      type: "account.rate-limits.updated",
      payload: {
        rateLimits: {
          source: "muse-spend",
          sessionId: context.sessionId,
          currency: "USD",
          sessionSpend: context.spend.toFixed(6),
          unpricedCompletions: context.unpricedCompletions,
        },
      },
    });
  };

  /** Price one `session/tokenUsage` record into the session's running spend. */
  const addCompletionSpend = (context: SessionContext, params: Record<string, unknown>) => {
    const cursor = stringField(params["viewCursor"]);
    if (cursor && context.pricedViewCursors.has(cursor)) return false;
    const raw = asRecord(params["usage"]);
    const promptTokens = countField(params["promptTokens"]);
    const outputTokens = countField(raw["outputTokens"]) ?? 0;
    if (promptTokens === undefined) return false;
    if (cursor) {
      context.pricedViewCursors.add(cursor);
      if (context.pricedViewCursors.size > 60_000) {
        const oldest = context.pricedViewCursors.values().next().value;
        if (oldest) context.pricedViewCursors.delete(oldest);
      }
    }
    const modelId = stringField(params["modelId"]) ?? context.session.model;
    const cost = modelId ? costByModel.get(modelId) : undefined;
    if (!cost) {
      context.unpricedCompletions += 1;
      return true;
    }
    context.spend += museCompletionCost({
      cost,
      promptTokens,
      cachedTokens: countField(raw["cacheReadTokens"]) ?? countField(raw["cachedTokens"]) ?? 0,
      outputTokens,
    });
    return true;
  };

  /** Pages a spend backfill will read before giving up on it. */
  const MAX_SPEND_BACKFILL_PAGES = 50;

  /**
   * Re-price a resumed session from its durable records.
   *
   * The resume snapshot carries only session totals and the latest model, so
   * it cannot be priced honestly across model switches. The view can: every
   * `session/tokenUsage` the session ever folded is still there, so they are
   * paged and priced one by one. The walk stops at the resume head -- events
   * after it arrive live and are priced as they come -- and is bounded, so a
   * very long session under-reports rather than blocks.
   */
  const backfillSpend = (context: SessionContext, resumeHead: string | undefined) =>
    Effect.gen(function* () {
      yield* ensureCatalog;
      let cursor: string | undefined;
      let reachedHead = false;
      for (let page = 0; page < MAX_SPEND_BACKFILL_PAGES && !reachedHead; page += 1) {
        const result = asRecord(
          yield* request("view/page", {
            sessionId: context.sessionId,
            ...(cursor !== undefined ? { cursor } : {}),
            direction: "forward",
            limit: 1000,
          }),
        );
        const events = Array.isArray(result["events"]) ? result["events"] : [];
        for (const raw of events) {
          const entry = asRecord(raw);
          const params = asRecord(entry["params"]);
          if (stringField(entry["method"]) === "session/tokenUsage") {
            addCompletionSpend(context, params);
          }
          if (resumeHead !== undefined && stringField(params["viewCursor"]) === resumeHead) {
            reachedHead = true;
            break;
          }
        }
        const nextCursor = stringField(result["nextCursor"]);
        if (!nextCursor) break;
        cursor = nextCursor;
      }
      emitSpend(context);
    }).pipe(Effect.timeout("60 seconds"), Effect.ignore);

  /**
   * Seed a reopened session's context meter from the resume snapshot.
   *
   * Muse only reports context occupancy from inside a turn, so a thread
   * reopened on a fresh launch showed an empty meter until something ran. The
   * snapshot folds the same context triple the live events carry, so it can
   * be read at resume.
   */
  const seedUsageFromSnapshot = (context: SessionContext | undefined, result: unknown) => {
    if (!context) return;
    const state = asRecord(asRecord(asRecord(asRecord(result)["history"])["snapshot"])["state"]);
    const cumulativeTotal = countField(asRecord(state["tokenUsage"])["totalTokens"]);
    const contextUsage = asRecord(state["contextUsage"]);
    const usedTokens = countField(contextUsage["usedTokens"]);
    const windowTokens = countField(contextUsage["windowTokens"]);
    if (usedTokens !== undefined) {
      context.contextUsedTokens = usedTokens;
      context.contextWindowTokens = windowTokens;
      emit({
        ...base(context.session.threadId),
        type: "thread.token-usage.updated",
        payload: {
          usage: {
            usedTokens,
            ...(windowTokens !== undefined && windowTokens > 0 ? { maxTokens: windowTokens } : {}),
            ...(cumulativeTotal !== undefined ? { totalProcessedTokens: cumulativeTotal } : {}),
          },
        },
      });
    }
  };

  /**
   * A Muse tool approval, as one of Solla's request types.
   *
   * Muse asks per tool call and names the tool; Solla's approval card is keyed
   * by what the tool does, so the composer can offer the right wording.
   */
  const museApprovalRequestType = (toolName: string): CanonicalRequestType => {
    const itemType = classifyMuseToolItemType(toolName);
    if (itemType === "command_execution") return "command_execution_approval";
    if (itemType === "file_change") return "file_change_approval";
    return "dynamic_tool_call";
  };

  /**
   * The host's choice that matches Solla's decision.
   *
   * Muse serves the choices it will accept (`approved` once, `approvedForSession`,
   * `denied`, …); the client may only select, never construct. Fall back from
   * the exact match to the nearest one so an unusual choice set still settles.
   */
  const museApprovalChoice = (
    approval: PendingApproval,
    decision: ProviderApprovalDecision,
  ): string | undefined => {
    const wanted: ReadonlyArray<(choice: PendingApproval["choices"][number]) => boolean> =
      decision === "acceptForSession"
        ? [
            (choice) => choice.decision === "approvedForSession",
            (choice) => choice.decision === "approved" && choice.scope === "session",
            (choice) => choice.decision === "approved",
          ]
        : decision === "accept"
          ? [
              (choice) => choice.decision === "approved" && choice.scope === "once",
              (choice) => choice.decision === "approved",
              (choice) => choice.decision === "approvedForSession",
            ]
          : [
              (choice) => choice.decision === "denied",
              (choice) => choice.decision === "abort",
              (choice) => choice.decision.startsWith("denied"),
            ];
    for (const matches of wanted) {
      const choice = approval.choices.find(matches);
      if (choice) return choice.choiceId;
    }
    return undefined;
  };

  const handleNotificationInner = (method: string, params: Record<string, unknown>) => {
    if (isIncompleteViewTail(method, params)) return;
    const observedContext = contextForSession(stringField(params["sessionId"]) ?? "");
    if (observedContext) {
      const cursor = stringField(params["viewCursor"]);
      if (cursor) {
        if (observedContext.seenViewCursors.has(cursor)) return;
        observedContext.seenViewCursors.add(cursor);
        if (observedContext.seenViewCursors.size > 8192) {
          const oldest = observedContext.seenViewCursors.values().next().value;
          if (oldest) observedContext.seenViewCursors.delete(oldest);
        }
        observedContext.viewCursor = cursor;
      }
      // Startup recovery rehydrates transcript and spend, not historical
      // lifecycle transitions that could reopen or close a successor turn.
      if (
        viewDelivery?.historical &&
        !method.startsWith("item/") &&
        method !== "session/tokenUsage"
      )
        return;
      if (
        viewDelivery?.replay &&
        method.startsWith("turn/") &&
        stringField(params["turnId"]) !== observedContext.activeTurnId
      )
        return;
      // Only this foreground turn's model/tool events are progress. A background
      // reminder or an old replay must not extend a stalled turn's deadline.
      const rawItem = asRecord(params["item"]);
      const deltaItem = observedContext.streamedItems.get(stringField(params["itemId"]) ?? "");
      const eventTurnId =
        stringField(params["turnId"]) ?? stringField(rawItem["turnId"]) ?? deltaItem?.turnId;
      const kind = stringField(rawItem["kind"]) ?? deltaItem?.kind;
      const meaningfulItem =
        kind === "reasoning" ||
        kind === "agentMessage" ||
        kind === "toolCall" ||
        kind === "userShell";
      if (
        observedContext.activeTurnId === eventTurnId &&
        ((method.startsWith("item/") && meaningfulItem) || method === "session/tokenUsage")
      ) {
        observedContext.lastProgressAtMs = clock.currentTimeMillisUnsafe();
        observedContext.retrySinceMs = null;
      }
    }
    switch (method) {
      case "item/delta": {
        if (!observedContext) return;
        const itemId = stringField(params["itemId"]);
        const item = itemId ? observedContext.streamedItems.get(itemId) : undefined;
        const delta = typeof params["delta"] === "string" ? params["delta"] : "";
        if (!item || !delta || (item.kind !== "reasoning" && item.kind !== "agentMessage")) return;
        const field = stringField(params["field"]) ?? "text";
        if (field !== "text" && !field.startsWith("summary.")) return;
        item.text += delta;
        const eventBase = {
          ...base(
            observedContext.session.threadId,
            item.turnId ? TurnId.make(item.turnId) : undefined,
          ),
          itemId: RuntimeItemId.make(itemId!),
        };
        if (item.kind === "agentMessage")
          emit({
            ...eventBase,
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta },
          });
        else
          emit({
            ...eventBase,
            type: "item.updated",
            payload: { itemType: "reasoning", detail: item.text },
          });
        return;
      }
      case "item/started":
        onItem(params, "started");
        return;
      case "item/updated":
        onItem(params, "updated");
        return;
      case "item/completed": {
        onItem(params, "completed");
        // Completed payloads are durable in Muse; only open items need a
        // streaming buffer here. Cursor dedup handles later page overlaps.
        const itemId = stringField(asRecord(params["item"])["itemId"]);
        if (itemId) observedContext?.streamedItems.delete(itemId);
        return;
      }
      case "turn/completed": {
        const sessionId = stringField(params["sessionId"]);
        const turnIdRaw = stringField(params["turnId"]);
        if (!sessionId || !turnIdRaw) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        const threadId = context.session.threadId;
        const turnId = TurnId.make(turnIdRaw);
        const terminal = stringField(params["terminal"]) ?? "completed";
        if (context.pendingPageTerminal?.turnId === turnIdRaw) context.pendingPageTerminal = null;
        const wasInterrupted = context.interrupted.delete(turnIdRaw);
        // Only the running turn's terminal idles the session. A queued turn
        // the host reclaimed, or a stale terminal replayed from a page, must
        // not clear the id of a turn that is still going.
        if (context.activeTurnId === null || context.activeTurnId === turnId) {
          context.activeTurnId = null;
          context.session = {
            ...context.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: now(),
          };
          context.openItems.clear();
          context.streamedItems.clear();
          context.retrySinceMs = null;
        }
        if (terminal === "cancelled" || wasInterrupted) {
          // An interrupt is an outcome the user asked for, not a failure: a
          // failed turn is re-dispatched by the reactor moments later. It has
          // to be reported as a COMPLETED turn, though. This used to emit
          // `turn.aborted`, which no orchestration code consumes: the
          // lifecycle switch closes a turn on `turn.completed`,
          // `session.exited` or a session state change and nothing else, so
          // the session stayed `running` with this turn active and the thread
          // read as hung -- the "Muse stopped mid turn" of 2026-09-12.
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            payload: { state: "interrupted" },
          });
          failUnabsorbedSteers(
            context,
            turnIdRaw,
            "The turn was interrupted before it took the steered message.",
          );
          return;
        }
        if (terminal === "failed") {
          const failure = asRecord(params["error"]);
          const kind = stringField(failure["kind"]);
          const message =
            stringField(failure["message"]) ?? stringField(params["reason"]) ?? "The turn failed.";
          if (kind === "authRequired") {
            emit({
              ...base(threadId, turnId),
              type: "auth.status",
              payload: { error: "Muse Code needs you to sign in." },
            });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            payload: { state: "failed", errorMessage: message },
          });
          failUnabsorbedSteers(
            context,
            turnIdRaw,
            `The turn failed before it took the steered message: ${message}`,
          );
          return;
        }
        emit({
          ...base(threadId, turnId),
          type: "turn.completed",
          payload: { state: "completed" },
        });
        failUnabsorbedSteers(
          context,
          turnIdRaw,
          "Muse closed the turn before taking the steered message, so it was not processed.",
        );
        return;
      }
      // A queued submit launching at its boundary. The dispatch already
      // announced the turn when the host queued it, but the running turn's
      // terminal has since idled the session; without re-announcing it here
      // the orchestrator sits at "ready" while Muse works, and every item that
      // follows belongs to a turn it believes never started.
      case "turn/started": {
        const sessionId = stringField(params["sessionId"]);
        const turnIdRaw = stringField(params["turnId"]);
        if (!sessionId || !turnIdRaw) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        const turnId = TurnId.make(turnIdRaw);
        if (context.activeTurnId === turnId) return;
        context.activeTurnId = turnId;
        context.lastProgressAtMs = clock.currentTimeMillisUnsafe();
        context.retrySinceMs = null;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: now(),
        };
        emit({
          ...base(context.session.threadId, turnId),
          type: "turn.started",
          payload: context.session.model ? { model: context.session.model } : {},
        });
        return;
      }
      // A queued submit the host reclaimed: its pre-minted turn never runs and
      // no `turn/started` or `turn/completed` will ever name it. The dispatch
      // already announced the turn and receipted the message, so with nothing
      // else said it would wait forever. Failing it is the honest terminal --
      // the input was not processed -- and it is what the reactor re-runs.
      case "turn/unqueued": {
        const sessionId = stringField(params["sessionId"]);
        const turnIdRaw = stringField(params["turnId"]);
        if (!sessionId || !turnIdRaw) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        const turnId = TurnId.make(turnIdRaw);
        if (context.activeTurnId === turnId) {
          context.activeTurnId = null;
          context.session = { ...context.session, status: "ready", updatedAt: now() };
        }
        emit({
          ...base(context.session.threadId, turnId),
          type: "turn.completed",
          payload: {
            state: "failed",
            errorMessage:
              "Muse reclaimed this queued turn before it ran, so the message was not processed.",
          },
        });
        return;
      }
      // A failing model attempt with a scheduled retry. Non-terminal: the
      // turn is still running, but from the outside nothing moves for the
      // whole backoff. The orchestrator has a phase for exactly this, driven
      // by the same reason string the other providers use.
      case "turn/retryScheduled": {
        const sessionId = stringField(params["sessionId"]);
        const turnIdRaw = stringField(params["turnId"]);
        if (!sessionId || !turnIdRaw) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        const reason = stringField(params["reason"]);
        context.retrySinceMs ??= clock.currentTimeMillisUnsafe();
        emit({
          ...base(context.session.threadId, TurnId.make(turnIdRaw)),
          type: "session.state.changed",
          payload: {
            state: "running",
            reason: providerOverloadRetryReason({
              attempt: countField(params["attempt"]),
              maxAttempts: countField(params["maxAttempts"]),
              delayMs: countField(params["retryDelayMs"]),
            }),
            ...(reason ? { detail: { reason } } : {}),
          },
        });
        return;
      }
      // A tool call the host will not run without a decision. Left unanswered
      // the turn sits at `proposed` forever -- which is exactly what wedged the
      // Pawstalgia thread on 2026-09-12: this adapter had no handler, so a
      // `bash` call that Muse's policy did not auto-approve was never seen.
      case "approval/requested": {
        const sessionId = stringField(params["sessionId"]);
        const approvalId = stringField(params["approvalId"]);
        if (!sessionId || !approvalId) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        const toolName = stringField(params["toolName"]) ?? "tool";
        const rawArgs = stringField(params["rawArgs"]);
        const requestType = museApprovalRequestType(toolName);
        const choices = (
          Array.isArray(params["availableChoices"]) ? params["availableChoices"] : []
        )
          .map((raw) => asRecord(raw))
          .flatMap((choice) => {
            const choiceId = stringField(choice["choiceId"]);
            const decision = stringField(choice["decision"]);
            if (!choiceId || !decision) return [];
            return [{ choiceId, decision, scope: stringField(choice["scope"]) ?? "once" }];
          });
        const alreadyPending = context.pendingApprovals.has(approvalId);
        context.pendingApprovals.set(approvalId, {
          requirementId: params["currentRequirementId"],
          requestType,
          choices,
        });
        if (alreadyPending) return;
        const turnIdRaw = stringField(params["turnId"]) ?? context.activeTurnId ?? undefined;
        emit({
          ...base(context.session.threadId, turnIdRaw ? TurnId.make(turnIdRaw) : undefined),
          requestId: RuntimeRequestId.make(approvalId),
          type: "request.opened",
          payload: {
            requestType,
            detail: rawArgs ? `${toolName}: ${rawArgs.slice(0, 2000)}` : toolName,
            args: { toolName, ...(rawArgs ? { rawArgs } : {}), itemId: params["itemId"] },
          },
        });
        return;
      }
      case "approval/resolved": {
        const sessionId = stringField(params["sessionId"]);
        const approvalId = stringField(params["approvalId"]);
        if (!sessionId || !approvalId) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        const pending = context.pendingApprovals.get(approvalId);
        context.pendingApprovals.delete(approvalId);
        const decision =
          stringField(asRecord(params["resolution"])["decision"]) ??
          stringField(params["decision"]);
        emit({
          ...base(context.session.threadId, context.activeTurnId ?? undefined),
          requestId: RuntimeRequestId.make(approvalId),
          type: "request.resolved",
          payload: {
            requestType: pending?.requestType ?? "unknown",
            ...(decision ? { decision } : {}),
            resolution: params,
          },
        });
        return;
      }
      case "userInput/requested": {
        const sessionId = stringField(params["sessionId"]);
        const userInputId = stringField(params["userInputId"]);
        if (!sessionId || !userInputId) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        const questions = museUserInputQuestions(params);
        const alreadyPending = context.pendingUserInputs.has(userInputId);
        context.pendingUserInputs.set(userInputId, { questions });
        if (alreadyPending) return;
        const turnIdRaw = stringField(params["turnId"]) ?? context.activeTurnId ?? undefined;
        emit({
          ...base(context.session.threadId, turnIdRaw ? TurnId.make(turnIdRaw) : undefined),
          requestId: RuntimeRequestId.make(userInputId),
          type: "user-input.requested",
          payload: { questions },
        });
        return;
      }
      case "userInput/settled": {
        const sessionId = stringField(params["sessionId"]);
        const userInputId = stringField(params["userInputId"]);
        if (!sessionId || !userInputId) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        context.pendingUserInputs.delete(userInputId);
        const answers = Object.fromEntries(
          (Array.isArray(params["answers"]) ? params["answers"] : []).flatMap((rawAnswer) => {
            const answer = asRecord(rawAnswer);
            const questionId = stringField(answer["questionId"]);
            if (!questionId) return [];
            const selectedLabels = Array.isArray(answer["selectedLabels"])
              ? answer["selectedLabels"].flatMap((entry) =>
                  stringField(entry) ? [stringField(entry)!] : [],
                )
              : undefined;
            const value =
              selectedLabels ??
              stringField(answer["selectedLabel"]) ??
              stringField(answer["freeText"]) ??
              "";
            return [[questionId, value] as const];
          }),
        );
        emit({
          ...base(context.session.threadId, context.activeTurnId ?? undefined),
          requestId: RuntimeRequestId.make(userInputId),
          type: "user-input.resolved",
          payload: { answers },
        });
        return;
      }
      case "session/modelChanged": {
        const sessionId = stringField(params["sessionId"]);
        const modelId = stringField(params["modelId"]);
        if (!sessionId || !modelId) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        context.session = { ...context.session, model: modelId, updatedAt: now() };
        return;
      }
      // Entitlement, reported the only way Muse reports it: the signed-in
      // provider cannot route the session's standing model. The next turn will
      // fail; this says why before it does.
      case "session/modelRouteUnserved": {
        const sessionId = stringField(params["sessionId"]);
        if (!sessionId) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        const modelId = stringField(params["modelId"]) ?? context.session.model ?? "this model";
        const installed = stringField(params["installedProviderId"]);
        emit({
          ...base(context.session.threadId, context.activeTurnId ?? undefined),
          itemId: RuntimeItemId.make(`muse-route-unserved:${sessionId}:${++sequence}`),
          type: "item.completed",
          payload: {
            itemType: "error",
            status: "failed",
            title: "Model unavailable",
            detail: `Muse cannot run ${modelId}${
              installed ? ` on the signed-in provider (${installed})` : ""
            }. Choose another model or sign in to a provider that serves it.`,
          },
        });
        return;
      }
      // The context meter's real source. MSP computes occupancy against the
      // host's pressure basis and hands over the window size with it, so this
      // is the one event that can give Muse the percentage every other provider
      // shows. Ignoring it left the meter with a numerator and no denominator.
      case "session/contextUsage": {
        const sessionId = stringField(params["sessionId"]);
        if (!sessionId) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        const usedTokens = countField(params["usedTokens"]);
        if (usedTokens === undefined) return;
        // `windowTokens` is absent when the basis has no limit, and MSP never
        // invents one. Carry that absence rather than guessing from the model
        // catalog: a made-up denominator is a made-up percentage.
        const windowTokens = countField(params["windowTokens"]);
        context.contextUsedTokens = usedTokens;
        context.contextWindowTokens = windowTokens;
        emit({
          ...base(context.session.threadId),
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens,
              ...(windowTokens !== undefined && windowTokens > 0
                ? { maxTokens: windowTokens }
                : {}),
            },
          },
        });
        return;
      }
      case "session/tokenUsage": {
        const sessionId = stringField(params["sessionId"]);
        if (!sessionId) return;
        const context = contextForSession(sessionId);
        if (!context) return;
        const raw = asRecord(params["usage"]);
        const cumulative = asRecord(params["cumulative"]);
        // `promptTokens` and `totalTokens` are counted once by the host under
        // whichever cache convention the account's provider uses. The raw
        // counters beside them are explicitly not summable (MSP tdd SS4.6.5,
        // #8803) -- which is exactly what this did, adding `inputTokens` to
        // `outputTokens` and reporting a figure that was off by whatever the
        // prompt cache held.
        const totalTokens = countField(params["totalTokens"]);
        const promptTokens = countField(params["promptTokens"]);
        const outputTokens = countField(raw["outputTokens"]);
        const completionTotal =
          totalTokens ??
          (promptTokens !== undefined || outputTokens !== undefined
            ? (promptTokens ?? 0) + (outputTokens ?? 0)
            : undefined);
        // Occupancy belongs to `session/contextUsage`; this event only knows
        // what one completion cost. Falling back to the completion total keeps
        // a meter on screen before the first context event arrives.
        const usedTokens = context.contextUsedTokens ?? completionTotal;
        if (usedTokens === undefined) return;
        const cumulativeTotal = countField(cumulative["totalTokens"]);
        const cumulativePrompt = countField(cumulative["promptTokens"]);
        const cumulativeOutput = countField(cumulative["outputTokens"]);
        const cachedTokens = countField(raw["cacheReadTokens"]) ?? countField(raw["cachedTokens"]);
        const reasoningTokens = countField(raw["reasoningTokens"]);
        const durationMs = countField(params["durationMs"]);
        if (addCompletionSpend(context, params)) emitSpend(context);
        emit({
          ...base(context.session.threadId),
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens,
              ...(context.contextWindowTokens !== undefined && context.contextWindowTokens > 0
                ? { maxTokens: context.contextWindowTokens }
                : {}),
              ...(cumulativeTotal !== undefined ? { totalProcessedTokens: cumulativeTotal } : {}),
              ...(cumulativePrompt !== undefined ? { inputTokens: cumulativePrompt } : {}),
              ...(cumulativeOutput !== undefined ? { outputTokens: cumulativeOutput } : {}),
              ...(completionTotal !== undefined ? { lastUsedTokens: completionTotal } : {}),
              ...(promptTokens !== undefined ? { lastInputTokens: promptTokens } : {}),
              ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
              ...(cachedTokens !== undefined ? { lastCachedInputTokens: cachedTokens } : {}),
              ...(reasoningTokens !== undefined
                ? { lastReasoningOutputTokens: reasoningTokens }
                : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          },
        });
        return;
      }
      default:
        return;
    }
  };

  const handleNotification = (
    method: string,
    params: Record<string, unknown>,
    replay = false,
    historical = false,
  ) => {
    const previous = viewDelivery;
    const recordedAt =
      stringField(asRecord(params["item"])["recordedAt"]) ?? stringField(params["recordedAt"]);
    const recordedAtMs = recordedAt ? Date.parse(recordedAt) : Number.NaN;
    viewDelivery = {
      cursor: stringField(params["viewCursor"]),
      replay,
      historical,
      ...(Number.isFinite(recordedAtMs)
        ? { recordedAt: DateTime.formatIso(DateTime.makeUnsafe(recordedAtMs)) }
        : {}),
    };
    try {
      handleNotificationInner(method, params);
    } finally {
      viewDelivery = previous;
    }
  };

  /**
   * Fill a `view/gap` from the paged view.
   *
   * Push delivery dropped events between `after` and `next`. If the dropped
   * run held the turn's terminal, nothing else will ever end the turn: the
   * adapter would wait for a `turn/completed` that was already spent. The
   * sanctioned recovery is to page `(after, next)` forward and splice it in,
   * holding live notifications until the hole is filled so nothing is
   * processed out of order. Cursors are opaque, so the page is walked until
   * the event whose cursor IS `next` -- that one was delivered live and is
   * excluded here -- or the view runs out.
   */
  const fillViewGap = (context: SessionContext, after: string, next: string) =>
    Effect.gen(function* () {
      const recovered: Array<{ method: string; params: Record<string, unknown> }> = [];
      let cursor = after;
      for (let page = 0; page < MAX_GAP_FILL_PAGES; page += 1) {
        const result = asRecord(
          yield* request("view/page", {
            sessionId: context.sessionId,
            cursor,
            direction: "forward",
            limit: GAP_FILL_PAGE_LIMIT,
          }),
        );
        const events = Array.isArray(result["events"]) ? result["events"] : [];
        let reachedNext = false;
        for (const raw of events) {
          const entry = asRecord(raw);
          const method = stringField(entry["method"]);
          const params = asRecord(entry["params"]);
          if (!method) continue;
          if (isIncompleteViewTail(method, params) || stringField(params["viewCursor"]) === next) {
            reachedNext = true;
            break;
          }
          recovered.push({ method, params });
        }
        const nextCursor = stringField(result["nextCursor"]);
        if (reachedNext || !nextCursor) break;
        cursor = nextCursor;
      }
      return recovered;
    }).pipe(
      Effect.timeout("30 seconds"),
      // A fill that fails leaves the hole unfilled, which is where things
      // stood before it was attempted; the held notifications still replay.
      Effect.orElseSucceed((): Array<{ method: string; params: Record<string, unknown> }> => []),
      Effect.flatMap((recovered) =>
        Effect.sync(() => {
          const held = context.gapFill?.buffered ?? [];
          context.gapFill = null;
          for (const event of recovered) handleNotification(event.method, event.params, true);
          for (const event of held) handleNotification(event.method, event.params);
        }),
      ),
    );

  const onNotification = (method: string, params: Record<string, unknown>): Effect.Effect<void> => {
    const sessionId = stringField(params["sessionId"]);
    const context = sessionId ? contextForSession(sessionId) : undefined;
    // A legacy host can push lifecycle independently of its unavailable item
    // stream. Only the paged terminal proves preceding final items were read.
    if (
      context?.pageOnlyView &&
      method === "turn/completed" &&
      params["terminal"] === "completed" &&
      stringField(params["turnId"]) === context.activeTurnId
    ) {
      context.pendingPageTerminal ??= {
        turnId: context.activeTurnId,
        receivedAtMs: clock.currentTimeMillisUnsafe(),
      };
      return context.gapFill
        ? Effect.void
        : reconcileView(context).pipe(Effect.forkIn(scope), Effect.asVoid);
    }
    if (context?.gapFill) {
      context.gapFill.buffered.push({ method, params });
      return Effect.void;
    }
    if (method === "view/gap" && context) {
      const after = stringField(params["after"]);
      const next = stringField(params["next"]);
      if (!after || !next) return Effect.void;
      context.gapFill = { buffered: [] };
      // Forked: the page answer arrives on this very read loop, so awaiting
      // it here would wait on itself.
      return fillViewGap(context, after, next).pipe(Effect.forkIn(scope), Effect.asVoid);
    }
    return Effect.sync(() => handleNotification(method, params));
  };

  /** Legacy sessions without a materialized sidecar support page reads only. */
  const subscribeView = Effect.fn("MuseAdapter.subscribeView")(function* (context: SessionContext) {
    if (context.pageOnlyView) return;
    yield* request("view/subscribe", {
      sessionId: context.sessionId,
      ...(context.viewCursor ? { after: context.viewCursor } : {}),
    }).pipe(
      Effect.catch((cause) => {
        const unsupportedView = cause.detail.includes(
          `view/subscribe: session ${context.sessionId} is loaded without a live view attachment (no materialized sidecar), so it cannot be live-tailed; use view/page for point-in-time reads`,
        );
        // A durable page cursor can outlive the live sidecar anchor. Keep
        // reading authoritative pages instead of retrying that rejected anchor.
        const staleAnchor = !!context.viewCursor && cause.detail.includes("unknown cursor anchor");
        if (!unsupportedView && !staleAnchor) return Effect.fail(cause);
        return Effect.sync(() => {
          context.pageOnlyView = true;
          context.pageCursor = context.viewCursor;
        });
      }),
    );
  });

  /** Repair silent push delivery through the same host that owns the turn. */
  const reconcileView = Effect.fn("MuseAdapter.reconcileView")(function* (
    context: SessionContext,
    historical = false,
  ) {
    if (context.gapFill || !connection) return;
    context.lastReconcileAtMs = clock.currentTimeMillisUnsafe();
    context.viewBacklog = false;
    context.gapFill = { buffered: [] };
    const after =
      context.pendingPageCursor ?? (context.pageOnlyView ? context.pageCursor : context.viewCursor);
    const recovered: Array<{ method: string; params: Record<string, unknown> }> = [];
    yield* Effect.gen(function* () {
      let cursor = after;
      for (let page = 0; page < MAX_GAP_FILL_PAGES; page += 1) {
        const result = asRecord(
          yield* (
            context.pageOnlyView && config.readStoredPage
              ? config.readStoredPage
              : (params: Record<string, unknown>) => request("view/page", params)
          )({
            sessionId: context.sessionId,
            ...(cursor ? { cursor } : {}),
            direction: "forward",
            limit: GAP_FILL_PAGE_LIMIT,
          }),
        );
        const pageEvents = Array.isArray(result["events"]) ? result["events"] : [];
        yield* Effect.annotateCurrentSpan({
          "muse.page.reader": context.pageOnlyView && config.readStoredPage ? "stored" : "owner",
          "muse.page.session": context.sessionId,
          "muse.page.after": cursor?.slice(0, 200) ?? "",
          "muse.page.count": pageEvents.length,
          "muse.page.tail":
            stringField(asRecord(asRecord(pageEvents.at(-1))["params"])["viewCursor"])?.slice(
              0,
              200,
            ) ?? "",
          "muse.page.next": stringField(result["nextCursor"])?.slice(0, 200) ?? "",
          "muse.page.number": page + 1,
        });
        let incompleteTail = false;
        for (const raw of pageEvents) {
          const entry = asRecord(raw);
          const method = stringField(entry["method"]);
          const params = asRecord(entry["params"]);
          if (!method) continue;
          // Every cursor from the first provisional close onward can be
          // reassigned when the next real record arrives. Retain the preceding
          // durable anchor instead of following this page's nextCursor.
          if (isIncompleteViewTail(method, params)) {
            incompleteTail = true;
            break;
          }
          recovered.push({ method, params });
        }
        if (incompleteTail) {
          context.pendingPageCursor = undefined;
          yield* Effect.annotateCurrentSpan("muse.page.incompleteTail", true);
          break;
        }
        const next = stringField(result["nextCursor"]);
        if (!next || next === cursor) {
          context.pendingPageCursor = undefined;
          break;
        }
        cursor = next;
        if (page === MAX_GAP_FILL_PAGES - 1) {
          context.viewBacklog = true;
          context.pendingPageCursor = next;
        }
      }
    }).pipe(
      Effect.timeout("20 seconds"),
      // Logged, never surfaced: a failed refresh retries in the background and
      // the held events still replay below, so there is nothing for the user
      // to do with this.
      Effect.catch((cause) =>
        Effect.logWarning("Muse progress delivery could not be refreshed.", {
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          cause: String(cause),
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          const held = context.gapFill?.buffered ?? [];
          context.gapFill = null;
          for (const event of recovered)
            handleNotification(event.method, event.params, true, historical);
          // Duplicates do not emit twice, but a completed forward page still
          // establishes its last observed cursor before newer held push frames.
          const pageCursor = stringField(recovered.at(-1)?.params["viewCursor"]);
          if (pageCursor) {
            context.viewCursor = pageCursor;
            if (context.pageOnlyView) context.pageCursor = pageCursor;
          }
          for (const event of held) handleNotification(event.method, event.params);
        }),
      ),
    );
    if (context.viewBacklog) return;
    // Re-attach after the repaired cursor. Replayed overlaps are deduplicated.
    // Logged, never surfaced: same rationale as the refresh above.
    yield* subscribeView(context).pipe(
      Effect.timeout("10 seconds"),
      Effect.catch((cause) =>
        Effect.logWarning("Muse live streaming could not be reattached.", {
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          cause: String(cause),
        }),
      ),
    );
  });

  const turnHealth = (context: SessionContext) =>
    context.pendingPageTerminal &&
    clock.currentTimeMillisUnsafe() - context.pendingPageTerminal.receivedAtMs >=
      (config.turnHealth?.finalDeliveryTimeoutMs ?? 60_000)
      ? { action: "stop" as const, reason: "model-silence" as const }
      : museTurnHealthAction({
          nowMs: clock.currentTimeMillisUnsafe(),
          lastProgressAtMs: context.lastProgressAtMs,
          lastReconcileAtMs: context.lastReconcileAtMs,
          pendingApproval: context.pendingApprovals.size > 0 || context.pendingUserInputs.size > 0,
          openToolCount: [...context.openItems].filter(
            (itemId) => context.streamedItems.get(itemId)?.turnId === context.activeTurnId,
          ).length,
          retrySinceMs: context.retrySinceMs,
          ...(config.turnHealth?.thresholds ? { limits: config.turnHealth.thresholds } : {}),
        });

  const closeOwnedHandle = Effect.fn("MuseAdapter.closeOwnedHandle")(function* (
    handle: ChildProcessSpawner.ChildProcessHandle,
  ) {
    const exited = yield* handle.kill().pipe(
      Effect.ignore,
      Effect.andThen(handle.exitCode),
      Effect.timeout("2 seconds"),
      Effect.catch(() =>
        handle
          .kill({ killSignal: "SIGKILL" })
          .pipe(Effect.ignore, Effect.andThen(handle.exitCode), Effect.timeout("2 seconds")),
      ),
      Effect.exit,
    );
    return Exit.isSuccess(exited);
  });

  const monitorTurn = Effect.fn("MuseAdapter.monitorTurn")(function* (context: SessionContext) {
    while (sessions.get(context.session.threadId) === context && connection) {
      yield* Effect.sleep(
        config.turnHealth?.checkIntervalMs ?? (context.pageOnlyView ? 5_000 : 15_000),
      );
      if (context.historicalReplayPending) {
        yield* reconcileView(context, true);
        context.historicalReplayPending = context.viewBacklog;
        continue;
      }
      const turnId = context.activeTurnId;
      if (
        !turnId ||
        context.gapFill ||
        (!context.pageOnlyView && !context.viewBacklog && turnHealth(context).action === "wait")
      )
        continue;
      yield* reconcileView(context);
      if (
        context.viewBacklog ||
        context.activeTurnId !== turnId ||
        turnHealth(context).action !== "stop"
      )
        continue;
      let detail = context.pendingPageTerminal
        ? "[muse-progress-timeout] Muse finished, but delivery of its final reply could not be verified. Resume to recover the saved response."
        : "[muse-progress-timeout] Muse stopped reporting progress after its recovery window. The turn was stopped; resume it when ready.";
      // An interrupt acknowledgement is admission, not a terminal receipt.
      // Close this owned host too, so a failed interrupt cannot leave hidden work.
      if (!context.pendingPageTerminal)
        yield* request("turn/interrupt", {
          commandId: commandId(),
          sessionId: context.sessionId,
          turnId,
        }).pipe(Effect.timeout("5 seconds"), Effect.ignore);
      if (context.activeTurnId !== turnId) continue;
      const handle = connection;
      connection = null;
      if (handle && !(yield* closeOwnedHandle(handle)))
        detail = context.pendingPageTerminal
          ? "[muse-progress-timeout] Muse finished, but delivery of its final reply could not be verified and its host exit could not be confirmed. Check the host before resuming."
          : "[muse-progress-timeout] Muse stopped reporting progress, but its host exit could not be confirmed. Check the host before resuming.";
      context.activeTurnId = null;
      context.session = {
        ...context.session,
        status: "closed",
        activeTurnId: undefined,
        lastError: detail,
        updatedAt: now(),
      };
      failAllPendingSteers(context, detail);
      emit({
        ...base(context.session.threadId, turnId),
        type: "runtime.error",
        payload: { message: detail, detail: { code: "muse-progress-timeout" } },
      });
      emit({
        ...base(context.session.threadId, turnId),
        type: "turn.completed",
        payload: { state: "failed", errorMessage: detail, stopReason: "muse-progress-timeout" },
      });
      emit({
        ...base(context.session.threadId),
        type: "session.exited",
        payload: { reason: detail, recoverable: true, exitKind: "error" },
      });
    }
  });

  // ── Connection ──────────────────────────────────────────────────────────

  const connectionMutex = yield* Semaphore.make(1);
  const connect = Effect.fn("MuseAdapter.connect")(function* () {
    if (connection) return;
    const args = museServeArgs({ trustWorkspace: config.trustWorkspace ?? false });
    if (config.disableSandbox) args.push("--disable-sandbox");
    const command = yield* resolveSpawnCommand(config.binaryPath, args, {
      env: config.environment,
    }).pipe(
      Effect.mapError((cause) =>
        error("connect", `Could not resolve the Muse binary: ${String(cause)}`),
      ),
    );
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(command.command, command.args, {
          shell: command.shell,
          cwd: config.cwd,
          env: config.environment,
          extendEnv: false,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
        }),
      )
      .pipe(
        // The host outlives every turn on this instance, so it is owned by the
        // adapter's scope rather than a per-turn one.
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError((cause) =>
          error("connect", `Could not start the Muse session host: ${String(cause)}`),
        ),
      );
    connection = handle;

    yield* Stream.fromQueue(outbox).pipe(
      Stream.encodeText,
      Stream.run(handle.stdin),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    // Nothing answers once the read loop is gone -- the host exited, or this
    // scope is closing and interrupted the loop ahead of the finalizers that
    // still want to talk to the host. Every request and steer waiting on an
    // answer would otherwise sit out the full request timeout.
    const abandonWaiters = Effect.gen(function* () {
      // A protocol reader can fail while its process is still alive. Stop
      // that exact owned process before publishing the recoverable failure.
      if (connection !== handle) return;
      connection = null;
      const stopped = yield* closeOwnedHandle(handle);
      const detail = stopped
        ? "The Muse session host is no longer answering."
        : "[muse-progress-timeout] The Muse protocol stream failed and its host exit could not be confirmed. Check the host before resuming.";
      for (const [id, deferred] of pending) {
        pending.delete(id);
        Deferred.doneUnsafe(deferred, Effect.fail(error("read", detail)));
      }
      for (const context of sessions.values()) {
        const turnId = context.activeTurnId;
        context.activeTurnId = null;
        failAllPendingSteers(context, detail);
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: now(),
          lastError: detail,
        };
        emit({
          ...base(context.session.threadId, turnId ?? undefined),
          type: "runtime.error",
          payload: { message: detail },
        });
        if (turnId)
          emit({
            ...base(context.session.threadId, turnId),
            type: "turn.completed",
            payload: { state: "failed", errorMessage: detail },
          });
        emit({
          ...base(context.session.threadId),
          type: "session.exited",
          payload: { reason: detail, recoverable: true, exitKind: "error" },
        });
      }
    });
    yield* handle.stdout.pipe(
      Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
      Stream.runForEach((value) =>
        Effect.suspend(() => {
          const message = parseMuseMessage(value);
          if (!message) return Effect.void;
          if (message.kind === "notification") {
            return onNotification(message.method, message.params);
          }
          if (message.kind === "request") {
            const notificationMethod =
              message.method === "approval/request"
                ? "approval/requested"
                : message.method === "userInput/request"
                  ? "userInput/requested"
                  : undefined;
            if (!notificationMethod) {
              return write(
                encodeMuseFrame({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: {
                    code: -32601,
                    message: `method not found: ${message.method}`,
                    data: { kind: "methodNotFound" },
                  },
                }),
              );
            }
            return onNotification(notificationMethod, message.params).pipe(
              Effect.andThen(
                write(encodeMuseFrame({ jsonrpc: "2.0", id: message.id, result: {} })),
              ),
            );
          }
          if (message.kind === "result") {
            const deferred = pending.get(message.id);
            if (deferred) Deferred.doneUnsafe(deferred, Effect.succeed(message.result));
            return Effect.void;
          }
          if (message.kind === "error") {
            const deferred = pending.get(message.id);
            if (deferred) {
              Deferred.doneUnsafe(
                deferred,
                Effect.fail(error(`muse:${message.errorKind ?? "error"}`, message.message)),
              );
            }
          }
          return Effect.void;
        }),
      ),
      Effect.ignore,
      Effect.ensuring(abandonWaiters),
      Effect.forkIn(scope),
    );
    yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));

    const initialize = yield* request("initialize", {
      // MSP requires a machine identifier here; the hyphenated product name is
      // rejected outright.
      clientInfo: { name: MUSE_CLIENT_NAME, version: "1" },
      capabilities: { userInputDialogs: false, requestedCapabilities: ["sessionMcp"] },
    });
    sessionMcpAvailable =
      Array.isArray(asRecord(initialize)["grantedCapabilities"]) &&
      (asRecord(initialize)["grantedCapabilities"] as unknown[]).includes("sessionMcp");
    const fingerprint = stringField(asRecord(asRecord(initialize)["schema"])["fingerprint"]);
    if (fingerprint && fingerprint !== MUSE_VERIFIED_SCHEMA_FINGERPRINT) {
      yield* Effect.logWarning(
        `Muse reports MSP schema fingerprint ${fingerprint}, not the ${MUSE_VERIFIED_SCHEMA_FINGERPRINT} this build was written against. Re-run \`muse schema generate-ts\` and diff if events look wrong.`,
      );
    }
    // The handshake is two-step: without this notification every later call
    // fails `notInitialized`.
    yield* notify("initialized", {});
  }, connectionMutex.withPermit);

  // ── Adapter surface ─────────────────────────────────────────────────────

  /**
   * The models the signed-in account actually serves.
   *
   * Asked of the running host rather than hardcoded: Muse's catalog is served
   * per account, and it comes back empty when signed out. An empty list is
   * reported as empty - inventing slugs to fill it is how a model id that no
   * account serves reaches the picker.
   */
  const listModels: () => Effect.Effect<
    ReadonlyArray<MuseModelCatalogEntry>,
    ProviderAdapterRequestError
  > = Effect.fn("MuseAdapter.listModels")(function* () {
    yield* connect();
    const result = yield* request("model/list", {});
    return museModelsFromCatalog(result);
  });

  const startSession: ProviderAdapterShape<ProviderAdapterRequestError>["startSession"] = Effect.fn(
    "MuseAdapter.startSession",
  )(function* (input) {
    const existing = sessions.get(input.threadId);
    if (existing) return existing.session;
    yield* connect();
    const cwd = input.cwd ?? config.cwd;
    const savedCursor = asRecord(input.resumeCursor);
    const resumeSessionId =
      typeof input.resumeCursor === "string"
        ? input.resumeCursor
        : (stringField(savedCursor["sessionId"]) ?? null);
    // Older anchors may point past a provisional tail that later became a
    // real final reply. Rebuild delivery once without replacing the session.
    const hasSavedViewCursor = resumeSessionId !== null;
    const savedViewCursor =
      savedCursor["deliveryCursorVersion"] === DELIVERY_CURSOR_VERSION
        ? stringField(savedCursor["viewCursor"])
        : undefined;
    const providerId = config.providerId;
    const model = input.modelSelection?.model;
    const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
    if (mcpSession && !sessionMcpAvailable && !mcpSession.shellBridgeInstructions)
      return yield* error(
        "startSession",
        "Muse does not support native session MCP and no host-tool bridge was prepared.",
      );
    const sessionConfig =
      mcpSession && sessionMcpAvailable
        ? {
            config: {
              mcpServers: {
                "t3-code": {
                  transport: "streamableHttp",
                  url: mcpSession.endpoint,
                  headers: { Authorization: mcpSession.authorizationHeader },
                  mode: "required",
                },
              },
            },
          }
        : {};
    const result = resumeSessionId
      ? yield* request("session/resume", {
          commandId: commandId(),
          sessionId: resumeSessionId,
          // A snapshot, not the item log: the fold's `tokenUsage` and
          // `contextUsage` are what let a reopened thread show its numbers
          // before any new turn runs. A preference the host may downgrade,
          // which is fine -- the seed below simply finds nothing.
          history: "snapshot",
          ...sessionConfig,
        }).pipe(
          // A cursor can outlive the session it names; starting fresh is
          // better than refusing to open the thread at all. It has to start
          // the SAME session the non-resume path would, though: this dropped
          // `providerId`, so a thread continuing from a cursor the host had
          // already discarded silently came back on a different startup
          // provider than the one configured -- `echo` fell back to a real
          // `meta` session, which is the one substitution that costs money.
          Effect.catch(() =>
            request("session/start", {
              commandId: commandId(),
              workspaceRoot: cwd,
              ...sessionConfig,
              ...(model ? { modelId: model } : {}),
              ...(providerId ? { providerId } : {}),
            }),
          ),
        )
      : yield* request("session/start", {
          commandId: commandId(),
          workspaceRoot: cwd,
          ...sessionConfig,
          ...(model ? { modelId: model } : {}),
          ...(providerId ? { providerId } : {}),
        });
    const sessionId = stringField(asRecord(asRecord(result)["session"])["sessionId"]);
    if (!sessionId) {
      return yield* error("startSession", "Muse did not return a session id.");
    }
    // Approval and sandbox posture are independent. Always set the approval
    // mode, including on resume, so a prior allowAll grant cannot survive a downgrade.
    const approvalMode =
      input.runtimeMode === "full-access" || input.runtimeMode === "auto"
        ? "allowAll"
        : "promptUnmatched";
    const approvalResult = yield* request("session/setApprovalMode", {
      commandId: commandId(),
      sessionId,
      mode: approvalMode,
    });
    const effectiveMode = stringField(asRecord(asRecord(approvalResult)["effectiveMode"])["mode"]);
    if (effectiveMode && effectiveMode !== approvalMode)
      return yield* error("startSession", "Muse did not apply the requested approval mode.");
    const timestamp = now();
    const session: ProviderSession = {
      provider: MUSE_DRIVER_KIND,
      providerInstanceId: config.instanceId,
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
      status: "ready",
      cwd,
      ...(model ? { model } : {}),
      resumeCursor: {
        sessionId,
        deliveryCursorVersion: DELIVERY_CURSOR_VERSION,
        viewCursor:
          hasSavedViewCursor && sessionId === resumeSessionId
            ? (savedViewCursor ?? null)
            : (stringField(asRecord(result)["viewCursor"]) ?? null),
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    sessions.set(input.threadId, {
      session,
      sessionId,
      effort: getModelSelectionStringOptionValue(input.modelSelection, "effort"),
      activeTurnId: null,
      interrupted: new Set(),
      openItems: new Set(),
      pendingSteers: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      contextUsedTokens: undefined,
      contextWindowTokens: undefined,
      spend: 0,
      unpricedCompletions: 0,
      gapFill: null,
      viewCursor:
        hasSavedViewCursor && sessionId === resumeSessionId
          ? savedViewCursor
          : stringField(asRecord(result)["viewCursor"]),
      seenViewCursors: new Set(),
      pricedViewCursors: new Set(),
      streamedItems: new Map(),
      lastProgressAtMs: clock.currentTimeMillisUnsafe(),
      lastReconcileAtMs: clock.currentTimeMillisUnsafe(),
      retrySinceMs: null,
      viewBacklog: false,
      pendingPageCursor: undefined,
      historicalReplayPending: false,
      pageOnlyView: false,
      pageCursor: undefined,
      pendingPageTerminal: null,
    });
    threadsBySessionId.set(sessionId, input.threadId);
    emit({
      ...base(input.threadId),
      type: "session.started",
      payload: { resume: session.resumeCursor },
    });
    const context = sessions.get(input.threadId);
    seedUsageFromSnapshot(context, result);
    // Prices are needed before the first completion can be costed; loading
    // them here keeps the notification path synchronous.
    yield* ensureCatalog;
    if (context) {
      if (hasSavedViewCursor && sessionId === resumeSessionId) {
        yield* reconcileView(context, true);
        context.historicalReplayPending = context.viewBacklog;
        // Historical page starts describe the past. The owning host's resume
        // result decides whether there is a foreground turn to steer now.
        const activeTurnId = stringField(asRecord(asRecord(result)["session"])["activeTurnId"]);
        context.activeTurnId = activeTurnId ? TurnId.make(activeTurnId) : null;
        context.session = {
          ...context.session,
          status: activeTurnId ? "running" : "ready",
          activeTurnId: context.activeTurnId ?? undefined,
        };
      }
      if (!context.viewBacklog) yield* subscribeView(context);
      yield* monitorTurn(context).pipe(Effect.forkIn(scope));
    }
    if (context && resumeSessionId !== null) {
      // Forked: the pages answer on the read loop this call would otherwise
      // hold, and a long session's backfill must not delay the first turn.
      yield* backfillSpend(context, stringField(asRecord(result)["viewCursor"])).pipe(
        Effect.forkIn(scope),
      );
    }
    return context?.session ?? session;
  });

  /**
   * The turn's content parts.
   *
   * MSP takes images as first-class input parts, so an attachment is sent as
   * the image itself rather than as a filesystem path the model has to go and
   * read - which is all a one-shot CLI can offer.
   */
  const buildInput = Effect.fn("MuseAdapter.buildInput")(function* (input: {
    readonly input?: string | undefined;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  }) {
    const parts: Array<Record<string, unknown>> = [];
    // Build/Plan/Agent as a leading text part: MSP has no system-prompt or
    // permission-mode channel, so this is the only place the mode can be
    // stated. It leads so the rules are in force before the request is read.
    const modeInstructions = collaborationModePrompt(input.interactionMode);
    if (modeInstructions !== undefined) {
      parts.push({ type: "text", text: modeInstructions });
    }
    const text = input.input?.trim();
    if (text && text.length > 0) {
      parts.push({ type: "text", text });
    }
    const attachmentsDir = config.attachmentsDir;
    if (attachmentsDir !== undefined) {
      for (const attachment of input.attachments ?? []) {
        const resolved = resolveAttachmentPath({ attachmentsDir, attachment });
        if (!resolved) continue;
        // A missing or unreadable attachment must not take the turn down with
        // it: the prompt is still worth sending.
        const encoded = yield* fs.readFile(resolved).pipe(
          Effect.map((bytes) => Buffer.from(bytes).toString("base64")),
          Effect.orElseSucceed(() => ""),
        );
        if (encoded.length === 0) continue;
        parts.push({
          type: "image",
          base64Data: encoded,
          mediaType: attachment.mimeType,
        });
      }
    }
    return parts;
  });

  const sendTurn: ProviderAdapterShape<ProviderAdapterRequestError>["sendTurn"] = Effect.fn(
    "MuseAdapter.sendTurn",
  )(function* (input, options) {
    const context = sessions.get(input.threadId);
    if (!context) return yield* error("sendTurn", "Session not found.");
    const parts = yield* buildInput(input);
    // Counts prompt parts only: a mode block alone is not a turn worth sending.
    if (!input.input?.trim() && (input.attachments ?? []).length === 0) {
      return yield* error("sendTurn", "A text prompt is required.");
    }
    if (parts.length === 0) return yield* error("sendTurn", "A text prompt is required.");
    const effort =
      getModelSelectionStringOptionValue(input.modelSelection, "effort") ?? context.effort;
    const reasoningEffort = museReasoningEffort(effort);
    context.effort = effort;

    // A mid-turn message joins the running turn natively. `expectedTurnId`
    // closes the race where the turn ends between the caller's read and this
    // call, so input meant for one turn can never leak into the next.
    if (input.liveSteerTarget) {
      const expectedTurnId = input.liveSteerTarget.activeTurnId;
      const steerCommandId = commandId();
      const settled = yield* Deferred.make<void, ProviderAdapterRequestError>();
      context.pendingSteers.set(steerCommandId, {
        turnId: expectedTurnId,
        messageId: input.messageId,
        settled,
      });
      yield* request("turn/steer", {
        commandId: steerCommandId,
        sessionId: context.sessionId,
        expectedTurnId,
        input: parts,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }).pipe(
        Effect.tapError(() => Effect.sync(() => context.pendingSteers.delete(steerCommandId))),
      );
      yield* options?.onNativeDispatch ?? Effect.void;
      // An accepted steer is a promise, not a receipt. The message is delivered
      // once it appears inside the turn (`userMessage` item naming this command
      // id, receipted in `settleAbsorbedSteer`); a turn that ends first dropped
      // it, and failing here is what makes the caller send it as a fresh turn.
      yield* Deferred.await(settled).pipe(
        // Bounded like every other wait on the host, and for the same reason:
        // the deferred is settled from inside the read loop, and a wait raced
        // against the clock is resumed through the scheduler rather than on
        // the reader's own stack.
        Effect.timeout(STEER_ABSORPTION_TIMEOUT),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            error("turn/steer", "Muse never showed the steered message inside the turn."),
          ),
        ),
        Effect.ensuring(Effect.sync(() => context.pendingSteers.delete(steerCommandId))),
      );
      return {
        threadId: input.threadId,
        turnId: expectedTurnId,
        resumeCursor: context.session.resumeCursor,
      };
    }

    // Persist the pre-admission anchor, never a later cursor whose published
    // events may still be waiting for durable client projection.
    context.session = {
      ...context.session,
      resumeCursor: {
        sessionId: context.sessionId,
        deliveryCursorVersion: DELIVERY_CURSOR_VERSION,
        viewCursor: (context.pageOnlyView ? context.pageCursor : context.viewCursor) ?? null,
      },
    };
    const result = yield* request("turn/start", {
      commandId: commandId(),
      sessionId: context.sessionId,
      input: parts,
      // Queue rather than replace: a second message must never silently
      // discard the turn already running.
      ifBusy: "queue",
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(input.input?.trim() ? { displayText: input.input.trim() } : {}),
    });
    const turnIdRaw = stringField(asRecord(result)["turnId"]);
    if (!turnIdRaw) return yield* error("sendTurn", "Muse did not return a turn id.");
    const turnId = TurnId.make(turnIdRaw);
    context.activeTurnId = turnId;
    context.lastProgressAtMs = clock.currentTimeMillisUnsafe();
    context.lastReconcileAtMs = clock.currentTimeMillisUnsafe();
    context.retrySinceMs = null;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: now(),
    };
    emit({
      ...base(input.threadId, turnId),
      type: "turn.started",
      payload: context.session.model ? { model: context.session.model } : {},
    });
    yield* options?.onNativeDispatch ?? Effect.void;
    if (input.messageId)
      emit({
        ...base(input.threadId, turnId),
        type: "message.delivered",
        payload: { messageId: input.messageId },
      });
    return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
  });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterRequestError>["interruptTurn"] =
    Effect.fn("MuseAdapter.interruptTurn")(function* (threadId, turnId) {
      const context = sessions.get(threadId);
      if (!context) return;
      const target = turnId ?? context.activeTurnId;
      if (!target) return;
      context.interrupted.add(target);
      yield* request("turn/interrupt", {
        commandId: commandId(),
        sessionId: context.sessionId,
        turnId: target,
      }).pipe(Effect.ignore);
    });

  const respondToRequest: ProviderAdapterShape<ProviderAdapterRequestError>["respondToRequest"] =
    Effect.fn("MuseAdapter.respondToRequest")(function* (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) {
      const context = sessions.get(threadId);
      if (!context) return yield* error("approval/decide", "Session not found.");
      const approvalId = String(requestId);
      const approval = context.pendingApprovals.get(approvalId);
      if (!approval) {
        return yield* error("approval/decide", "Muse is not waiting on this approval.");
      }
      const choiceId = museApprovalChoice(approval, decision);
      if (!choiceId) {
        return yield* error(
          "approval/decide",
          `Muse offered no choice matching "${decision}" for this approval.`,
        );
      }
      yield* request("approval/decide", {
        commandId: commandId(),
        sessionId: context.sessionId,
        approvalId,
        requirementId: approval.requirementId,
        choiceId,
      });
    });

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterRequestError>["respondToUserInput"] =
    Effect.fn("MuseAdapter.respondToUserInput")(function* (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) {
      const context = sessions.get(threadId);
      if (!context) return yield* error("userInput/answer", "Session not found.");
      const userInputId = String(requestId);
      const pendingInput = context.pendingUserInputs.get(userInputId);
      if (!pendingInput) {
        return yield* error("userInput/answer", "Muse is not waiting on this user input.");
      }
      const museAnswers = pendingInput.questions.map((question) => {
        const raw = answers[question.id] ?? answers[question.header] ?? answers[question.question];
        const values = answerValues(raw);
        if (question.multiSelect) return { questionId: question.id, selectedLabels: values };
        const value = values[0];
        if (!value) return { questionId: question.id, freeText: "" };
        const labels = new Set(question.options.map((option) => option.label));
        return labels.has(value)
          ? { questionId: question.id, selectedLabel: value }
          : { questionId: question.id, freeText: value };
      });
      yield* request("userInput/answer", {
        commandId: commandId(),
        sessionId: context.sessionId,
        userInputId,
        answers: museAnswers,
      });
    });

  const stopSession = Effect.fn("MuseAdapter.stopSession")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (!context) return;
    yield* interruptTurn(threadId);
    sessions.delete(threadId);
    threadsBySessionId.delete(context.sessionId);
    failAllPendingSteers(
      context,
      "The Muse session was stopped before it took the steered message.",
    );
    emit({
      ...base(threadId),
      type: "session.exited",
      payload: { reason: "Session stopped.", recoverable: true, exitKind: "graceful" },
    });
  });

  const stopAll = Effect.fn("MuseAdapter.stopHost")(function* () {
    yield* Effect.forEach([...sessions.keys()], stopSession, { discard: true });
    const handle = connection;
    connection = null;
    if (handle)
      yield* handle.kill().pipe(
        Effect.andThen(handle.exitCode),
        Effect.timeout("2 seconds"),
        Effect.catch(() => handle.kill({ killSignal: "SIGKILL" })),
        Effect.ignore,
      );
  });
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));

  const adapter: MuseAdapterShape = {
    provider: MUSE_DRIVER_KIND,
    capabilities: {
      sessionModelSwitch: "in-session",
      // MSP carries steering on the wire: `turn/steer` with an expected turn
      // id, so a mid-turn message joins the running turn.
      liveSteering: "native",
      taskStop: false,
      threadRollback: false,
      threadFork: false,
      textGeneration: false,
      messageDeliveryReceipts: true,
    },
    startSession,
    sendTurn,
    interruptTurn,
    stopSession,
    stopAll,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId: ThreadId) =>
      Effect.sync(() => connection !== null && sessions.has(threadId)),
    respondToRequest,
    respondToUserInput,
    readThread: () => unsupported("native transcript read"),
    rollbackThread: () => unsupported("rollback"),
    streamEvents: Stream.fromPubSub(events),
    // `listModels` rides alongside the adapter surface rather than in it: the
    // catalog is served by the same MSP host, and only this driver reads it.
    listModels,
  };
  const readStoredPage = Effect.fn("MuseAdapter.readStoredPage")(function* (
    params: Record<string, unknown>,
  ) {
    yield* connect();
    return yield* request("view/page", params);
  });
  return { ...adapter, readStoredPage };
});

/**
 * Muse fixes sandbox posture at process startup and exposes no session unload.
 * Keep a scoped host per thread so changing one grant never changes another,
 * and close it before resuming that thread with a different grant.
 */
export const makeMuseAdapter = Effect.fn("makeMuseAdapter")(function* (
  config: Omit<Parameters<typeof makeMuseHostAdapter>[0], "disableSandbox">,
) {
  const events = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const catalog = yield* makeMuseHostAdapter(config);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const hosts = new Map<
    ThreadId,
    {
      adapter: MuseAdapterShape;
      scope: Scope.Closeable;
      session: ProviderSession;
    }
  >();
  const sessionMutex = yield* Semaphore.make(1);
  const missing = (method: string) =>
    new ProviderAdapterRequestError({
      provider: MUSE_DRIVER_KIND,
      method,
      detail: "Session not found.",
    });
  const stopSession = Effect.fn("MuseAdapter.stopScopedSession")(function* (threadId: ThreadId) {
    const host = hosts.get(threadId);
    if (!host) return;
    hosts.delete(threadId);
    yield* host.adapter
      .stopSession(threadId)
      .pipe(Effect.ensuring(Scope.close(host.scope, Exit.void)));
  });
  const stopAll = () =>
    Effect.forEach([...hosts.keys()], stopSession, { discard: true }).pipe(
      Effect.andThen(catalog.stopAll()),
    );
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));
  const startSession: MuseAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const existing = hosts.get(input.threadId);
      const current = existing
        ? (yield* existing.adapter.listSessions()).find(
            (session) => session.threadId === input.threadId,
          )
        : undefined;
      if (
        existing &&
        current?.runtimeMode === input.runtimeMode &&
        (yield* existing.adapter.hasSession(input.threadId))
      )
        return current;
      const resumeCursor =
        input.resumeCursor ?? current?.resumeCursor ?? existing?.session.resumeCursor;
      if (existing) yield* stopSession(input.threadId);
      const hostScope = yield* Scope.make();
      const host = yield* makeMuseHostAdapter({
        ...config,
        disableSandbox: input.runtimeMode === "full-access",
        readStoredPage: catalog.readStoredPage,
      }).pipe(
        Effect.provideService(Scope.Scope, hostScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.onError(() => Scope.close(hostScope, Exit.void)),
      );
      yield* host.streamEvents.pipe(
        Stream.runForEach((event) => PubSub.publish(events, event)),
        Effect.forkIn(hostScope),
      );
      const session = yield* host
        .startSession({ ...input, ...(resumeCursor ? { resumeCursor } : {}) })
        .pipe(Effect.onError(() => Scope.close(hostScope, Exit.void)));
      hosts.set(input.threadId, { adapter: host, scope: hostScope, session });
      return session;
    }).pipe(sessionMutex.withPermit);
  const replayStoredTranscript = Effect.fn("MuseAdapter.replayStoredTranscript")(function* (input: {
    readonly threadId: ThreadId;
    readonly sessionId: string;
  }) {
    // Read from the durable tail so a long conversation cannot strand its
    // newest missing reply beyond a bounded first-page sweep. Backward pages
    // are internally chronological; reverse only their batch order below.
    const pages: Array<ReadonlyArray<unknown>> = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_GAP_FILL_PAGES; page += 1) {
      const result = asRecord(
        yield* catalog.readStoredPage({
          sessionId: input.sessionId,
          direction: "backward",
          limit: GAP_FILL_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        }),
      );
      pages.push(Array.isArray(result["events"]) ? result["events"] : []);
      const next = stringField(result["nextCursor"]);
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    let count = 0;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const emitted = new Set<string>();
    for (const page of pages.toReversed()) {
      for (const raw of page) {
        const entry = asRecord(raw);
        const params = asRecord(entry["params"]);
        const item = asRecord(params["item"]);
        const cursor = stringField(params["viewCursor"]);
        const itemId = stringField(item["itemId"]);
        const turnId = stringField(item["turnId"]);
        const detail = stringField(item["text"]);
        if (
          entry["method"] !== "item/completed" ||
          params["sessionId"] !== input.sessionId ||
          item["kind"] !== "agentMessage" ||
          item["status"] !== "completed" ||
          isIncompleteViewTail("item/completed", params) ||
          !cursor ||
          !itemId ||
          !turnId ||
          !detail
        )
          continue;
        const eventId = EventId.make(
          `muse:${config.instanceId}:${input.threadId}:${cursor}:item.completed:${itemId}`,
        );
        if (emitted.has(eventId)) continue;
        emitted.add(eventId);
        const recordedAt = stringField(item["recordedAt"]);
        const recordedAtMs = recordedAt ? Date.parse(recordedAt) : Number.NaN;
        yield* PubSub.publish(events, {
          eventId,
          provider: MUSE_DRIVER_KIND,
          providerInstanceId: config.instanceId,
          threadId: input.threadId,
          turnId: TurnId.make(turnId),
          itemId: RuntimeItemId.make(itemId),
          createdAt: Number.isFinite(recordedAtMs)
            ? DateTime.formatIso(DateTime.makeUnsafe(recordedAtMs))
            : createdAt,
          historicalReplay: true,
          type: "item.completed",
          payload: { itemType: "assistant_message", detail },
        });
        count += 1;
      }
    }
    return count;
  });
  const adapter: MuseAdapterShape = {
    ...catalog,
    replayStoredTranscript,
    startSession,
    sendTurn: (input, options) =>
      hosts.get(input.threadId)?.adapter.sendTurn(input, options) ??
      Effect.fail(missing("sendTurn")),
    interruptTurn: (threadId, turnId) =>
      hosts.get(threadId)?.adapter.interruptTurn(threadId, turnId) ?? Effect.void,
    respondToRequest: (threadId, requestId, decision) =>
      hosts.get(threadId)?.adapter.respondToRequest(threadId, requestId, decision) ??
      Effect.fail(missing("respondToRequest")),
    stopSession: (threadId) => stopSession(threadId).pipe(sessionMutex.withPermit),
    stopAll: () => stopAll().pipe(sessionMutex.withPermit),
    listSessions: () =>
      Effect.forEach([...hosts.values()], (host) => host.adapter.listSessions()).pipe(
        Effect.map((sessions) => sessions.flat()),
      ),
    hasSession: (threadId) =>
      hosts.get(threadId)?.adapter.hasSession(threadId) ?? Effect.succeed(false),
    streamEvents: Stream.fromPubSub(events),
  };
  return adapter;
});

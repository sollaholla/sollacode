import type {
  OrchestrationEvent,
  OrchestrationLiveBeat,
  OrchestrationLiveBeatKind,
  OrchestrationLiveFeedEvent,
  OrchestrationThreadActivity,
  ThreadId,
  ToolLifecycleItemType,
} from "@t3tools/contracts";
import { appendAgentStreamText } from "@t3tools/shared/agentMode";
import { LIVE_FEED_WINDOW, upsertLiveBeats } from "@t3tools/shared/liveFeed";
import {
  classifyToolActivity,
  deriveToolActivityPresentation,
  type ToolActivityAction,
} from "@t3tools/shared/toolActivity";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const TITLE_MAX = 80;
const DETAIL_MAX = 240;
const COMMAND_MAX = 160;
/** A reply's opening is what gets shown; the rest of a long reply is never kept. */
const REPLY_HEAD_MAX = 600;
/** A reply being written is resent at most this often, so streaming text stays cheap. */
const REPLY_UPDATE_MIN_MS = 1_500;
/** Running tools and unfinished replies remembered; an interrupted turn never finishes its own. */
const PENDING_LIMIT = 256;

interface PendingBeat {
  readonly beatId: string;
  readonly at: string;
  shown: string | null;
}

interface ReplyDraft extends PendingBeat {
  text: string;
  shownAtMs: number;
}

/** What the mapping remembers between events: running tools and replies being written. */
export interface LiveFeedState {
  readonly running: Map<string, PendingBeat>;
  readonly replies: Map<string, ReplyDraft>;
}

export function makeLiveFeedState(): LiveFeedState {
  return { running: new Map(), replies: new Map() };
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > PENDING_LIMIT) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Cuts text to `max` characters, at a word boundary when one is close. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${boundary > max * 0.6 ? cut.slice(0, boundary) : cut}…`;
}

/** Prose without its markdown: what someone reading over a shoulder would see. */
export function plainSnippet(value: string, max: number): string | null {
  const plain = value
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(?<!\w)(__|_|\*)(?=\S)([\s\S]*?\S)\1(?!\w)/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length === 0 ? null : clip(plain, max);
}

/** The part of a command worth reading: no leading `cd`, and only its first line. */
export function commandSnippet(command: string | undefined): string | null {
  if (command === undefined) return null;
  const withoutCd = command.replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "");
  const lines = withoutCd
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = (lines[0] ?? "").replace(/\s+/g, " ");
  if (first.length === 0) return null;
  return clip(lines.length > 1 ? `${first} …` : first, COMMAND_MAX);
}

/** A path short enough to read: its last three parts when the whole is long. */
export function pathSnippet(path: string | undefined): string | null {
  if (path === undefined) return null;
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (path.length <= 60 || segments.length <= 3) return clip(path, DETAIL_MAX);
  return clip(`…/${segments.slice(-3).join("/")}`, DETAIL_MAX);
}

/** "mcp__t3-code__preview_evaluate" → "preview evaluate", "WebFetch" → "web fetch". */
export function toolLabel(name: string): string {
  const parts = name.split("__");
  const bare = parts[0] === "mcp" && parts.length >= 3 ? parts.slice(2).join(" ") : name;
  return bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const TOOL_BEAT_KIND: Record<ToolActivityAction, OrchestrationLiveBeatKind> = {
  command: "command",
  read: "read",
  file_change: "edit",
  search: "search",
  think: "think",
  other: "tool",
};

const TOOL_VERBS: Partial<Record<OrchestrationLiveBeatKind, readonly [string, string]>> = {
  command: ["Running", "Ran"],
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  search: ["Searching", "Searched"],
  think: ["Thinking", "Thought it through"],
};

/** A tool's input without its output: results can be megabytes of text or image data. */
function withoutOutput(data: Record<string, unknown> | undefined) {
  if (data === undefined) return undefined;
  const {
    result: _result,
    output: _output,
    rawOutput: _rawOutput,
    content: _content,
    ...rest
  } = data;
  return rest;
}

/** "WebFetch: {...}" says nothing a person can read; a plain detail survives. */
function readableToolDetail(detail: string | undefined): string | undefined {
  const bare = detail?.replace(/^[\w.-]+:\s*/, "");
  return bare === undefined || bare.startsWith("{") || bare.startsWith("[") ? undefined : bare;
}

function toolDetail(
  kind: OrchestrationLiveBeatKind,
  presented: string | undefined,
  data: Record<string, unknown> | undefined,
): string | null {
  const input = asRecord(data?.input) ?? asRecord(data?.rawInput);
  switch (kind) {
    case "command":
      return commandSnippet(presented ?? text(input?.command));
    case "read":
    case "edit":
      return pathSnippet(presented ?? text(input?.file_path) ?? text(input?.path));
    case "think":
      return null;
    default: {
      const found =
        text(input?.query) ??
        text(input?.pattern) ??
        text(input?.url) ??
        text(input?.description) ??
        text(input?.prompt) ??
        text(input?.file_path) ??
        text(input?.path) ??
        readableToolDetail(presented);
      return found === undefined ? null : clip(found.replace(/\s+/g, " "), DETAIL_MAX);
    }
  }
}

function toolBeat(
  state: LiveFeedState,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | undefined,
): OrchestrationLiveBeat | null {
  const rawDetail = text(payload?.detail);
  const data = withoutOutput(asRecord(payload?.data));
  const input = {
    itemType: text(payload?.itemType) as ToolLifecycleItemType | undefined,
    title: text(payload?.title),
    detail: rawDetail,
    data,
    fallbackSummary: activity.summary,
  };
  const kind = TOOL_BEAT_KIND[classifyToolActivity(input)];
  const detail = toolDetail(kind, deriveToolActivityPresentation(input).detail, data);
  const declaredName = text(data?.toolName);
  const label = declaredName ? toolLabel(declaredName) : "a tool";
  const [running, finished] = TOOL_VERBS[kind] ?? [`Using ${label}`, `Used ${label}`];
  // No provider id joins a tool's updates to its completion, but both carry
  // the same input, so what the beat shows is what ties the two together.
  const key = [threadId, kind, detail ?? rawDetail ?? activity.summary].join("\n");
  const pending = state.running.get(key);

  if (activity.kind !== "tool.completed") {
    // A call's first event often carries no input yet ("Bash: {}"); wait for one that does.
    if (detail === null && kind !== "think") return null;
    if (pending !== undefined && pending.shown === detail) return null;
    const entry = pending ?? { beatId: activity.id, at: activity.createdAt, shown: null };
    entry.shown = detail;
    remember(state.running, key, entry);
    return {
      id: entry.beatId,
      threadId,
      kind,
      title: running,
      detail,
      live: true,
      at: entry.at,
    };
  }

  state.running.delete(key);
  return {
    id: pending?.beatId ?? activity.id,
    threadId,
    kind,
    title: finished,
    detail,
    live: false,
    at: pending?.at ?? activity.createdAt,
  };
}

function approvalTitle(requestKind: string | undefined): string {
  switch (requestKind) {
    case "command":
      return "Wants approval to run a command";
    case "file-read":
      return "Wants approval to read a file";
    case "file-change":
      return "Wants approval to change files";
    default:
      return "Wants your approval";
  }
}

function firstQuestion(payload: Record<string, unknown> | undefined): string | undefined {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) return undefined;
  return text(asRecord(questions[0])?.question);
}

function taskBeat(
  state: LiveFeedState,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | undefined,
): OrchestrationLiveBeat | null {
  const taskId = text(payload?.taskId);
  const key = taskId === undefined ? undefined : [threadId, "task", taskId].join("\n");
  const detailText = text(payload?.detail) ?? text(payload?.title) ?? activity.summary;
  const detail = clip(detailText.replace(/\s+/g, " "), DETAIL_MAX);
  if (activity.kind === "task.started") {
    const entry = { beatId: activity.id, at: activity.createdAt, shown: detail };
    if (key !== undefined) remember(state.running, key, entry);
    return {
      id: entry.beatId,
      threadId,
      kind: "task",
      title: "Working in the background",
      detail,
      live: true,
      at: entry.at,
    };
  }
  const pending = key === undefined ? undefined : state.running.get(key);
  if (key !== undefined) state.running.delete(key);
  const failed = payload?.status === "failed" || activity.tone === "error";
  // Every finished task reports in, most as "Task stopped": only tasks whose
  // start was seen, or that failed, are worth a line.
  if (pending === undefined && !failed) return null;
  return {
    id: pending?.beatId ?? activity.id,
    threadId,
    kind: failed ? "error" : "task",
    title: failed ? "A background task failed" : "Finished in the background",
    detail,
    live: false,
    at: pending?.at ?? activity.createdAt,
  };
}

function activityBeat(
  state: LiveFeedState,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
): OrchestrationLiveBeat | null {
  const payload = asRecord(activity.payload);
  const simple = (
    kind: OrchestrationLiveBeatKind,
    title: string,
    detail: string | undefined,
  ): OrchestrationLiveBeat => ({
    id: activity.id,
    threadId,
    kind,
    title: clip(title, TITLE_MAX),
    detail: detail === undefined ? null : clip(detail.replace(/\s+/g, " "), DETAIL_MAX),
    live: false,
    at: activity.createdAt,
  });

  switch (activity.kind) {
    case "tool.started":
    case "tool.updated":
    case "tool.completed":
      return toolBeat(state, threadId, activity, payload);
    case "task.started":
    case "task.completed":
      return taskBeat(state, threadId, activity, payload);
    case "approval.requested":
      return simple("attention", approvalTitle(text(payload?.requestKind)), text(payload?.detail));
    case "user-input.requested":
      return simple("attention", "Asked you a question", firstQuestion(payload));
    case "context-compaction":
      return simple("notice", "Compacted its context to keep going", undefined);
    case "provider.failover.completed":
    case "provider.handoff.completed":
    case "provider.silence.restart":
      return simple("notice", activity.summary, undefined);
    default:
      return activity.tone === "error"
        ? simple("error", activity.summary, text(payload?.message) ?? text(payload?.detail))
        : null;
  }
}

function epochMillis(iso: string): number {
  return DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
}

type MessageSentPayload = Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"];

function messageBeat(
  state: LiveFeedState,
  payload: MessageSentPayload,
): OrchestrationLiveBeat | null {
  if (payload.role === "user") {
    if (payload.streaming) return null;
    const words = plainSnippet(payload.text, DETAIL_MAX);
    if (words === null) return null;
    return {
      id: payload.messageId,
      threadId: payload.threadId,
      kind: "asked",
      title:
        payload.senderThreadTitle !== undefined
          ? clip(`Message from ${payload.senderThreadTitle}`, TITLE_MAX)
          : // Spoken turns with the orchestrator are recorded as messages too.
            payload.voiceTranscript === true
            ? "You said"
            : "You wrote",
      detail: words,
      live: false,
      at: payload.createdAt,
    };
  }
  if (payload.role !== "assistant") return null;

  const draft = state.replies.get(payload.messageId);
  const previous = draft?.text ?? "";
  const next =
    payload.textMode === "replace"
      ? payload.text
      : payload.streaming
        ? // Only the opening is shown; once it is long enough, later text is ignored.
          previous.length >= REPLY_HEAD_MAX
          ? previous
          : appendAgentStreamText(previous, payload.text)
        : payload.text.length > 0
          ? payload.text
          : previous;
  const head = next.slice(0, REPLY_HEAD_MAX);
  const words = plainSnippet(head, DETAIL_MAX);
  const entry = draft ?? {
    beatId: payload.messageId,
    at: payload.createdAt,
    shown: null,
    text: "",
    shownAtMs: 0,
  };
  const beat = (live: boolean): OrchestrationLiveBeat => ({
    id: entry.beatId,
    threadId: payload.threadId,
    kind: "said",
    title: "Said",
    detail: words,
    live,
    at: entry.at,
  });

  if (!payload.streaming) {
    // Always sent when there are words, even unchanged: it is what ends the live state.
    state.replies.delete(payload.messageId);
    return words === null ? null : beat(false);
  }
  entry.text = head;
  remember(state.replies, payload.messageId, entry);
  if (words === null || words === entry.shown) return null;
  const updatedMs = epochMillis(payload.updatedAt);
  if (entry.shown !== null && updatedMs - entry.shownAtMs < REPLY_UPDATE_MIN_MS) return null;
  entry.shown = words;
  entry.shownAtMs = updatedMs;
  return beat(true);
}

/**
 * The beats one domain event adds or changes. Most events add none: only what
 * a person watching would notice is kept, cut to a line, and a tool's output
 * is never read at all.
 */
export function beatsForEvent(
  state: LiveFeedState,
  event: OrchestrationEvent,
): ReadonlyArray<OrchestrationLiveBeat> {
  switch (event.type) {
    case "thread.activity-appended": {
      if (event.payload.historicalReplay === true) return [];
      const beat = activityBeat(state, event.payload.threadId, event.payload.activity);
      return beat === null ? [] : [beat];
    }
    case "thread.message-sent": {
      if (event.payload.historicalReplay === true) return [];
      const beat = messageBeat(state, event.payload);
      return beat === null ? [] : [beat];
    }
    default:
      return [];
  }
}

export class LiveFeed extends Context.Service<
  LiveFeed,
  {
    /** The recent beats as one snapshot, then every new or changed beat while subscribed. */
    readonly stream: Stream.Stream<OrchestrationLiveFeedEvent>;
  }
>()("t3/orchestration/LiveFeed") {}

export const layer = Layer.effect(
  LiveFeed,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const recent = yield* Ref.make<ReadonlyArray<OrchestrationLiveBeat>>([]);
    // Sliding: a viewer on a slow link loses old beats, never holds up the rest.
    const beats = yield* PubSub.sliding<OrchestrationLiveBeat>(512);
    const state = makeLiveFeedState();

    yield* engine.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => beatsForEvent(state, event)).pipe(
          Effect.flatMap((changed) =>
            changed.length === 0
              ? Effect.void
              : Ref.update(recent, (current) =>
                  upsertLiveBeats(current, changed, LIVE_FEED_WINDOW),
                ).pipe(Effect.andThen(PubSub.publishAll(beats, changed))),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("live feed skipped an event", { type: event.type, cause }),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    const stream = Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the snapshot is read, so a beat landing in between
        // arrives twice rather than never; viewers replace beats by id.
        const subscription = yield* PubSub.subscribe(beats);
        const snapshot = yield* Ref.get(recent);
        return Stream.concat(
          Stream.succeed<OrchestrationLiveFeedEvent>({ type: "snapshot", beats: snapshot }),
          Stream.fromSubscription(subscription).pipe(
            Stream.map((beat): OrchestrationLiveFeedEvent => ({ type: "beat", beat })),
          ),
        );
      }),
    );

    return LiveFeed.of({ stream });
  }),
);

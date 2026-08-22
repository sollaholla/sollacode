/**
 * Reading and searching the contents of threads.
 *
 * The orchestrator could route work to a thread and report its status, but not
 * read a single word any thread had said — so "what did the Vera Medical thread
 * find?" could only be answered by sending it a message and waiting for it to
 * repeat itself. These are the shaping helpers behind the `read_thread` and
 * `search_threads` tools; fetching is the caller's, so this file stays pure and
 * directly testable.
 */

/** One message as the model sees it. Ids are omitted: they are unspeakable. */
export interface SpokenThreadMessage {
  readonly role: string;
  readonly text: string;
  /** Groups messages into turns so "the last turn" is answerable. */
  readonly turn: number | null;
  readonly at: string;
}

export interface SpokenThreadActivity {
  readonly kind: string;
  readonly summary: string;
  readonly tone: string;
  readonly turn: number | null;
  readonly at: string;
}

export interface ThreadHistoryMessageInput {
  readonly role: string;
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
  readonly createdAt: string;
}

export interface ThreadHistoryActivityInput {
  readonly kind: string;
  readonly summary: string;
  readonly tone: string;
  readonly turnId: string | null;
  readonly createdAt: string;
}

/** Spoken answers cannot carry a wall of text; long messages are cut. */
export const MAX_SPOKEN_MESSAGE_CHARS = 1_500;
/** Matches carry less context than a full read, so they are cut harder. */
export const MAX_SNIPPET_CHARS = 320;
export const DEFAULT_MESSAGE_LIMIT = 20;
export const MAX_MESSAGE_LIMIT = 60;
export const DEFAULT_SEARCH_LIMIT = 12;
export const MAX_SEARCH_LIMIT = 40;
/**
 * How many threads a single search will open. Every thread costs one HTTP
 * round trip, and a workspace can hold hundreds; the cap is reported rather
 * than applied silently so a partial answer is never mistaken for a complete
 * one.
 */
export const MAX_THREADS_PER_SEARCH = 15;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveLimit(requested: unknown, fallback: number, maximum: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return fallback;
  return clamp(Math.floor(requested), 1, maximum);
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

/**
 * Turn ids are opaque strings. Numbering them per thread gives the model
 * something it can actually say out loud — "in turn three" rather than reading
 * out a UUID — while still grouping messages that belong together.
 */
function numberTurns(turnIds: ReadonlyArray<string | null>): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  for (const turnId of turnIds) {
    if (turnId === null || numbers.has(turnId)) continue;
    numbers.set(turnId, numbers.size + 1);
  }
  return numbers;
}

/** At most this many messages ride along with a status answer. */
export const STATUS_TAIL_MAX_MESSAGES = 3;
/** Each one cut harder than a full read: this decorates a status, it is not one. */
export const STATUS_TAIL_MESSAGE_CHARS = 280;
/**
 * Combined budget for the tail. The last message always ships even when it
 * alone exceeds this (truncated); earlier ones are added only while they fit,
 * which is what "the last two or three, if short enough" means in practice.
 */
export const STATUS_TAIL_BUDGET_CHARS = 600;

export interface StatusTailMessage {
  readonly role: string;
  readonly text: string;
  readonly at: string;
}

/**
 * The last few messages of a thread, sized to ride along with its status.
 *
 * Asking "what is that thread doing" used to return a state label and nothing
 * else, so every status answer that mattered needed a second read_thread call —
 * and usually got answered without one, from nothing. The tail gives the model
 * the thread's actual last words: what it just said, what the user last asked,
 * the error it reported.
 *
 * Streaming and empty rows are dropped for the same reasons as readThreadHistory.
 */
export function statusMessageTail(
  messages: ReadonlyArray<ThreadHistoryMessageInput>,
): ReadonlyArray<StatusTailMessage> {
  const usable = messages.filter((message) => !message.streaming && message.text.trim().length > 0);
  const candidates = usable.slice(-STATUS_TAIL_MAX_MESSAGES).map((message) => ({
    role: message.role,
    text: truncate(message.text, STATUS_TAIL_MESSAGE_CHARS),
    at: message.createdAt,
  }));

  const kept: Array<StatusTailMessage> = [];
  let spent = 0;
  // Newest first: when the budget cuts, it is the older context that goes.
  for (const entry of [...candidates].reverse()) {
    if (kept.length > 0 && spent + entry.text.length > STATUS_TAIL_BUDGET_CHARS) break;
    kept.unshift(entry);
    spent += entry.text.length;
  }
  return kept;
}

export interface ReadThreadHistoryResult {
  readonly messages: ReadonlyArray<SpokenThreadMessage>;
  readonly activities: ReadonlyArray<SpokenThreadActivity>;
  readonly totalMessages: number;
  /** True when older messages exist above the returned window. */
  readonly truncated: boolean;
}

/**
 * The tail of a thread's conversation.
 *
 * Streaming rows are dropped: a half-written message read aloud is worse than
 * silence, and it changes under the reader. Empty rows go too — a message whose
 * whole content was an attachment carries nothing spoken.
 */
export function readThreadHistory(input: {
  readonly messages: ReadonlyArray<ThreadHistoryMessageInput>;
  readonly activities?: ReadonlyArray<ThreadHistoryActivityInput>;
  readonly limit: number;
  readonly includeActivities: boolean;
}): ReadThreadHistoryResult {
  const usable = input.messages.filter(
    (message) => !message.streaming && message.text.trim().length > 0,
  );
  const turnNumbers = numberTurns(usable.map((message) => message.turnId));
  const window = usable.slice(-input.limit);

  const activities = input.includeActivities
    ? (input.activities ?? [])
        .filter((activity) => activity.summary.trim().length > 0)
        .slice(-input.limit)
        .map((activity) => ({
          kind: activity.kind,
          summary: truncate(activity.summary, MAX_SNIPPET_CHARS),
          tone: activity.tone,
          turn: activity.turnId === null ? null : (turnNumbers.get(activity.turnId) ?? null),
          at: activity.createdAt,
        }))
    : [];

  return {
    messages: window.map((message) => ({
      role: message.role,
      text: truncate(message.text, MAX_SPOKEN_MESSAGE_CHARS),
      turn: message.turnId === null ? null : (turnNumbers.get(message.turnId) ?? null),
      at: message.createdAt,
    })),
    activities,
    totalMessages: usable.length,
    truncated: usable.length > window.length,
  };
}

export interface ThreadSearchMatch {
  readonly thread: string;
  readonly project: string;
  /**
   * Where the match came from: a spoken/typed message, or a record in the
   * thread's activity log. Errors are activities, so a search for a failure
   * that was never repeated in a message still finds it.
   */
  readonly source: "message" | "activity";
  /** Message role, or the activity's kind ("error", "tool", …). */
  readonly role: string;
  /** True for activities the provider marked as failures. */
  readonly isError: boolean;
  readonly turn: number | null;
  readonly snippet: string;
  /** When the record was written — for an error, when it occurred. */
  readonly at: string;
}

/**
 * A snippet centred on the match rather than the start of the message.
 *
 * Returning the first N characters of a long message routinely omitted the very
 * text that matched, which reads as the search having found nothing.
 */
export function buildSnippet(text: string, matchIndex: number, matchLength: number): string {
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  if (collapsed.length <= MAX_SNIPPET_CHARS) return collapsed;

  // Re-locate the match: collapsing whitespace moved every index after it.
  const needle = text
    .slice(matchIndex, matchIndex + matchLength)
    .replaceAll(/\s+/gu, " ")
    .trim();
  const located = needle.length > 0 ? collapsed.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (located < 0) return truncate(collapsed, MAX_SNIPPET_CHARS);

  const context = Math.floor((MAX_SNIPPET_CHARS - needle.length) / 2);
  const start = Math.max(0, located - Math.max(context, 0));
  const end = Math.min(collapsed.length, start + MAX_SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${collapsed.slice(start, end)}${end < collapsed.length ? "…" : ""}`;
}

/**
 * Case-insensitive substring search over one thread's record.
 *
 * Messages and activities are searched as one index rather than two: an error
 * is an activity, and a search that only read messages could not find the
 * failure the user is asking about unless the agent happened to also write it
 * out in prose. Both carry their own timestamp, so an error is found at the
 * moment it occurred rather than at the next thing anyone said.
 */
export function searchThreadMessages(input: {
  readonly thread: string;
  readonly project: string;
  readonly messages: ReadonlyArray<ThreadHistoryMessageInput>;
  readonly activities?: ReadonlyArray<ThreadHistoryActivityInput>;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<ThreadSearchMatch> {
  const needle = input.query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const usable = input.messages.filter((message) => !message.streaming);
  // Numbered off the messages, so an activity reports the same turn number the
  // messages around it do.
  const turnNumbers = numberTurns([
    ...usable.map((message) => message.turnId),
    ...(input.activities ?? []).map((activity) => activity.turnId),
  ]);

  const candidates: Array<{
    readonly source: "message" | "activity";
    readonly role: string;
    readonly isError: boolean;
    readonly text: string;
    readonly turnId: string | null;
    readonly at: string;
  }> = [
    ...usable.map((message) => ({
      source: "message" as const,
      role: message.role,
      isError: false,
      text: message.text,
      turnId: message.turnId,
      at: message.createdAt,
    })),
    ...(input.activities ?? []).map((activity) => ({
      source: "activity" as const,
      role: activity.kind,
      isError: activity.tone === "error",
      text: activity.summary,
      turnId: activity.turnId,
      at: activity.createdAt,
    })),
  ];

  // Interleaved by their own timestamps: an error and the message that followed
  // it are minutes apart and must come back in the order they happened.
  candidates.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));

  const matches: Array<ThreadSearchMatch> = [];
  // Newest first: when a thread has said the same thing repeatedly, the most
  // recent occurrence is the one being asked about.
  for (let index = candidates.length - 1; index >= 0 && matches.length < input.limit; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const at = candidate.text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    matches.push({
      thread: input.thread,
      project: input.project,
      source: candidate.source,
      role: candidate.role,
      isError: candidate.isError,
      turn: candidate.turnId === null ? null : (turnNumbers.get(candidate.turnId) ?? null),
      snippet: buildSnippet(candidate.text, at, needle.length),
      at: candidate.at,
    });
  }

  return matches;
}

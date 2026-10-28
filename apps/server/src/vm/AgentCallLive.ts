// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  OPENAI_LIVE_MODEL,
  type AgentCallDirection,
  type AgentCallId,
  type AgentCallSessionStartInput,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestratorLiveDelegationInput,
  type OrchestratorLiveWorkEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { activeTurnWorkSourceId } from "../orchestration/agentModeContinuation.ts";
import { isStaleRequestFailureDetail } from "../orchestration/decider.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveOrchestratorApiKey } from "../orchestrator/OrchestratorCredentials.ts";
import {
  createGptLiveSession,
  liveVoiceFor,
  OrchestratorLiveError,
} from "../orchestrator/OrchestratorLive.ts";
import {
  ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
  ThreadWorkObligationRepository,
} from "../persistence/Services/ThreadWorkObligations.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { KIMI_DRIVER_KIND } from "../provider/acp/KimiAcpSupport.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AgentCalls } from "./AgentCalls.ts";

/** How much of the agent's reply is spoken before pointing at the chat. */
const SPOKEN_REPLY_MAX_CHARS = 1_500;
const MAX_CALL_SESSIONS = 32;
const SESSION_MAX_AGE_MS = 2 * 60 * 60_000;
/** How often a watch re-reads a steer its provider has not confirmed yet. */
const UNCONFIRMED_STEER_RECHECK = "1500 millis";
const TERMINAL_WORK = new Set<OrchestratorLiveWorkEvent["status"]>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

function languageName(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return "the person's language";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(trimmed) ?? trimmed;
  } catch {
    return trimmed;
  }
}

const asSentence = (text: string) => {
  const trimmed = text.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** GPT-Live `instructions` for a call with one agent. Immutable once the call starts. */
export function agentCallInstructions(input: {
  readonly name: string;
  readonly purpose: string;
  readonly language: string;
  readonly direction: AgentCallDirection;
  readonly topic: string | null;
}): string {
  const lines = [
    `You are ${input.name}, one of the person's Solla Code agents, on a live phone call with them. Your job: ${asSentence(input.purpose)}`,
    "Talk like a real phone call: warm, natural, brief turns, no lists or markdown, no reading out code or URLs verbatim.",
    "You can't do work or look things up yourself — your real work happens in your chat. Delegate every request that needs action, information, files, tools or a decision about work; the delegation carries what the person said to your chat. Keep talking naturally while it runs, but never invent progress, results or approvals. When results arrive, say them conversationally, summarising long or technical parts. If your chat asks a question, ask the person and delegate their answer.",
    "Read back consequential actions before delegating them; hearing a transcript is not approval for an external action (approvals still happen in Solla).",
    "When the person says goodbye or asks you to hang up, answer with a short goodbye that says bye; the call hangs up as soon as you finish it. Don't add a question after it.",
    `Speak ${languageName(input.language)}.`,
  ];
  if (input.direction === "incoming")
    lines.push(
      input.topic
        ? `You called the person because: ${asSentence(input.topic)} Open by greeting them, saying who you are and why you called.`
        : "You called the person. Open by greeting them, saying who you are and asking how they'd like to proceed.",
    );
  return lines.join("\n");
}

const MS = String.raw`\d+(?:\.\d+)?(?:e[+-]?\d+)?`;
const TIMED_LINE = new RegExp(String.raw`^(user|assistant) \[(${MS})-(${MS})ms\]: (.*)$`, "u");

/**
 * Joins transcript deltas the way the call screen's caption does: each delta
 * carries its own spacing, so they are concatenated as they come.
 */
function joinFragments(fragments: ReadonlyArray<string>): string {
  return fragments.join("").replace(/\s+/gu, " ").trim();
}

export interface CallConversationDelta {
  readonly userText: string;
  readonly assistantText: string;
  /** Every timed fragment in the context; once forwarded, none of them is sent again. */
  readonly fragments: ReadonlyArray<string>;
}

/**
 * What was said on the call that has not reached the chat yet, from a
 * GPT-Live delegation context (`role [startMs-endMs]: text` lines, sorted by
 * start). A fragment is new until it has been forwarded, whatever its
 * timestamps: a user transcript that arrives after the assistant's later
 * reply still goes out. History lines without timestamps were said before the
 * call and are never forwarded; a line without a prefix after a timed one
 * continues that fragment's text.
 */
export function extractCallDelta(
  context: string,
  forwarded: ReadonlySet<string>,
): CallConversationDelta {
  const timed: Array<{ role: string; start: string; end: string; text: string }> = [];
  for (const line of context.split("\n")) {
    const match = TIMED_LINE.exec(line);
    const last = timed.at(-1);
    if (match) {
      const [, role = "", start = "", end = "", text = ""] = match;
      if (Number.isFinite(Number(start)) && Number.isFinite(Number(end)))
        timed.push({ role, start, end, text });
    } else if (last) last.text += `\n${line}`;
  }
  const user: string[] = [];
  const assistant: string[] = [];
  const fragments = timed.map((fragment) => {
    const key = `${fragment.role} ${fragment.start}-${fragment.end}\0${fragment.text}`;
    if (!forwarded.has(key)) (fragment.role === "user" ? user : assistant).push(fragment.text);
    return key;
  });
  return { userText: joinFragments(user), assistantText: joinFragments(assistant), fragments };
}

/** The user message an agent's chat receives for one stretch of the call. */
export function forwardedCallMessage(delta: CallConversationDelta): string {
  return [
    "From our voice call:",
    `You said: ${delta.userText.slice(-8_000)}`,
    ...(delta.assistantText
      ? [`(On the call I replied: ${delta.assistantText.slice(-2_000)})`]
      : []),
  ].join("\n");
}

const FULL_REPLY_IN_CHAT = "The full reply is in my chat.";

/** Chat text as one spoken line: code left in the chat, whitespace collapsed. */
const plainSpoken = (text: string) =>
  text
    .replace(/```[\s\S]*?```/gu, " (code is in my chat) ")
    .replace(/\s+/gu, " ")
    .trim();

/** The agent's reply as something to say: code left in the chat, long text cut at a sentence. */
export function spokenReply(text: string, maxChars = SPOKEN_REPLY_MAX_CHARS): string {
  const plain = plainSpoken(text);
  if (plain.length <= maxChars) return plain;
  const head = plain.slice(0, maxChars);
  const sentenceEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
  );
  const cut =
    sentenceEnd >= maxChars / 2
      ? head.slice(0, sentenceEnd + 1)
      : head.slice(0, Math.max(head.lastIndexOf(" "), maxChars / 2));
  return `${cut.trim()} ${FULL_REPLY_IN_CHAT}`;
}

/**
 * The chat's reply messages (oldest first) as one thing to say. All of them
 * when they fit; otherwise the newest message, which carries the answer a
 * tool-heavy turn ends with, plus the earlier ones that still fit before it,
 * and a pointer to the chat for the rest. Empty when nothing was written.
 */
export function spokenReplies(
  texts: ReadonlyArray<string>,
  maxChars = SPOKEN_REPLY_MAX_CHARS,
): string {
  const plain = texts.map(plainSpoken).filter(Boolean);
  const whole = plain.join(" ");
  const newest = plain.at(-1);
  if (whole.length <= maxChars || newest === undefined) return whole;
  if (newest.length > maxChars) return spokenReply(newest, maxChars);
  const kept = [newest];
  let length = newest.length;
  for (const text of plain.slice(0, -1).toReversed()) {
    if (length + 1 + text.length > maxChars) break;
    kept.unshift(text);
    length += 1 + text.length;
  }
  return `${kept.join(" ")} ${FULL_REPLY_IN_CHAT}`;
}

const decodeRequestId = Schema.decodeUnknownOption(Schema.Struct({ requestId: Schema.String }));
const decodeAnswerable = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.String,
    questions: Schema.Array(Schema.Struct({ id: Schema.String })),
  }),
);
const decodeQuestions = Schema.decodeUnknownOption(
  Schema.Struct({ questions: Schema.Array(Schema.Struct({ question: Schema.String })) }),
);
const decodeActionApproval = Schema.decodeUnknownOption(
  Schema.Struct({ actionApproval: Schema.Unknown }),
);
const decodeDetail = Schema.decodeUnknownOption(Schema.Struct({ detail: Schema.String }));

type CallThreadActivity = Pick<
  OrchestrationThread["activities"][number],
  "kind" | "summary" | "payload" | "turnId" | "createdAt"
>;

const requestIdOf = (activity: Pick<CallThreadActivity, "payload">) =>
  Option.match(decodeRequestId(activity.payload), {
    onNone: () => null,
    onSome: ({ requestId }) => requestId,
  });

/** A respond failure that marks its request stale or unknown, the decider's rule. */
const isStaleRequestFailure = (activity: Pick<CallThreadActivity, "payload">) =>
  Option.exists(decodeDetail(activity.payload), isStaleRequestFailureDetail);

/**
 * The newest request of one family still open in the window: no resolution
 * and no stale respond failure. `answered` requests count as resolved: the
 * call answered them and their resolution has not landed yet. With
 * `latestTurnId`, a request raised by an earlier turn is over too, the
 * composer's rule: that turn ended (a follow-up replaced it) without
 * resolving it, so nothing can answer it any more.
 */
function openRequest(
  activities: ReadonlyArray<CallThreadActivity>,
  family: "approval" | "user-input",
  options: {
    readonly answered?: ReadonlySet<string>;
    readonly latestTurnId?: TurnId | undefined;
  } = {},
): CallThreadActivity | undefined {
  const resolved = new Set(options.answered);
  for (const activity of activities)
    if (
      activity.kind === `${family}.resolved` ||
      (activity.kind === `provider.${family}.respond.failed` && isStaleRequestFailure(activity))
    ) {
      const requestId = requestIdOf(activity);
      if (requestId !== null) resolved.add(requestId);
    }
  return activities.findLast((activity) => {
    if (activity.kind !== `${family}.requested`) return false;
    if (
      options.latestTurnId !== undefined &&
      activity.turnId !== null &&
      activity.turnId !== options.latestTurnId
    )
      return false;
    const requestId = requestIdOf(activity);
    return requestId !== null && !resolved.has(requestId);
  });
}

/**
 * Providers whose questions take only one of their own option labels: free
 * text dismisses the question (see kimiQuestionAnswerOptionId), so the
 * person's words go to the chat as a message instead.
 */
const OPTION_ONLY_PROVIDERS: ReadonlySet<string> = new Set([KIMI_DRIVER_KIND]);

/**
 * The question a spoken answer can fill: an open user-input request that is
 * not an action approval (approvals are never granted by voice), from a
 * provider that keeps free-text answers (`providerName` is the thread
 * session's). The words go to every question, as one typed answer in the
 * composer would.
 */
export function voiceAnswerableRequest(
  activity: CallThreadActivity,
  providerName: string | null,
): { readonly requestId: string; readonly questionIds: ReadonlyArray<string> } | null {
  if (activity.kind !== "user-input.requested" || isActionApprovalRequest(activity)) return null;
  if (providerName !== null && OPTION_ONLY_PROVIDERS.has(providerName)) return null;
  return Option.match(decodeAnswerable(activity.payload), {
    onNone: () => null,
    onSome: ({ requestId, questions }) =>
      questions.length === 0
        ? null
        : { requestId, questionIds: questions.map((question) => question.id) },
  });
}

/** What the person is asked, from a user-input or approval activity. */
export function requestText(activity: CallThreadActivity): string {
  const questions = Option.match(decodeQuestions(activity.payload), {
    onNone: () => "",
    onSome: ({ questions }) => questions.map((entry) => entry.question.trim()).join(" "),
  });
  if (questions) return questions;
  const detail = Option.match(decodeDetail(activity.payload), {
    onNone: () => "",
    onSome: ({ detail }) => detail.trim(),
  });
  return detail ? `${activity.summary}: ${detail}` : activity.summary;
}

export const isActionApprovalRequest = (activity: Pick<CallThreadActivity, "payload">) =>
  Option.isSome(decodeActionApproval(activity.payload));

/**
 * What one delegation passed to the agent's chat, and how to tell the chat's
 * reply to it apart from other work.
 */
export interface AgentCallWatchTarget {
  /** The forwarded chat message; null when the words answered the chat's open question. */
  readonly messageId: MessageId | null;
  /**
   * The question those words answered, or dismissed: on an option-only chat
   * (Kimi) the forwarded message interrupts the question's turn, which
   * dismisses it. It counts as resolved until its resolution lands.
   */
  readonly answeredRequestId: string | null;
  /** When the words reached the chat. The reply is what the chat wrote after this. */
  readonly sentAt: string;
  /**
   * The turn already running when the message was forwarded. Its end answers
   * the message only if the message joined it (was steered in); otherwise the
   * reply comes from the turn the message starts.
   */
  readonly busyTurnId: TurnId | null;
}

export interface AgentCallThreadView {
  readonly thread: Pick<OrchestrationThread, "messages" | "activities" | "latestTurn" | "session">;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  /**
   * Where the forwarded message's delivery stands, from its durable work
   * obligation: `pending` until it joins a turn or starts one, `unconfirmed`
   * while it is being steered into the running turn but the provider has not
   * accepted it yet (a refusal sends it back to `pending`), `settled` once it
   * has joined or started a turn (or when nothing tracks it), `cancelled` when
   * it was removed or stopped before it was sent.
   */
  readonly delivery: "pending" | "unconfirmed" | "settled" | "cancelled";
}

const approvalText = (open: CallThreadActivity | undefined) =>
  `I need your approval for ${open ? requestText(open) : "a step in my chat"} — please approve or decline it in Solla Code; a spoken yes can't approve it.`;

/**
 * Where the agent's chat stands on what one delegation passed it, as a
 * GPT-Live work event: queued or working (quiet), waiting on the person (a
 * question or an approval), or finished with the reply it wrote since.
 *
 * The finished reply wins over requests that were already open when the words
 * reached the chat (an old card does not hide it); a request raised since
 * keeps the call waiting on the person.
 */
export function agentCallWorkEvent(input: {
  readonly delegationId: string;
  readonly target: AgentCallWatchTarget;
  readonly view: AgentCallThreadView;
}): OrchestratorLiveWorkEvent {
  const { target, view } = input;
  const { thread } = view;
  const event = (status: OrchestratorLiveWorkEvent["status"], text: string) => ({
    delegationId: input.delegationId,
    status,
    text: text.slice(0, 8_000),
  });
  if (
    target.answeredRequestId !== null &&
    thread.activities.some(
      (activity) =>
        activity.kind === "provider.user-input.respond.failed" &&
        activity.createdAt >= target.sentAt &&
        requestIdOf(activity) === target.answeredRequestId,
    )
  )
    return event(
      "failed",
      "My chat couldn't take that answer. Please answer its question in Solla Code.",
    );
  if (view.delivery === "cancelled")
    return event("failed", "My chat stopped before it got to that.");

  const turn = thread.latestTurn;
  const inBusyTurn =
    turn !== null && target.busyTurnId !== null && turn.turnId === target.busyTurnId;
  // The turn handling the words: the one an answer resumes (or a turn started
  // after it), the busy turn only once the message joined it, else a turn
  // requested since the message, or one that ended after the message joined
  // it (steered into a turn the shell did not show as running yet: a message
  // that starts its own turn settles only once that turn ends).
  const handling =
    turn === null
      ? null
      : inBusyTurn
        ? view.delivery === "settled"
          ? turn
          : null
        : target.messageId === null ||
            turn.requestedAt >= target.sentAt ||
            (view.delivery === "settled" &&
              turn.completedAt !== null &&
              turn.completedAt >= target.sentAt)
          ? turn
          : null;
  // What the busy turn wrote after the message counts only if the message joined it.
  const replies = thread.messages.filter(
    (message) =>
      message.role === "assistant" &&
      message.createdAt >= target.sentAt &&
      (target.busyTurnId === null ||
        message.turnId !== target.busyTurnId ||
        (inBusyTurn && view.delivery === "settled")),
  );
  const working =
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    turn?.state === "running" ||
    replies.some((message) => message.streaming);
  const answered = new Set(target.answeredRequestId === null ? [] : [target.answeredRequestId]);
  const openInput = view.hasPendingUserInput
    ? openRequest(thread.activities, "user-input", { answered, latestTurnId: turn?.turnId })
    : undefined;
  // The pending flag ignores turns: a question an earlier turn left open keeps
  // it set, though nothing waits on that question any more.
  const orphanedInput =
    view.hasPendingUserInput &&
    openInput === undefined &&
    openRequest(thread.activities, "user-input", { answered }) !== undefined;
  const openApproval = view.hasPendingApprovals
    ? openRequest(thread.activities, "approval")
    : undefined;
  const raisedSince = (open: CallThreadActivity | undefined) =>
    open !== undefined && open.createdAt >= target.sentAt;

  if (
    handling !== null &&
    !working &&
    handling.completedAt !== null &&
    handling.completedAt >= target.sentAt &&
    !raisedSince(openInput) &&
    !raisedSince(openApproval)
  ) {
    if (handling.state === "error")
      return event("failed", thread.session?.lastError ?? "My chat ran into an error.");
    const reply = spokenReplies(replies.map((message) => message.text));
    if (reply) return event("completed", reply);
    if (handling.state === "interrupted")
      return event("failed", "The work in my chat was stopped before it replied.");
    return event("completed", "My chat finished without writing a reply.");
  }

  if (openInput !== undefined) {
    if (isActionApprovalRequest(openInput))
      return event("pending-approval", approvalText(openInput));
    return event(
      "waiting-input",
      voiceAnswerableRequest(openInput, thread.session?.providerName ?? null) !== null
        ? `My chat is asking you: ${requestText(openInput)}`
        : `My chat is asking: ${requestText(openInput)} — that has to be answered in Solla Code; I can't answer it from this call.`,
    );
  }
  // The flag can trail an answer the call just gave or an earlier turn's
  // leftover question; anything else is a request outside the window.
  if (view.hasPendingUserInput && target.answeredRequestId === null && !orphanedInput)
    return event("waiting-input", "My chat is waiting for an answer in Solla Code.");
  if (view.hasPendingApprovals) return event("pending-approval", approvalText(openApproval));

  if (!working && thread.session?.status === "error" && thread.session.updatedAt >= target.sentAt)
    return event("failed", thread.session.lastError ?? "My chat ran into an error.");
  if (inBusyTurn && view.delivery === "pending")
    return event("queued", "Your request is waiting in my chat behind earlier work.");
  // An unconfirmed steer is already in the running turn's hands, even when that
  // turn looks finished before the provider's acceptance lands.
  return event(
    "running",
    working || view.delivery === "unconfirmed"
      ? "Working on it in my chat."
      : "Passing that to my chat.",
  );
}

/** Thread events that can change what a call is waiting on; streaming text is not one. */
export function wakesCallWatch(event: OrchestrationEvent, threadId: ThreadId): boolean {
  if (event.aggregateKind !== "thread" || event.aggregateId !== threadId) return false;
  switch (event.type) {
    case "thread.session-set":
    case "thread.turn-diff-completed":
    case "thread.deleted":
      return true;
    case "thread.message-sent":
      return !event.payload.streaming;
    case "thread.activity-appended":
      return (
        event.payload.activity.kind.startsWith("approval.") ||
        event.payload.activity.kind.startsWith("user-input.") ||
        event.payload.activity.kind === "provider.user-input.respond.failed" ||
        event.payload.activity.kind === "message.delivered" ||
        event.payload.activity.kind === "provider.queue.promoted"
      );
    default:
      return false;
  }
}

/** A delegation's answer: the work it passed to the chat, or one event. */
type DelegationAnswer = AgentCallWatchTarget | OrchestratorLiveWorkEvent;

interface CallSession {
  readonly callId: AgentCallId;
  readonly threadId: ThreadId;
  readonly createdAt: number;
  /** Transcript fragments already in the chat (see `extractCallDelta`). */
  forwardedFragments: ReadonlySet<string>;
  /** Questions this call answered whose resolution may not have landed yet. */
  readonly answeredRequestIds: Set<string>;
  lastSequence: number;
  active: AgentCallWatchTarget | null;
  /** Per delegation id that passed the chat something: the work it watches. */
  readonly requests: Map<string, AgentCallWatchTarget>;
}

/** The turn running on a thread right now, if any. */
const runningTurnOf = (shell: Pick<OrchestrationThread, "session" | "latestTurn">) =>
  shell.session?.status === "running" && shell.session.activeTurnId !== null
    ? shell.session.activeTurnId
    : shell.latestTurn?.state === "running"
      ? shell.latestTurn.turnId
      : null;

export const makeAgentCallLive = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const secrets = yield* ServerSecretStore;
  const agents = yield* VmAgentStore;
  const calls = yield* AgentCalls;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const obligations = yield* ThreadWorkObligationRepository;
  const http = yield* HttpClient.HttpClient;
  const semaphore = yield* Semaphore.make(1);
  const sessions = new Map<string, CallSession>();
  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const ended = (detail = "This call has ended.") =>
    new OrchestratorLiveError({ status: 409, detail });
  /** Drops sessions whose call is over (hung up, lease lapsed) or that outlived the cap. */
  const prune = Effect.gen(function* () {
    const now = yield* nowMs;
    for (const [id, session] of sessions) {
      const call = yield* calls.get(session.callId);
      if (
        now - session.createdAt > SESSION_MAX_AGE_MS ||
        Option.isNone(call) ||
        call.value.status !== "active"
      )
        sessions.delete(id);
    }
  });

  /** Claims the call for `deviceLabel` and opens GPT-Live as the agent. */
  const start = Effect.fn("AgentCallLive.start")(function* (
    input: AgentCallSessionStartInput,
    deviceLabel: string,
  ) {
    const call = yield* calls.get(input.callId);
    if (Option.isNone(call)) return yield* ended();
    const agent = yield* agents
      .getById(call.value.vmAgentId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(agent) || agent.value.threadId === null) {
      yield* calls.fail(input.callId);
      return yield* ended("That agent has no chat to call.");
    }
    const key = yield* resolveOrchestratorApiKey("openai").pipe(
      Effect.provideService(ServerSecretStore, secrets),
    );
    if (Option.isNone(key)) {
      yield* calls.fail(input.callId);
      return yield* ended("Add an OpenAI key in Settings → Orchestrator to call agents.");
    }
    const { orchestrator: settings } = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () => new OrchestratorLiveError({ status: 502, detail: "Could not read voice settings." }),
      ),
    );
    yield* prune;
    if (sessions.size >= MAX_CALL_SESSIONS)
      return yield* new OrchestratorLiveError({
        status: 429,
        detail: "Too many live calls. End another call first.",
      });
    const claimed = yield* calls
      .claim(input.callId, deviceLabel)
      .pipe(Effect.mapError((error) => ended(error.detail)));
    const voice = liveVoiceFor(settings.voice);
    const created = yield* createGptLiveSession(http, {
      key: key.value,
      instructions: agentCallInstructions({
        name: agent.value.name,
        purpose: agent.value.purpose,
        language: settings.language,
        direction: claimed.direction,
        topic: claimed.topic,
      }),
      voice,
      history: input.history,
      sdp: input.sdp,
    }).pipe(Effect.onError(() => calls.fail(input.callId)));
    sessions.set(created.sessionId, {
      callId: input.callId,
      threadId: agent.value.threadId,
      createdAt: yield* nowMs,
      forwardedFragments: new Set(),
      answeredRequestIds: new Set(),
      lastSequence: 0,
      active: null,
      requests: new Map(),
    });
    yield* Effect.logInfo("agent call GPT-Live session created", {
      model: OPENAI_LIVE_MODEL,
      voice,
      agentId: agent.value.vmAgentId,
      direction: claimed.direction,
    });
    return {
      sessionId: created.sessionId,
      sdp: created.sdp,
      model: OPENAI_LIVE_MODEL,
      voice,
      agentName: agent.value.name,
    };
  });

  /** The session of a call that is still live, its lease renewed; 409 once it is over. */
  const liveSession = Effect.fnUntraced(function* (sessionId: string) {
    yield* prune;
    const session = sessions.get(sessionId);
    if (!session || !(yield* calls.renew(session.callId))) return yield* ended();
    return session;
  });

  /**
   * A forwarded message's delivery from its obligation row. A row the reactor
   * completed to claim a steer is `unconfirmed` until the provider accepts it:
   * a refused steer puts the message back in line for its own turn.
   */
  const deliveryOf = (threadId: ThreadId, target: AgentCallWatchTarget) =>
    target.messageId === null
      ? Effect.succeed("settled" as const)
      : obligations
          .getByKey({
            threadId,
            sourceTurnId: activeTurnWorkSourceId(target.messageId),
            kind: "active-turn-recovery",
          })
          .pipe(
            Effect.map(
              Option.match({
                onNone: () => "settled" as const,
                onSome: (row) =>
                  row.state === "completed"
                    ? row.blockedReason === ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON
                      ? ("unconfirmed" as const)
                      : ("settled" as const)
                    : row.state === "cancelled"
                      ? ("cancelled" as const)
                      : ("pending" as const),
              }),
            ),
          );

  const readView = (threadId: ThreadId, target: AgentCallWatchTarget) =>
    Effect.gen(function* () {
      const shell = yield* projections.getThreadShellById(threadId);
      if (Option.isNone(shell)) return Option.some(null);
      const thread = yield* projections.getThreadDetailById(threadId, {
        messageLimit: 40,
        activityLimit: 80,
      });
      if (Option.isNone(thread)) return Option.some(null);
      return Option.some<AgentCallThreadView | null>({
        thread: thread.value,
        hasPendingApprovals: shell.value.hasPendingApprovals,
        hasPendingUserInput: shell.value.hasPendingUserInput,
        delivery: yield* deliveryOf(threadId, target),
      });
    }).pipe(Effect.orElseSucceed(() => Option.none<AgentCallThreadView | null>()));

  const workEvent = (
    target: AgentCallWatchTarget,
    delegationId: string,
    view: AgentCallThreadView | null,
  ): OrchestratorLiveWorkEvent =>
    view === null
      ? { delegationId, status: "failed", text: "My chat is no longer available." }
      : agentCallWorkEvent({ delegationId, target, view });

  /** Work events for what one delegation passed the chat, until it replies or fails. */
  const watch = (threadId: ThreadId, target: AgentCallWatchTarget, delegationId: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const wake = yield* Queue.sliding<void>(1);
        // Subscribe before the first read so a reply landing in between still wakes us.
        yield* engine.streamDomainEvents.pipe(
          Stream.filter((event) => wakesCallWatch(event, threadId)),
          Stream.runForEach(() => Queue.offer(wake, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Queue.offer(wake, undefined);
        // A provider without delivery receipts (Cursor) has its steer confirmed
        // by the reactor only once the merged turn ends, with no domain event.
        // While the last read saw an unconfirmed steer, one fiber re-reads the
        // row and wakes the watch when it moves, so the reply is not stranded.
        const scope = yield* Effect.scope;
        let awaitingSteer = false;
        const awaitSteerConfirmation = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(UNCONFIRMED_STEER_RECHECK);
            const delivery = yield* deliveryOf(threadId, target).pipe(
              Effect.orElseSucceed(() => "unconfirmed" as const),
            );
            if (delivery !== "unconfirmed") break;
          }
          awaitingSteer = false;
          yield* Queue.offer(wake, undefined);
        });
        const followUnconfirmedSteer = (view: Option.Option<AgentCallThreadView | null>) =>
          awaitingSteer || Option.getOrNull(view)?.delivery !== "unconfirmed"
            ? Effect.void
            : Effect.sync(() => {
                awaitingSteer = true;
              }).pipe(
                Effect.andThen(
                  Effect.forkIn(awaitSteerConfirmation, scope, { startImmediately: true }),
                ),
                Effect.asVoid,
              );
        return Stream.fromQueue(wake).pipe(
          Stream.mapEffect(() =>
            readView(threadId, target).pipe(Effect.tap(followUnconfirmedSteer)),
          ),
          Stream.filter(Option.isSome),
          Stream.map(({ value: view }) => workEvent(target, delegationId, view)),
          Stream.changesWith(
            (left, right) => left.status === right.status && left.text === right.text,
          ),
          Stream.takeUntil((event) => TERMINAL_WORK.has(event.status)),
        );
      }),
    );

  /**
   * The chat's open question: `answer` when the person's words can fill it,
   * else `dismissedRequestId` when forwarding them as a message dismisses it
   * (an option-only chat, whose question turn the message interrupts).
   */
  const openQuestion = (session: CallSession) =>
    projections.getThreadDetailById(session.threadId, { messageLimit: 1, activityLimit: 80 }).pipe(
      Effect.map((thread) => {
        const none = { answer: null, dismissedRequestId: null };
        if (Option.isNone(thread)) return none;
        const open = openRequest(thread.value.activities, "user-input", {
          answered: session.answeredRequestIds,
          latestTurnId: thread.value.latestTurn?.turnId,
        });
        if (open === undefined) return none;
        const providerName = thread.value.session?.providerName ?? null;
        const answer = voiceAnswerableRequest(open, providerName);
        const dismissed =
          answer === null &&
          providerName !== null &&
          OPTION_ONLY_PROVIDERS.has(providerName) &&
          !isActionApprovalRequest(open);
        return { answer, dismissedRequestId: dismissed ? requestIdOf(open) : null };
      }),
      Effect.orElseSucceed(() => ({ answer: null, dismissedRequestId: null })),
    );

  /**
   * Passes what was said since the last delegation to the agent's chat — as
   * the answer to its open question when it has one a spoken answer can fill,
   * otherwise as a user message — then streams the chat's progress. Retries
   * of one delegation id reattach to the same work instead of sending again;
   * a delegation that found nothing new is not remembered, so its retry reads
   * the transcript again once the person's words have arrived.
   */
  const delegate = Effect.fn("AgentCallLive.delegate")(
    function* (input: OrchestratorLiveDelegationInput) {
      const session = yield* liveSession(input.sessionId);
      const answer = (target: DelegationAnswer) =>
        "sentAt" in target
          ? watch(session.threadId, target, input.delegationId)
          : Stream.make({ ...target, delegationId: input.delegationId });
      const existing = session.requests.get(input.delegationId);
      if (existing) return answer(existing);
      const delta = extractCallDelta(input.context, session.forwardedFragments);
      if (input.sequence <= session.lastSequence || !delta.userText) {
        // Nothing new for the chat: an out-of-order delegation, or speech whose
        // transcript has not arrived yet. Stay with work still under way, but
        // never hand a finished reply to a new request; end quietly instead
        // (empty text: the client retries once the transcript settles).
        const active = session.active;
        const current =
          active === null
            ? Option.none<OrchestratorLiveWorkEvent>()
            : Option.map(yield* readView(session.threadId, active), (view) =>
                workEvent(active, input.delegationId, view),
              );
        const target: DelegationAnswer =
          active === null
            ? {
                delegationId: input.delegationId,
                status: "completed",
                text: "I didn't catch a new request. Ask the person to say it again.",
              }
            : Option.isSome(current) && TERMINAL_WORK.has(current.value.status)
              ? { delegationId: input.delegationId, status: "completed", text: "" }
              : active;
        return answer(target);
      }
      const shell = yield* projections
        .getThreadShellById(session.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(shell)) {
        // The chat was deleted: nothing can reach it, so the call is over.
        sessions.delete(input.sessionId);
        yield* calls.fail(session.callId);
        return yield* ended("This agent's chat is no longer available.");
      }
      const id = NodeCrypto.createHash("sha256")
        .update(`${input.sessionId}\0${input.delegationId}`)
        .digest("hex")
        .slice(0, 32);
      const commandId = CommandId.make(`agent-call:${id}`);
      const sentAt = DateTime.formatIso(yield* DateTime.now);
      const open = shell.value.hasPendingUserInput
        ? yield* openQuestion(session)
        : { answer: null, dismissedRequestId: null };
      const question = open.answer;
      const messageId = MessageId.make(`agent-call:${id}`);
      const target: AgentCallWatchTarget =
        question === null
          ? {
              messageId,
              answeredRequestId: open.dismissedRequestId,
              sentAt,
              busyTurnId: runningTurnOf(shell.value),
            }
          : { messageId: null, answeredRequestId: question.requestId, sentAt, busyTurnId: null };
      yield* (
        question === null
          ? engine.dispatch({
              type: "thread.turn.start",
              commandId,
              threadId: session.threadId,
              message: {
                messageId,
                role: "user",
                text: forwardedCallMessage(delta),
                inputOrigin: "transcription",
                attachments: [],
              },
              // The composer's path: a busy chat steers it in or queues it.
              runtimeMode: shell.value.runtimeMode,
              interactionMode: shell.value.interactionMode,
              createdAt: sentAt,
            })
          : // The command the question card sends: the words answer every question.
            engine.dispatch({
              type: "thread.user-input.respond",
              commandId,
              threadId: session.threadId,
              requestId: ApprovalRequestId.make(question.requestId),
              answers: Object.fromEntries(
                question.questionIds.map((questionId) => [
                  questionId,
                  delta.userText.slice(-8_000),
                ]),
              ),
              createdAt: sentAt,
            })
      ).pipe(
        Effect.mapError(
          () =>
            new OrchestratorLiveError({
              status: 502,
              detail: "I couldn't pass that to my chat. Try again.",
            }),
        ),
      );
      if (target.answeredRequestId !== null)
        session.answeredRequestIds.add(target.answeredRequestId);
      session.requests.set(input.delegationId, target);
      session.active = target;
      session.lastSequence = input.sequence;
      session.forwardedFragments = new Set(delta.fragments);
      return answer(target);
    },
    (effect) => semaphore.withPermits(1)(effect),
  );

  return {
    start,
    delegate,
    /**
     * The device holding the call is still there; 409 once the call is over.
     * Never waits behind a delegation: the renewal is atomic in AgentCalls.
     */
    heartbeat: (sessionId: string) => liveSession(sessionId).pipe(Effect.asVoid),
    /** Frees the voice session and hangs up its call. */
    release: (sessionId: string) =>
      Effect.gen(function* () {
        const session = sessions.get(sessionId);
        sessions.delete(sessionId);
        if (session) yield* calls.end(session.callId);
      }),
  };
});

export class AgentCallLive extends Context.Service<
  AgentCallLive,
  Effect.Success<typeof makeAgentCallLive>
>()("t3/vm/AgentCallLive") {}
export const AgentCallLiveLayer = Layer.effect(AgentCallLive, makeAgentCallLive);

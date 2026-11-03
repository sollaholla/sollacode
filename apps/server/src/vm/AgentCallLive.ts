// @effect-diagnostics nodeBuiltinImport:off
import { AGENT_STOP_TOKEN } from "@t3tools/shared/agentMode";
import * as NodeCrypto from "node:crypto";
import {
  AGENT_CALL_GROK_DELEGATE_TOOL,
  AGENT_CALL_MAX_PARTICIPANTS,
  AgentCallError,
  ApprovalRequestId,
  CommandId,
  DEFAULT_XAI_REALTIME_MODEL,
  MessageId,
  OPENAI_LIVE_MODEL,
  type AgentCallDirection,
  type AgentCallGrokSessionStartInput,
  type AgentCallGrokSessionStartResult,
  type AgentCallId,
  type AgentCallParticipantInput,
  type AgentCallRoster,
  type AgentCallSessionStartInput,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestratorLiveDelegationInput,
  type OrchestratorLiveWorkEvent,
  type ThreadId,
  type TurnId,
  type VmAgent,
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
import { agentCallVoiceOn, type AgentCallEngine } from "@t3tools/shared/agentCallVoice";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { activeTurnWorkSourceId } from "../orchestration/agentModeContinuation.ts";
import { isStaleRequestFailureDetail } from "../orchestration/decider.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  describeMintFailure,
  isQuotaExhausted,
  mintRealtimeToken,
  quotaExhaustedMessage,
  resolveOrchestratorApiKey,
} from "../orchestrator/OrchestratorCredentials.ts";
import { createGptLiveSession, OrchestratorLiveError } from "../orchestrator/OrchestratorLive.ts";
import {
  ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
  ThreadWorkObligationRepository,
} from "../persistence/Services/ThreadWorkObligations.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { KIMI_DRIVER_KIND } from "../provider/acp/KimiAcpSupport.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AgentCalls, agentCallKeyMissingMessage } from "./AgentCalls.ts";
import {
  callAddressing,
  callParticipantFor,
  callRoster,
  groupCallNote,
  type CallDelegationTarget,
} from "./agentCallGroup.ts";

/** How much of the agent's reply is spoken before pointing at the chat. */
const SPOKEN_REPLY_MAX_CHARS = 1_500;
const MAX_CALL_SESSIONS = 32;
const SESSION_MAX_AGE_MS = 2 * 60 * 60_000;
/** How often a watch re-reads a steer its provider has not confirmed yet. */
const UNCONFIRMED_STEER_RECHECK = "1500 millis";
/**
 * How long before a delegation reaches the host the device may already have
 * stopped reading the one before it: it switches as GPT-Live starts the new
 * delegation, then waits for trailing words (350 ms) and the network. What an
 * older delegation's stream sent in that window may never have been heard.
 */
const HEARD_GRACE_MS = 2_500;
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

/** The longest role the voice is given; the rest of a purpose is the chat's rules. */
const ROLE_SUMMARY_MAX_CHARS = 400;

/**
 * Who the agent is, for the voice: the purpose's opening paragraph, bounded.
 * The rest of a purpose is how the agent works (scope, approvals, what it
 * must not touch). Those rules are for its chat, which applies them with its
 * tools; given to the voice, they made it refuse requests itself, saying it
 * had no chat to use, instead of passing them on.
 */
export function agentCallRole(purpose: string): string {
  const opening =
    purpose
      .trim()
      .split(/\n\s*\n/u)[0]
      ?.replace(/\s+/gu, " ")
      .trim() ?? "";
  if (opening.length <= ROLE_SUMMARY_MAX_CHARS) return opening;
  const cut = opening.slice(0, ROLE_SUMMARY_MAX_CHARS);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return sentenceEnd > 0 ? cut.slice(0, sentenceEnd + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/**
 * GPT-Live `instructions` for a call with one agent. Immutable once the call
 * starts. Who the voice can transfer to or add, and the phrases that do it,
 * come from the device holding the call once it has the roster (see apps/web
 * callDirectives): only a device that acts on those phrases teaches them.
 */
export function agentCallInstructions(input: {
  readonly name: string;
  readonly purpose: string;
  readonly language: string;
  readonly direction: AgentCallDirection;
  readonly topic: string | null;
  /** GPT-Live delegates by itself; Grok Voice delegates through the `start_work` tool. */
  readonly engine?: AgentCallEngine;
}): string {
  const lines = [
    `You are ${input.name}, one of the person's Solla Code agents, on a live phone call with them. Your role: ${asSentence(agentCallRole(input.purpose))}`,
    "Talk like a real phone call: warm, natural, brief turns, no lists or markdown, no reading out code or URLs verbatim.",
    "Your work and your voice are one agent: you have your tools, your memory and access to the person's Solla Code workspace, including their projects, chats and agents, for the whole call. Never say you have no tools or no access, and never turn a request down yourself: take it on and say how it turned out.",
    'The person hears one agent: you. Never talk about your own chat or thread, delegating, handing off, a back end or anyone else doing your work, and never say you are checking with or waiting on someone to do it. Talk about your work in the first person, as the one doing it: "Let me check", "I\'m on it", "Here\'s what I found".',
    input.engine === "grok"
      ? `Anything beyond small talk needs your workspace, which only ${AGENT_CALL_GROK_DELEGATE_TOOL} reaches. Call it for any action, question, file, tool, decision about work, or anything you don't know, including requests that seem outside your role. It starts the work with what the person said and returns at once. Say one short line that you're on it, then keep talking naturally while it runs, but never invent progress, results or approvals. Results reach you as updates; they are your own work, so say them conversationally as yours, summarising long or technical parts. If an update asks a question, ask the person, then call ${AGENT_CALL_GROK_DELEGATE_TOOL} again once they answer.`
      : "Anything beyond small talk needs your workspace, which you reach by delegating. Delegate any action, question, file, tool, decision about work, or anything you don't know, including requests that seem outside your role; the delegation carries what the person said. Keep talking naturally while it runs, but never invent progress, results or approvals. Results are your own work: say them conversationally as yours, summarising long or technical parts. If a result asks a question, ask the person and delegate their answer.",
    "Read back consequential actions before delegating them; hearing a transcript is not approval for an external action (approvals still happen in Solla).",
    "When the person says goodbye or asks you to hang up, answer with a short goodbye that says bye; the call hangs up as soon as you finish it. Don't add a question after it.",
    `Never say ${AGENT_STOP_TOKEN} or any other control word out loud; a goodbye is how a call ends.`,
    `Speak ${languageName(input.language)}.`,
  ];
  lines.push(
    input.direction === "incoming"
      ? input.topic
        ? `You called the person because: ${asSentence(input.topic)} Open by greeting them, saying who you are and why you called.`
        : "You called the person. Open by greeting them, saying who you are and asking how they'd like to proceed."
      : "The person called you. Pick up the way you would answer a friend's call: one short, casual hello such as \"Hey, what's up?\", then let them talk.",
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
  /**
   * The person's latest words: the new user fragments since the last thing
   * the voice said before them. What they said earlier and the voice handled
   * itself ("Add Gregg to the call.", "Thanks, everyone.") is in `userText`
   * but never decides who these words are for.
   */
  readonly latestUserText: string;
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
  const isNewWords = (index: number) =>
    timed[index]?.role === "user" && !forwarded.has(fragments[index] ?? "");
  const latest: string[] = [];
  for (let index = timed.findLastIndex((_, at) => isNewWords(at)); isNewWords(index); index--)
    latest.unshift(timed[index]?.text ?? "");
  return {
    userText: joinFragments(user),
    latestUserText: joinFragments(latest),
    assistantText: joinFragments(assistant),
    fragments,
  };
}

/**
 * The user message an agent's chat receives for one stretch of the call.
 * `voiceName` names the voice for a chat that is not the agent called (one
 * added to the call), whose replies on the call were not its own.
 */
export function forwardedCallMessage(delta: CallConversationDelta, voiceName?: string): string {
  return [
    "From our voice call:",
    `You said: ${delta.userText.slice(-8_000)}`,
    ...(delta.assistantText
      ? [`(On the call ${voiceName ?? "I"} replied: ${delta.assistantText.slice(-2_000)})`]
      : []),
  ].join("\n");
}

const FULL_REPLY_IN_CHAT = "The rest is written up in Solla Code.";

/** Chat text as one spoken line: code left in the chat, whitespace collapsed. */
const plainSpoken = (text: string) =>
  text
    .replace(/```[\s\S]*?```/gu, " (the code is in Solla Code) ")
    // The chat's own control word: read out, it would end the call.
    .replaceAll(AGENT_STOP_TOKEN, " ")
    .replace(/\s+/gu, " ")
    .trim();

/** The head of spoken text that fits `maxChars`, cut at a sentence or else a word. */
function headOf(plain: string, maxChars: number): string {
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
  return cut.trim();
}

/** The agent's reply as something to say: code left in the chat, long text cut at a sentence. */
export function spokenReply(text: string, maxChars = SPOKEN_REPLY_MAX_CHARS): string {
  const plain = plainSpoken(text);
  if (plain.length <= maxChars) return plain;
  return `${headOf(plain, maxChars)} ${FULL_REPLY_IN_CHAT}`;
}

/**
 * A request read out in its frame ("I need your approval for … — please
 * approve or decline it in Solla Code; …"). With `maxChars` (a merged call's
 * share) only the request's own text is cut, so what the person must do, and
 * that a spoken yes can't do it, always survives.
 */
function framedRequest(
  frame: (request: string) => string,
  request: string,
  maxChars: number | undefined,
): string {
  if (maxChars === undefined) return frame(request);
  const plain = plainSpoken(request);
  const budget = Math.max(80, maxChars - frame("").length);
  return frame(plain.length <= budget ? plain : `${headOf(plain, budget)} …`);
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

const approvalText = (open: CallThreadActivity | undefined, maxChars?: number) =>
  framedRequest(
    (request) =>
      `I need your approval for ${request} — please approve or decline it in Solla Code; a spoken yes can't approve it.`,
    open ? requestText(open) : "a step I want to take",
    maxChars,
  );

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
  /**
   * How much of the reply, or of a request's own text, to speak; a merged
   * call splits SPOKEN_REPLY_MAX_CHARS.
   */
  readonly maxChars?: number | undefined;
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
      "I couldn't take that answer on the call. Please answer the question in Solla Code.",
    );
  if (view.delivery === "cancelled") return event("failed", "I stopped before I got to that.");

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
      return event("failed", thread.session?.lastError ?? "I ran into an error.");
    const reply = spokenReplies(
      replies.map((message) => message.text),
      input.maxChars,
    );
    if (reply) return event("completed", reply);
    if (handling.state === "interrupted")
      return event("failed", "My work on that was stopped before I could answer.");
    return event("completed", "I finished without writing anything back.");
  }

  if (openInput !== undefined) {
    if (isActionApprovalRequest(openInput))
      return event("pending-approval", approvalText(openInput, input.maxChars));
    return event(
      "waiting-input",
      framedRequest(
        voiceAnswerableRequest(openInput, thread.session?.providerName ?? null) !== null
          ? (request) => `I need to ask you: ${request}`
          : (request) =>
              `I need an answer to this: ${request} — it has to be answered in Solla Code; it can't be answered on this call.`,
        requestText(openInput),
        input.maxChars,
      ),
    );
  }
  // The flag can trail an answer the call just gave or an earlier turn's
  // leftover question; anything else is a request outside the window.
  if (view.hasPendingUserInput && target.answeredRequestId === null && !orphanedInput)
    return event("waiting-input", "I'm waiting on an answer from you in Solla Code.");
  if (view.hasPendingApprovals)
    return event("pending-approval", approvalText(openApproval, input.maxChars));

  if (!working && thread.session?.status === "error" && thread.session.updatedAt >= target.sentAt)
    return event("failed", thread.session.lastError ?? "I ran into an error.");
  if (inBusyTurn && view.delivery === "pending")
    return event("queued", "I'll get to that as soon as I finish what I'm on.");
  // An unconfirmed steer is already in the running turn's hands, even when that
  // turn looks finished before the provider's acceptance lands.
  return event("running", working || view.delivery === "unconfirmed" ? "Working on it." : "On it.");
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

const FAILED_WORK = new Set<OrchestratorLiveWorkEvent["status"]>([
  "failed",
  "cancelled",
  "expired",
]);
/** What one part of a merged reply adds besides its text: "<Name> couldn't answer: " and a blank line. */
const MERGED_PART_OVERHEAD = 20;
/** What a chat added to the call says once its thread is gone; the call drops it. */
const PARTICIPANT_GONE = "I'm no longer available, so I've left the call.";

const failedWork = (delegationId: string, text: string): OrchestratorLiveWorkEvent => ({
  delegationId,
  status: "failed",
  text,
});
const sameWorkEvent = (left: OrchestratorLiveWorkEvent, right: OrchestratorLiveWorkEvent) =>
  left.status === right.status && left.text === right.text;

/**
 * How much of each chat's reply a delegation to several chats speaks, so the
 * merged reply, names included, fits SPOKEN_REPLY_MAX_CHARS.
 */
export function callReplyShare(names: ReadonlyArray<string>): number {
  const overhead = names.reduce((total, name) => total + name.length + MERGED_PART_OVERHEAD, 0);
  return Math.max(80, Math.floor((SPOKEN_REPLY_MAX_CHARS - overhead) / Math.max(1, names.length)));
}

/**
 * The status a finished reply is read out with while other chats on the
 * call still work: the device speaks waiting-input (and pending-approval)
 * without ending the work stream. The progress event sent right after it
 * puts the call back to working.
 */
const AUDIBLE_PROGRESS: OrchestratorLiveWorkEvent["status"] = "waiting-input";

/**
 * The work events for a delegation that went to several chats on a call, as
 * one chat's event changes (`event` is null until a chat's first one).
 * `reported` marks a chat whose finished reply the call already heard;
 * `heardRequest` is the question or approval of a chat the call already
 * read out, which is not repeated (a chat waiting on the person is followed
 * by every later delegation until it is done).
 *
 * Each reply is read out as soon as it lands: while others are not done, in
 * an audible event that names them, then the progress while anyone still
 * works; a chat that needs the person is surfaced by name at once, after any
 * replies not heard yet; once every chat is done, the replies not heard yet.
 * A reply reads "Name: …", a failure "Name couldn't answer: …", each cut to
 * its share so the whole fits SPOKEN_REPLY_MAX_CHARS; failed only when every
 * chat failed. A request reads "Name: …" as its watch framed it (cut there,
 * so what it asks of the person survives). While the only chats not done
 * wait on the person for what the call already heard, a quiet waiting event
 * (no text) says nobody is working. `reported` and `asked` list the chats
 * whose replies and requests these events read out.
 */
export function mergeCallWorkEvents(input: {
  readonly delegationId: string;
  readonly targets: ReadonlyArray<{
    readonly name: string;
    readonly event: OrchestratorLiveWorkEvent | null;
    readonly reported?: boolean | undefined;
    readonly heardRequest?: string | null | undefined;
  }>;
}): {
  readonly events: ReadonlyArray<OrchestratorLiveWorkEvent>;
  readonly reported: ReadonlyArray<number>;
  readonly asked: ReadonlyArray<number>;
} {
  const { delegationId, targets } = input;
  const share = callReplyShare(targets.map((target) => target.name));
  const fit = (text: string) =>
    text.length <= share ? text : spokenReply(text, share - FULL_REPLY_IN_CHAT.length - 1);
  const event = (status: OrchestratorLiveWorkEvent["status"], text: string) => ({
    delegationId,
    status,
    text: text.slice(0, 8_000),
  });
  const done = (current: OrchestratorLiveWorkEvent | null) =>
    current !== null && TERMINAL_WORK.has(current.status);
  const reported = targets.flatMap((target, index) =>
    target.reported !== true && done(target.event) ? [index] : [],
  );
  const replies = targets.flatMap(({ name, event: current }, index) => {
    if (current === null || !reported.includes(index)) return [];
    const text = fit(current.text.trim());
    if (FAILED_WORK.has(current.status)) return [`${name} couldn't answer: ${text}`];
    return text ? [`${name}: ${text}`] : [];
  });
  const asked = targets.flatMap(({ event: current, heardRequest }, index) =>
    (current?.status === "waiting-input" || current?.status === "pending-approval") &&
    current.text !== heardRequest
      ? [index]
      : [],
  );
  if (asked.length > 0) {
    const asking = asked.flatMap((index) => {
      const target = targets[index];
      return target?.event ? [{ name: target.name, event: target.event }] : [];
    });
    return {
      events: [
        event(
          asking.some(({ event: current }) => current.status === "pending-approval")
            ? "pending-approval"
            : "waiting-input",
          [
            ...replies,
            ...asking.map(({ name, event: current }) => `${name}: ${current.text}`),
          ].join("\n\n"),
        ),
      ],
      reported,
      asked,
    };
  }
  if (targets.every(({ event: current }) => done(current))) {
    const allFailed = targets.every(
      ({ event: current }) => current !== null && FAILED_WORK.has(current.status),
    );
    return {
      events: [event(allFailed ? "failed" : "completed", replies.join("\n\n"))],
      reported,
      asked,
    };
  }
  // Past here a chat waiting on the person was already heard: it is not
  // working, and nothing about it is said again.
  const waitingOnPerson = (current: OrchestratorLiveWorkEvent) =>
    current.status === "waiting-input" || current.status === "pending-approval";
  const progressStatus = targets.some(
    ({ event: current }) =>
      current === null ||
      (!done(current) && current.status !== "queued" && !waitingOnPerson(current)),
  )
    ? "running"
    : targets.some(({ event: current }) => current?.status === "queued")
      ? "queued"
      : null;
  const progress =
    progressStatus === null
      ? // Everyone not done waits on the person, who already heard why.
        [event(AUDIBLE_PROGRESS, "")]
      : [
          event(
            progressStatus,
            targets
              .map(({ name, event: current }) =>
                current === null
                  ? `${name}: On it.`
                  : done(current)
                    ? `${name} is done.`
                    : `${name}: ${current.text}`,
              )
              .join("\n"),
          ),
        ];
  if (replies.length === 0) return { events: progress, reported, asked };
  const pending = targets.filter(({ event: current }) => !done(current)).map(({ name }) => name);
  return {
    events: [
      event(AUDIBLE_PROGRESS, [...replies, `Not done yet: ${pending.join(", ")}.`].join("\n\n")),
      ...progress,
    ],
    reported,
    asked,
  };
}

/** One chat a delegation passed the person's words to. */
interface DelegationTarget {
  readonly threadId: ThreadId;
  /** The agent's name or the chat's title, as the call names it. */
  readonly name: string;
  /** The agent called; false for a chat added to the call. */
  readonly primary: boolean;
  /** The work it watches, or its one event when the words never reached the chat. */
  readonly work: AgentCallWatchTarget | OrchestratorLiveWorkEvent;
  /** A finished answer overtaken by newer words to this same chat. */
  readonly previousReply?: string;
  /**
   * When its finished reply went out on the call; null until then, and a
   * later delegation keeps following it, so a reply is never dropped for
   * newer words.
   */
  reported: Hearing | null;
  /** Its question or approval the call already read out, never read twice. */
  heardRequest: (Hearing & { readonly text: string }) | null;
}

/**
 * Something the call heard: when it went out, and on which delegation's
 * stream. It counts only while that delegation is the newest the host has
 * seen, and is taken back when a newer one arrives within HEARD_GRACE_MS:
 * the device may already have dropped that stream.
 */
interface Hearing {
  readonly delegationId: string;
  /** That delegation's sequence: what is heard on it was heard after its words went out. */
  readonly sequence: number;
  readonly at: number;
}

/** A delegation's answer: the chats it passed words to, or one event. */
type DelegationAnswer = ReadonlyArray<DelegationTarget> | OrchestratorLiveWorkEvent;

interface CallSession {
  readonly callId: AgentCallId;
  readonly threadId: ThreadId;
  /** The agent called, as chats added to the call hear of it. */
  readonly agentName: string;
  /** Who the voice was told it can transfer the person to or add. */
  readonly roster: AgentCallRoster;
  readonly createdAt: number;
  /** Transcript fragments already in the chat (see `extractCallDelta`). */
  forwardedFragments: ReadonlySet<string>;
  /** Questions this call answered whose resolution may not have landed yet. */
  readonly answeredRequestIds: Set<string>;
  lastSequence: number;
  /** The newest delegation to reach the host, as it arrives; the device reads only that one's stream. */
  newest: { readonly delegationId: string; readonly sequence: number } | null;
  active: ReadonlyArray<DelegationTarget> | null;
  /**
   * The delegation the person's last words went out on, and the chats they
   * went to: only those chats, and chats whose question the call read out
   * since, take unnamed words as an answer.
   */
  lastDelivery: { readonly sequence: number; readonly targets: ReadonlyArray<DelegationTarget> };
  /** Delegations answered quietly because the person's words had not arrived yet. */
  readonly awaitingWords: Set<string>;
  /** Per delegation id that passed chats something: the chats it watches. */
  readonly requests: Map<string, ReadonlyArray<DelegationTarget>>;
}

/** The turn running on a thread right now, if any. */
const runningTurnOf = (shell: Pick<OrchestrationThread, "session" | "latestTurn">) =>
  shell.session?.status === "running" && shell.session.activeTurnId !== null
    ? shell.session.activeTurnId
    : shell.latestTurn?.state === "running"
      ? shell.latestTurn.turnId
      : null;

/** A delegation's message and command id: per call session, delegation and chat. */
const forwardIdFor = (parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

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

  /** Who a call's voice can transfer to or add; empty when the workspace can't be read. */
  const readRoster = (agent: VmAgent) =>
    Effect.all([agents.list(), projections.getShellSnapshot()]).pipe(
      Effect.map(([all, shell]) => callRoster({ agent, agents: all, threads: shell.threads })),
      Effect.orElseSucceed((): AgentCallRoster => ({ entries: [] })),
    );

  /**
   * Checks the call can open voice on `engine` and claims it for
   * `deviceLabel`: the agent, the engine's key, the session cap. A call that
   * can never connect is failed, so it stops ringing everywhere.
   */
  const claimFor = Effect.fnUntraced(function* (
    callId: AgentCallId,
    deviceLabel: string,
    engine: AgentCallEngine,
  ) {
    const call = yield* calls.get(callId);
    if (Option.isNone(call)) return yield* ended();
    const agent = yield* agents
      .getById(call.value.vmAgentId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(agent) || agent.value.threadId === null) {
      yield* calls.fail(callId);
      return yield* ended("That agent has no chat to call.");
    }
    const key = yield* resolveOrchestratorApiKey(engine === "grok" ? "xai" : "openai").pipe(
      Effect.provideService(ServerSecretStore, secrets),
    );
    if (Option.isNone(key)) {
      yield* calls.fail(callId);
      return yield* ended(agentCallKeyMissingMessage(engine));
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
      .claim(callId, deviceLabel)
      .pipe(Effect.mapError((error) => ended(error.detail)));
    const roster = yield* readRoster(agent.value);
    const threadId = agent.value.threadId;
    return {
      agent: agent.value,
      threadId,
      key: key.value,
      settings,
      claimed,
      roster,
      // Each agent speaks with its own voice, chosen or from its character.
      voice: agentCallVoiceOn(agent.value, engine),
      instructions: agentCallInstructions({
        name: agent.value.name,
        purpose: agent.value.purpose,
        language: settings.language,
        direction: claimed.direction,
        topic: claimed.topic,
        engine,
      }),
    };
  });

  /** Holds a started voice session's call state; delegations and heartbeats find it by id. */
  const keepSession = Effect.fnUntraced(function* (
    sessionId: string,
    callId: AgentCallId,
    opened: {
      readonly threadId: ThreadId;
      readonly agent: VmAgent;
      readonly roster: AgentCallRoster;
    },
  ) {
    sessions.set(sessionId, {
      callId,
      threadId: opened.threadId,
      agentName: opened.agent.name,
      roster: opened.roster,
      createdAt: yield* nowMs,
      forwardedFragments: new Set(),
      answeredRequestIds: new Set(),
      lastSequence: 0,
      newest: null,
      active: null,
      lastDelivery: { sequence: 0, targets: [] },
      awaitingWords: new Set(),
      requests: new Map(),
    });
  });

  /** Claims the call for `deviceLabel` and opens GPT-Live as the agent. */
  const start = Effect.fn("AgentCallLive.start")(function* (
    input: AgentCallSessionStartInput,
    deviceLabel: string,
  ) {
    const opened = yield* claimFor(input.callId, deviceLabel, "gpt-live");
    const created = yield* createGptLiveSession(http, {
      key: opened.key,
      instructions: opened.instructions,
      voice: opened.voice,
      history: input.history,
      sdp: input.sdp,
    }).pipe(Effect.onError(() => calls.fail(input.callId)));
    yield* keepSession(created.sessionId, input.callId, opened);
    yield* Effect.logInfo("agent call GPT-Live session created", {
      model: OPENAI_LIVE_MODEL,
      voice: opened.voice,
      agentId: opened.agent.vmAgentId,
      direction: opened.claimed.direction,
      rosterSize: opened.roster.entries.length,
    });
    return {
      sessionId: created.sessionId,
      sdp: created.sdp,
      model: OPENAI_LIVE_MODEL,
      voice: opened.voice,
      agentName: opened.agent.name,
    };
  });

  /**
   * Claims the call for `deviceLabel` and mints a short-lived xAI client
   * secret for the device's Grok Voice WebSocket. The device sends the
   * returned instructions itself; everything after that (delegation,
   * heartbeat, release) is the same as a GPT-Live call's.
   */
  const startGrok = Effect.fn("AgentCallLive.startGrok")(function* (
    input: AgentCallGrokSessionStartInput,
    deviceLabel: string,
  ): Effect.fn.Return<AgentCallGrokSessionStartResult, OrchestratorLiveError> {
    const opened = yield* claimFor(input.callId, deviceLabel, "grok");
    const model = DEFAULT_XAI_REALTIME_MODEL;
    const token = yield* mintRealtimeToken({ provider: "xai", model, voice: opened.voice }).pipe(
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.mapError((error) => {
        const detail = error._tag === "OrchestratorTokenMintError" ? (error.detail ?? "") : "";
        const status = error._tag === "OrchestratorTokenMintError" ? error.status : undefined;
        return new OrchestratorLiveError({
          status: 502,
          detail: isQuotaExhausted(status, detail)
            ? quotaExhaustedMessage("xai")
            : (describeMintFailure(detail) ?? "Grok Voice could not start the call."),
        });
      }),
      Effect.onError(() => calls.fail(input.callId)),
    );
    const sessionId = `grok-call-${NodeCrypto.randomUUID()}`;
    yield* keepSession(sessionId, input.callId, opened);
    yield* Effect.logInfo("agent call Grok Voice session created", {
      model,
      voice: opened.voice,
      agentId: opened.agent.vmAgentId,
      direction: opened.claimed.direction,
      rosterSize: opened.roster.entries.length,
    });
    return {
      sessionId,
      clientSecret: token.value,
      model,
      voice: opened.voice,
      agentName: opened.agent.name,
      instructions: [
        opened.instructions,
        // GPT-Live takes the start history as conversation items; here it is context.
        ...(input.history.length > 0
          ? [
              "Your recent conversation with the person, for context:",
              ...input.history
                .slice(-12)
                .map((entry) => `${entry.role}: ${entry.text.slice(0, 600)}`),
            ]
          : []),
      ].join("\n"),
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
    maxChars?: number,
  ): OrchestratorLiveWorkEvent =>
    view === null
      ? failedWork(delegationId, "I'm no longer available.")
      : agentCallWorkEvent({ delegationId, target, view, maxChars });

  /**
   * Work events for what one delegation passed a chat, until it replies or
   * fails. `gone` runs if the chat disappears (a chat added to the call
   * leaves it), which then reads as PARTICIPANT_GONE.
   */
  const watch = (
    threadId: ThreadId,
    target: AgentCallWatchTarget,
    delegationId: string,
    options: {
      readonly maxChars?: number | undefined;
      readonly gone?: Effect.Effect<void> | undefined;
    } = {},
  ) =>
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
          Stream.mapEffect(({ value: view }) =>
            view === null && options.gone !== undefined
              ? options.gone.pipe(Effect.as(failedWork(delegationId, PARTICIPANT_GONE)))
              : Effect.succeed(workEvent(target, delegationId, view, options.maxChars)),
          ),
          Stream.changesWith(sameWorkEvent),
          Stream.takeUntil((event) => TERMINAL_WORK.has(event.status)),
        );
      }),
    );

  /** Takes a chat that went away off the call; that never ends the call. */
  const leave = (session: CallSession, threadId: ThreadId) =>
    calls.removeParticipant(session.callId, threadId).pipe(Effect.ignore);

  /** Work events for one chat a delegation passed words to. */
  const followTarget = (
    session: CallSession,
    target: DelegationTarget,
    delegationId: string,
    maxChars?: number,
  ) => {
    const current =
      "sentAt" in target.work
        ? watch(target.threadId, target.work, delegationId, {
            maxChars,
            gone: target.primary ? undefined : leave(session, target.threadId),
          })
        : Stream.make({ ...target.work, delegationId });
    return target.previousReply
      ? Stream.concat(
          Stream.make({
            delegationId,
            status: "waiting-input" as const,
            text: target.previousReply,
          }),
          current,
        )
      : current;
  };

  /**
   * What one delegation passed its chats, as one stream of work events. Only
   * the agent called: its own events, unchanged. Otherwise each chat's events
   * merged (see `mergeCallWorkEvents`). Either way a chat whose finished
   * reply goes out is marked `reported`, and one whose request goes out
   * `heardRequest`, while this is the newest delegation (see `Hearing`).
   */
  const follow = (
    session: CallSession,
    targets: ReadonlyArray<DelegationTarget>,
    delegationId: string,
  ): Stream.Stream<OrchestratorLiveWorkEvent> => {
    /** Marks what this stream sent as heard, unless a newer delegation already took over. */
    const heard = (mark: (hearing: Hearing) => void) =>
      Effect.map(nowMs, (at) => {
        const newest = session.newest;
        if (newest?.delegationId === delegationId)
          mark({ delegationId, sequence: newest.sequence, at });
      });
    const [only] = targets;
    if (only !== undefined && targets.length === 1 && only.primary)
      return followTarget(session, only, delegationId).pipe(
        Stream.tap((event) =>
          heard((hearing) => {
            if (TERMINAL_WORK.has(event.status)) only.reported = hearing;
            if (event.status === "waiting-input" || event.status === "pending-approval")
              only.heardRequest = { ...hearing, text: event.text };
          }),
        ),
      );
    const maxChars =
      callReplyShare(targets.map((target) => target.name)) - FULL_REPLY_IN_CHAT.length - 1;
    return Stream.mergeAll(
      targets.map((target, index) =>
        followTarget(session, target, delegationId, maxChars).pipe(
          Stream.map((event) => ({ index, event })),
        ),
      ),
      { concurrency: "unbounded" },
    ).pipe(
      Stream.mapAccum(
        () => ({
          latest: targets.map((): OrchestratorLiveWorkEvent | null => null),
          heard: new Set<number>(),
          // A retry of this delegation says its requests again: the device
          // may not have got them before the stream broke.
          requests: targets.map((target) =>
            target.heardRequest === null || target.heardRequest.delegationId === delegationId
              ? null
              : target.heardRequest.text,
          ),
        }),
        (state, { index, event }) => {
          const latest = state.latest.with(index, event);
          const merged = mergeCallWorkEvents({
            delegationId,
            targets: targets.map((target, at) => ({
              name: target.name,
              event: latest[at] ?? null,
              reported: state.heard.has(at),
              heardRequest: state.requests[at] ?? null,
            })),
          });
          const requests = state.requests.map((request, at) =>
            merged.asked.includes(at) ? (latest[at]?.text ?? request) : request,
          );
          return [
            { latest, heard: new Set([...state.heard, ...merged.reported]), requests },
            [{ ...merged, requests }],
          ] as const;
        },
      ),
      Stream.tap(({ reported, asked, requests }) =>
        heard((hearing) => {
          for (const at of reported) {
            const target = targets[at];
            if (target !== undefined) target.reported = hearing;
          }
          for (const at of asked) {
            const target = targets[at];
            const text = requests[at];
            if (target !== undefined && typeof text === "string")
              target.heardRequest = { ...hearing, text };
          }
        }),
      ),
      Stream.map(({ events }) => events),
      Stream.flattenIterable,
      Stream.changesWith(sameWorkEvent),
      Stream.takeUntil((event) => TERMINAL_WORK.has(event.status)),
    );
  };

  /**
   * A chat's open question: `answer` when the person's words can fill it,
   * else `dismissedRequestId` when forwarding them as a message dismisses it
   * (an option-only chat, whose question turn the message interrupts).
   */
  const openQuestion = (session: CallSession, threadId: ThreadId) =>
    projections.getThreadDetailById(threadId, { messageLimit: 1, activityLimit: 80 }).pipe(
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
   * Takes back what older delegations' streams sent in the HEARD_GRACE_MS
   * before a newer delegation arrived: the device had likely dropped them
   * already, so those chats are followed again and their requests repeated.
   */
  const reopenUnheard = (session: CallSession, delegationId: string, arrivedAt: number) => {
    const recent = (hearing: Hearing | null) =>
      hearing !== null &&
      hearing.delegationId !== delegationId &&
      hearing.at >= arrivedAt - HEARD_GRACE_MS;
    for (const target of session.active ?? []) {
      if (recent(target.reported)) target.reported = null;
      if (recent(target.heardRequest)) target.heardRequest = null;
    }
  };

  /**
   * Passes what was said since the last delegation to the chats it is for —
   * the agent called, unless the person's latest words named chats added to
   * the call or addressed everyone (see `callAddressing`) — each as the
   * answer to its open question when it has one a spoken answer can fill,
   * otherwise as a user message, then streams their progress merged into
   * one. Retries of one delegation id reattach to the same work instead of
   * sending again; a delegation that found nothing new is not remembered, so
   * its retry reads the transcript again once the person's words have
   * arrived.
   */
  const delegateInOrder = Effect.fnUntraced(function* (
    input: OrchestratorLiveDelegationInput,
    arrivedAt: number,
  ) {
    const session = yield* liveSession(input.sessionId);
    const answer = (work: DelegationAnswer) =>
      "status" in work
        ? Stream.make({ ...work, delegationId: input.delegationId })
        : follow(session, work, input.delegationId);
    const existing = session.requests.get(input.delegationId);
    if (existing) return answer(existing);
    const inOrder = input.sequence > session.lastSequence;
    if (inOrder) reopenUnheard(session, input.delegationId, arrivedAt);
    const delta = extractCallDelta(input.context, session.forwardedFragments);
    if (inOrder && !delta.userText && !session.awaitingWords.has(input.delegationId)) {
      // The person's words can trail GPT-Live's delegation: end quietly
      // (empty text) and the device asks again once its transcript settles.
      session.awaitingWords.add(input.delegationId);
      return answer({ delegationId: input.delegationId, status: "completed", text: "" });
    }
    if (!inOrder || !delta.userText) {
      // Nothing new for the chats: an out-of-order delegation, or one still
      // without words when asked again. Stay with work whose reply has not
      // gone out, but never hand a reply the call already heard to a new
      // request, nor a request it already heard asked: those chats come
      // with later words. End quietly when nothing is left.
      const active = session.active;
      const unheard = (active ?? []).filter(
        (target) => target.reported === null && target.heardRequest === null,
      );
      const target: DelegationAnswer =
        active === null
          ? {
              delegationId: input.delegationId,
              status: "completed",
              text: "I didn't catch a new request. Ask the person to say it again.",
            }
          : unheard.length === 0
            ? { delegationId: input.delegationId, status: "completed", text: "" }
            : unheard;
      return answer(target);
    }
    const participants = Option.match(yield* calls.get(session.callId), {
      onNone: () => [],
      onSome: (call) => call.participants ?? [],
    });
    // A chat the last words went to, or one whose question the call read
    // out since, that asks a question a spoken answer can fill: unnamed words
    // answer it (see `callDelegationTargets`). An action approval, a question
    // only Solla Code can answer, one an earlier turn left open, or one the
    // person talked past (heard before their last words) keeps nobody's words.
    const { lastDelivery } = session;
    const askedBy = (session.active ?? []).filter(
      (target) =>
        !target.primary &&
        participants.some((participant) => participant.threadId === target.threadId) &&
        (lastDelivery.targets.includes(target) ||
          (target.heardRequest !== null && target.heardRequest.sequence >= lastDelivery.sequence)),
    );
    const asking = new Set<ThreadId>();
    if (askedBy.length > 0)
      for (const threadId of [session.threadId, ...askedBy.map((target) => target.threadId)]) {
        const shell = yield* projections
          .getThreadShellById(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(shell) || !shell.value.hasPendingUserInput) continue;
        if ((yield* openQuestion(session, threadId)).answer !== null) asking.add(threadId);
      }
    const addressing = callAddressing(
      delta.latestUserText || delta.userText,
      { threadId: session.threadId, name: session.agentName },
      participants,
      asking,
    );
    const chosen = addressing.targets.slice(0, 1 + AGENT_CALL_MAX_PARTICIPANTS);
    const onCall = [
      { threadId: session.threadId, name: session.agentName },
      ...participants.map((participant) => ({
        threadId: participant.threadId,
        name: participant.title,
      })),
    ];
    /** With chats added to the call, every message says who is on it. */
    const messageFor = (target: CallDelegationTarget) => {
      if (participants.length === 0) return forwardedCallMessage(delta);
      const others = onCall
        .filter((entry) => entry.threadId !== target.threadId)
        .map((entry) => entry.name);
      const forwarded = forwardedCallMessage(delta, target.primary ? undefined : session.agentName);
      return `${forwarded}\n${groupCallNote({ others, everyone: addressing.everyone })}`;
    };
    let undelivered = 0;
    const sendTo = Effect.fnUntraced(function* (
      target: CallDelegationTarget,
    ): Effect.fn.Return<DelegationTarget, OrchestratorLiveError> {
      const shell = yield* projections
        .getThreadShellById(target.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(shell)) {
        if (target.primary) {
          // The chat was deleted: nothing can reach it, so the call is over.
          sessions.delete(input.sessionId);
          yield* calls.fail(session.callId);
          return yield* ended("This agent's chat is no longer available.");
        }
        // A chat added to the call went away: it leaves; the call goes on.
        yield* leave(session, target.threadId);
        return {
          ...target,
          work: failedWork(input.delegationId, PARTICIPANT_GONE),
          reported: null,
          heardRequest: null,
        };
      }
      const id = forwardIdFor(
        target.primary
          ? [input.sessionId, input.delegationId]
          : [input.sessionId, input.delegationId, target.threadId],
      );
      const commandId = CommandId.make(`agent-call:${id}`);
      const sentAt = DateTime.formatIso(yield* DateTime.now);
      const open = shell.value.hasPendingUserInput
        ? yield* openQuestion(session, target.threadId)
        : { answer: null, dismissedRequestId: null };
      const question = open.answer;
      const messageId = MessageId.make(`agent-call:${id}`);
      const work: AgentCallWatchTarget =
        question === null
          ? {
              messageId,
              answeredRequestId: open.dismissedRequestId,
              sentAt,
              busyTurnId: runningTurnOf(shell.value),
            }
          : { messageId: null, answeredRequestId: question.requestId, sentAt, busyTurnId: null };
      const sent = (
        question === null
          ? // The person spoke to this chat directly: no sender chat.
            engine.dispatch({
              type: "thread.turn.start",
              commandId,
              threadId: target.threadId,
              message: {
                messageId,
                role: "user",
                text: messageFor(target),
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
              threadId: target.threadId,
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
              detail: "I couldn't get started on that. Try again.",
            }),
        ),
      );
      if (chosen.length === 1) yield* sent;
      else if ((yield* Effect.result(sent))._tag === "Failure") {
        // One chat refusing doesn't hold up the others; it reads as failed.
        undelivered += 1;
        return {
          ...target,
          work: failedWork(input.delegationId, "I didn't catch that request."),
          reported: null,
          heardRequest: null,
        };
      }
      if (work.answeredRequestId !== null) session.answeredRequestIds.add(work.answeredRequestId);
      return { ...target, work, reported: null, heardRequest: null };
    });
    // Read finished answers before dispatching more words to the same chat:
    // the newer turn can replace its projection before the old stream is read.
    const previousReplies = new Map<ThreadId, string>();
    for (const previous of session.active ?? []) {
      if (previous.reported !== null || !chosen.some((next) => next.threadId === previous.threadId))
        continue;
      const work = previous.work;
      const event =
        "sentAt" in work
          ? Option.map(yield* readView(previous.threadId, work), (view) =>
              workEvent(work, input.delegationId, view),
            )
          : Option.some(work);
      if (Option.isSome(event) && TERMINAL_WORK.has(event.value.status) && event.value.text)
        previousReplies.set(previous.threadId, event.value.text);
    }
    const delivered = yield* Effect.forEach(chosen, (target) =>
      sendTo(target).pipe(
        Effect.map((sent) => {
          const previousReply = previousReplies.get(target.threadId);
          return previousReply === undefined ? sent : { ...sent, previousReply };
        }),
      ),
    );
    if (undelivered > 0 && !delivered.some((target) => "sentAt" in target.work))
      return yield* new OrchestratorLiveError({
        status: 502,
        detail: "I couldn't get started on that. Try again.",
      });
    // Chats still on the call whose reply to earlier words has not gone
    // out stay followed: the client drops an older delegation's stream once
    // a newer one starts, so their replies come with this one.
    const carried = (session.active ?? []).filter(
      (target) =>
        target.reported === null &&
        !delivered.some((next) => next.threadId === target.threadId) &&
        (target.primary ||
          participants.some((participant) => participant.threadId === target.threadId)),
    );
    const targets = [...delivered, ...carried];
    session.requests.set(input.delegationId, targets);
    session.active = targets;
    session.lastDelivery = { sequence: input.sequence, targets: delivered };
    session.lastSequence = input.sequence;
    session.forwardedFragments = new Set(delta.fragments);
    return answer(targets);
  });

  const delegate = Effect.fn("AgentCallLive.delegate")(function* (
    input: OrchestratorLiveDelegationInput,
  ) {
    // Noted as it arrives, before waiting its turn: from now on the device
    // reads this delegation's stream, not an older one's.
    const arrivedAt = yield* nowMs;
    const session = sessions.get(input.sessionId);
    if (session !== undefined && input.sequence > (session.newest?.sequence ?? 0))
      session.newest = { delegationId: input.delegationId, sequence: input.sequence };
    return yield* semaphore.withPermits(1)(delegateInOrder(input, arrivedAt));
  });

  /** The roster a live call's voice started with; ended once no session holds the call. */
  const roster = Effect.fn("AgentCallLive.roster")(function* (callId: AgentCallId) {
    yield* prune;
    for (const session of sessions.values()) if (session.callId === callId) return session.roster;
    return yield* new AgentCallError({ detail: "This call has ended." });
  });

  /**
   * Adds a chat to an active call: it must exist and may join (see
   * `callParticipantFor`); an agent's main chat joins as the agent.
   */
  const addParticipant = Effect.fn("AgentCallLive.addParticipant")(function* (
    input: AgentCallParticipantInput,
  ) {
    const [thread, owner] = yield* Effect.all([
      projections.getThreadShellById(input.threadId),
      agents.getByThreadId(input.threadId),
    ]).pipe(Effect.mapError(() => new AgentCallError({ detail: "Could not look up that chat." })));
    const participant = callParticipantFor({
      threadId: input.threadId,
      thread: Option.getOrNull(thread),
      agent: Option.getOrNull(owner),
    });
    if ("refusal" in participant) return yield* new AgentCallError({ detail: participant.refusal });
    return yield* calls.addParticipant(input.callId, participant);
  });

  return {
    start,
    startGrok,
    delegate,
    roster,
    addParticipant,
    /** Takes a chat off a call. Idempotent. */
    removeParticipant: (input: AgentCallParticipantInput) =>
      calls.removeParticipant(input.callId, input.threadId),
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

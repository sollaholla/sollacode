// @effect-diagnostics preferSchemaOverJson:off
import { assert, it } from "@effect/vitest";
import {
  AGENT_CALL_LEASE_SECONDS,
  AGENT_CALL_SESSION_PATH,
  AGENT_CALL_SESSION_RELEASE_PATH,
  AgentCallId,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthVmOperateScope,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  VmAgentId,
  VmId,
  type AuthEnvironmentScope,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type VmAgent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { agentCallRouteLayer } from "../http.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import {
  ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
  ThreadWorkObligationRepository,
  type ThreadWorkObligation,
} from "../persistence/Services/ThreadWorkObligations.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  agentCallInstructions,
  agentCallWorkEvent,
  extractCallDelta,
  forwardedCallMessage,
  AgentCallLiveLayer,
  makeAgentCallLive,
  spokenReplies,
  spokenReply,
  voiceAnswerableRequest,
  type AgentCallThreadView,
  type AgentCallWatchTarget,
} from "./AgentCallLive.ts";
import { AgentCalls, layer as AgentCallsLayer } from "./AgentCalls.ts";

const at = (second: number) => `2026-10-28T12:00:${String(second).padStart(2, "0")}.000Z`;
const threadId = ThreadId.make("thread-scout");
const vmAgentId = VmAgentId.make("agent-scout");
const agent: VmAgent = {
  vmAgentId,
  name: "Scout",
  handle: "scout",
  purpose: "Watch the deploy dashboards",
  vmId: VmId.make("vm-scout"),
  threadId,
  status: "running",
  controlMode: "agent",
  icon: null,
  guestIp: null,
  lastError: null,
  createdAt: at(0),
  updatedAt: at(0),
};

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  second: number,
  extra: Partial<OrchestrationMessage> = {},
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: at(second),
  updatedAt: at(second),
  ...extra,
});
const activity = (
  kind: string,
  payload: unknown,
  summary = "Approval requested",
  second = 5,
): OrchestrationThreadActivity => ({
  id: EventId.make(`${kind}:${JSON.stringify(payload)}`),
  tone: "approval",
  kind,
  summary,
  payload,
  turnId: null,
  createdAt: at(second),
});
const view = (
  thread: Partial<Pick<OrchestrationThread, "messages" | "activities" | "latestTurn" | "session">>,
  flags: Partial<
    Pick<AgentCallThreadView, "hasPendingApprovals" | "hasPendingUserInput" | "delivery">
  > = {},
): AgentCallThreadView => ({
  thread: { messages: [], activities: [], latestTurn: null, session: null, ...thread },
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  delivery: "settled",
  ...flags,
});
const turn = (
  state: NonNullable<OrchestrationThread["latestTurn"]>["state"],
  completedSecond: number | null,
  options: { readonly turnId?: string; readonly requestedSecond?: number } = {},
): OrchestrationThread["latestTurn"] => ({
  turnId: TurnId.make(options.turnId ?? "turn"),
  state,
  requestedAt: at(options.requestedSecond ?? 10),
  startedAt: at(options.requestedSecond ?? 10),
  completedAt: completedSecond === null ? null : at(completedSecond),
  assistantMessageId: null,
});
const session = (
  status: NonNullable<OrchestrationThread["session"]>["status"],
  lastError: string | null = null,
  providerName: string | null = null,
): OrchestrationThread["session"] => ({
  threadId,
  status,
  providerName,
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError,
  updatedAt: at(9),
});
const question = (requestId = "ask", second = 5) =>
  activity(
    "user-input.requested",
    {
      requestId,
      questions: [
        {
          id: "Which account should I use?",
          header: "Account",
          question: "Which account should I use?",
          options: [],
        },
      ],
    },
    "User input requested",
    second,
  );

it("forwards each transcript fragment once, whenever its transcript arrives", () => {
  const context = [
    "user: from earlier in the chat",
    "user [0-800ms]: Can you",
    "user [800-1400ms]:  check the deploy?",
    "assistant [1500-2100ms]: Sure,",
    "assistant [2100-2600ms]:  I'll ask my chat.",
  ].join("\n");
  const first = extractCallDelta(context, new Set());
  assert.strictEqual(first.userText, "Can you check the deploy?");
  assert.strictEqual(first.assistantText, "Sure, I'll ask my chat.");
  assert.strictEqual(first.fragments.length, 4);
  assert.strictEqual(
    forwardedCallMessage(first),
    "From our voice call:\nYou said: Can you check the deploy?\n(On the call I replied: Sure, I'll ask my chat.)",
  );

  // Already forwarded: nothing new.
  const again = extractCallDelta(context, new Set(first.fragments));
  assert.deepStrictEqual([again.userText, again.assistantText], ["", ""]);

  // The assistant's later line was forwarded with "Thanks."; the person's
  // earlier words only transcribed afterwards still go out next time.
  const second = extractCallDelta(
    `${context}\nassistant [4000-5200ms]: One moment.\nuser [5300-5600ms]: Thanks.`,
    new Set(first.fragments),
  );
  assert.deepStrictEqual([second.userText, second.assistantText], ["Thanks.", "One moment."]);
  const late = extractCallDelta(
    [
      context,
      "user [2300-3800ms]: And staging too.",
      "assistant [4000-5200ms]: One moment.",
      "user [5300-5600ms]: Thanks.",
    ].join("\n"),
    new Set(second.fragments),
  );
  assert.deepStrictEqual([late.userText, late.assistantText], ["And staging too.", ""]);

  assert.deepStrictEqual(extractCallDelta("user: no timestamps", new Set()), {
    userText: "",
    assistantText: "",
    fragments: [],
  });
  // Deltas carry their own spacing and are joined as they come, like the
  // call caption; a fragment that shares its neighbour's boundary still counts.
  assert.strictEqual(
    extractCallDelta("user [0-100ms]: Hel\nuser [100-200ms]: lo, there", new Set()).userText,
    "Hello, there",
  );
  // Fractional timestamps, and a fragment whose text spans lines.
  assert.strictEqual(
    extractCallDelta("user [12.5-80.25ms]: Deploy\nto staging\nuser [81-90ms]:  now", new Set())
      .userText,
    "Deploy to staging now",
  );
});

it("builds the call persona from the agent and why it called", () => {
  const incoming = agentCallInstructions({
    name: "Scout",
    purpose: "Watch the deploy dashboards",
    language: "en",
    direction: "incoming",
    topic: "The deploy is blocked on a login",
  });
  assert.include(incoming, "You are Scout, one of the person's Solla Code agents");
  assert.include(incoming, "Your job: Watch the deploy dashboards.");
  assert.include(incoming, "Speak English.");
  assert.include(incoming, "hearing a transcript is not approval");
  assert.include(
    incoming,
    "You called the person because: The deploy is blocked on a login. Open by greeting them",
  );
  const outgoing = agentCallInstructions({
    name: "Scout",
    purpose: "Triage.",
    language: "fr",
    direction: "outgoing",
    topic: null,
  });
  assert.include(outgoing, "Your job: Triage.\n");
  assert.include(outgoing, "Speak French.");
  assert.notInclude(outgoing, "You called the person");
});

it("speaks short replies whole and long ones up to a sentence", () => {
  assert.strictEqual(
    spokenReply("Done.\n\n```ts\nconst x = 1;\n```"),
    "Done. (code is in my chat)",
  );
  const long = `${"The deploy is green. ".repeat(100)}`;
  const spoken = spokenReply(long, 200);
  assert.isAtMost(spoken.length, 230);
  assert.match(spoken, /green\. The full reply is in my chat\.$/u);
});

it("speaks a long reply from its end: the final message, then earlier ones while they fit", () => {
  // Short replies in several segments are spoken whole.
  assert.strictEqual(
    spokenReplies(["Checked the dashboard.", "  ", "All green."]),
    "Checked the dashboard. All green.",
  );
  assert.strictEqual(spokenReplies(["", "  "]), "");
  // A tool-heavy turn narrates before it answers; the answer is never cut.
  const summary = `${"Every service reports healthy after the rollout. ".repeat(24)}The deploy is green.`;
  const spoken = spokenReplies([
    "I'll check the dashboard.",
    "Reading the deploy logs line by line. ".repeat(10),
    "Now the metrics.",
    summary,
  ]);
  assert.match(spoken, /^Now the metrics\. Every service/u);
  assert.match(spoken, /The deploy is green\. The full reply is in my chat\.$/u);
  assert.notInclude(spoken, "I'll check the dashboard.");
  // A final message too long on its own is cut at a sentence.
  const alone = spokenReplies(["Checking.", "The deploy is green. ".repeat(100)]);
  assert.match(alone, /^The deploy is green\./u);
  assert.match(alone, /The full reply is in my chat\.$/u);
  assert.isAtMost(alone.length, 1_550);
});

it("follows the chat's work on what the call passed it", () => {
  const sentAt = at(10);
  const forwarded = (busyTurnId: string | null = null): AgentCallWatchTarget => ({
    messageId: MessageId.make("forwarded"),
    answeredRequestId: null,
    sentAt,
    busyTurnId: busyTurnId === null ? null : TurnId.make(busyTurnId),
  });
  const event = (input: AgentCallThreadView, target = forwarded()) =>
    agentCallWorkEvent({ delegationId: "delegation", target, view: input });

  assert.deepStrictEqual(event(view({})), {
    delegationId: "delegation",
    status: "running",
    text: "Passing that to my chat.",
  });
  // The previous turn finished before the words arrived: not a reply yet.
  assert.strictEqual(
    event(
      view({
        messages: [message("earlier", "assistant", "Old reply.", 1)],
        latestTurn: turn("completed", 2, { requestedSecond: 0 }),
        session: session("ready"),
      }),
    ).status,
    "running",
  );
  assert.strictEqual(
    event(view({ session: session("running"), latestTurn: turn("running", null) })).text,
    "Working on it in my chat.",
  );
  // The reply is what was written since; the forwarded message itself need
  // not be in the newest-messages window.
  assert.deepStrictEqual(
    event(
      view({
        messages: [
          message("earlier", "assistant", "Old reply.", 1),
          message("reply", "assistant", "The deploy is green.", 12),
        ],
        latestTurn: turn("completed", 13),
        session: session("ready"),
      }),
    ),
    { delegationId: "delegation", status: "completed", text: "The deploy is green." },
  );
  // Text still streaming is not the final reply.
  assert.strictEqual(
    event(
      view({
        messages: [message("reply", "assistant", "The dep", 12, { streaming: true })],
        latestTurn: turn("completed", 13),
        session: session("ready"),
      }),
    ).status,
    "running",
  );
  assert.deepStrictEqual(
    event(
      view({ latestTurn: turn("error", 13), session: session("error", "Provider unavailable") }),
    ),
    { delegationId: "delegation", status: "failed", text: "Provider unavailable" },
  );
  assert.strictEqual(event(view({}, { delivery: "cancelled" })).status, "failed");

  // A turn already running when the message arrived doesn't answer it unless
  // the message joined it: interrupted for a follow-up, it is still queued.
  const busyTurn = turn("interrupted", 11, { turnId: "busy", requestedSecond: 1 });
  const busyTail = message("busy-tail", "assistant", "Stopping the old task.", 10, {
    turnId: TurnId.make("busy"),
  });
  assert.strictEqual(
    event(
      view(
        { messages: [busyTail], latestTurn: busyTurn, session: session("ready") },
        { delivery: "pending" },
      ),
      forwarded("busy"),
    ).status,
    "queued",
  );
  // Steered into the busy turn, that turn's reply is the answer.
  assert.deepStrictEqual(
    event(
      view({
        messages: [
          message("steered", "assistant", "Staging is green too.", 12, {
            turnId: TurnId.make("busy"),
          }),
        ],
        latestTurn: turn("completed", 13, { turnId: "busy", requestedSecond: 1 }),
        session: session("ready"),
      }),
      forwarded("busy"),
    ).text,
    "Staging is green too.",
  );
  // Delivered as the next turn: only that turn's words are the reply.
  assert.deepStrictEqual(
    event(
      view({
        messages: [
          busyTail,
          message("reply", "assistant", "Staging is green.", 15, { turnId: TurnId.make("next") }),
        ],
        latestTurn: turn("completed", 16, { turnId: "next" }),
        session: session("ready"),
      }),
      forwarded("busy"),
    ).text,
    "Staging is green.",
  );

  // A request opened before the words arrived does not hide their finished
  // reply (an old action-approval card left on the thread).
  const oldCard = activity("user-input.requested", {
    requestId: "old-send",
    questions: [{ id: "q", header: "Send", question: "Send the email?", options: [] }],
    actionApproval: { actionKind: "send_email" },
  });
  const finished = {
    messages: [message("reply", "assistant", "Done.", 12)],
    latestTurn: turn("completed", 13),
    session: session("ready"),
  };
  assert.strictEqual(
    event(view({ ...finished, activities: [oldCard] }, { hasPendingUserInput: true })).status,
    "completed",
  );
  // One raised since keeps the call waiting on the person.
  const waiting = event(
    view({ ...finished, activities: [question("ask", 12)] }, { hasPendingUserInput: true }),
  );
  assert.strictEqual(waiting.status, "waiting-input");
  assert.include(waiting.text, "My chat is asking you: Which account should I use?");

  const notByVoice = event(
    view(
      {
        activities: [
          activity("user-input.requested", { requestId: "pick", detail: "Pick a file" }, "Input"),
        ],
        latestTurn: turn("running", null),
      },
      { hasPendingUserInput: true },
    ),
  );
  assert.strictEqual(notByVoice.status, "waiting-input");
  assert.include(notByVoice.text, "has to be answered in Solla Code");

  const actionApproval = activity("user-input.requested", {
    requestId: "send",
    questions: [{ id: "q", header: "Send", question: "Send the email to Ana?", options: [] }],
    actionApproval: { actionKind: "send_email" },
  });
  const approval = event(
    view(
      { activities: [actionApproval], latestTurn: turn("running", null) },
      { hasPendingUserInput: true },
    ),
  );
  assert.strictEqual(approval.status, "pending-approval");
  assert.include(approval.text, "Send the email to Ana?");

  const command = activity(
    "approval.requested",
    { requestId: "cmd", detail: "git push" },
    "Command approval requested",
  );
  const resolvedEarlier = [
    activity("approval.requested", { requestId: "old" }),
    activity("approval.resolved", { requestId: "old" }),
  ];
  const pending = event(
    view(
      { activities: [...resolvedEarlier, command], latestTurn: turn("running", null) },
      { hasPendingApprovals: true },
    ),
  );
  assert.strictEqual(pending.status, "pending-approval");
  assert.include(pending.text, "Command approval requested: git push");
});

it("follows a spoken answer to the chat's question", () => {
  const answered: AgentCallWatchTarget = {
    messageId: null,
    answeredRequestId: "ask",
    sentAt: at(10),
    busyTurnId: null,
  };
  const event = (input: AgentCallThreadView) =>
    agentCallWorkEvent({ delegationId: "delegation", target: answered, view: input });
  // The answered question still looks open until its resolution lands.
  assert.strictEqual(
    event(
      view(
        { activities: [question()], latestTurn: turn("running", null, { requestedSecond: 1 }) },
        { hasPendingUserInput: true },
      ),
    ).status,
    "running",
  );
  assert.strictEqual(
    event(
      view({
        activities: [
          question(),
          activity(
            "provider.user-input.respond.failed",
            { requestId: "ask", detail: "gone" },
            "Failed",
            10,
          ),
        ],
      }),
    ).status,
    "failed",
  );
  assert.deepStrictEqual(
    event(
      view({
        messages: [message("reply", "assistant", "Using the work account.", 12)],
        activities: [
          question(),
          activity("user-input.resolved", { requestId: "ask" }, "User input resolved", 11),
        ],
        latestTurn: turn("completed", 13, { requestedSecond: 1 }),
        session: session("ready"),
      }),
    ),
    { delegationId: "delegation", status: "completed", text: "Using the work account." },
  );
});

it("credits a turn the words were steered into before the shell showed it running", () => {
  const target: AgentCallWatchTarget = {
    messageId: MessageId.make("forwarded"),
    answeredRequestId: null,
    sentAt: at(10),
    busyTurnId: null,
  };
  const steered = view({
    messages: [
      message("reply", "assistant", "Staging is green.", 12, { turnId: TurnId.make("live") }),
    ],
    latestTurn: turn("completed", 13, { turnId: "live", requestedSecond: 5 }),
    session: session("ready"),
  });
  assert.deepStrictEqual(
    agentCallWorkEvent({ delegationId: "delegation", target, view: steered }),
    {
      delegationId: "delegation",
      status: "completed",
      text: "Staging is green.",
    },
  );
  // Until the provider confirms the steer (a refused one gives the words their
  // own turn later), that turn is not the reply; the steer is still under way.
  assert.deepStrictEqual(
    agentCallWorkEvent({
      delegationId: "delegation",
      target,
      view: { ...steered, delivery: "unconfirmed" },
    }),
    { delegationId: "delegation", status: "running", text: "Working on it in my chat." },
  );
  // Steered into the turn the call saw running, an unconfirmed steer is being
  // worked on, not waiting behind that turn the way a queued message is.
  const busyTarget = { ...target, busyTurnId: TurnId.make("busy") };
  const busy = (delivery: AgentCallThreadView["delivery"]) =>
    agentCallWorkEvent({
      delegationId: "delegation",
      target: busyTarget,
      view: view(
        {
          latestTurn: turn("running", null, { turnId: "busy", requestedSecond: 5 }),
          session: session("running"),
        },
        { delivery },
      ),
    });
  assert.deepStrictEqual(busy("unconfirmed"), {
    delegationId: "delegation",
    status: "running",
    text: "Working on it in my chat.",
  });
  assert.strictEqual(busy("pending").status, "queued");
});

it("reads an earlier turn's leftover question as over", () => {
  const running = turn("running", null, { turnId: "turn-2", requestedSecond: 1 });
  const orphaned = view(
    {
      activities: [{ ...question("old-ask"), turnId: TurnId.make("turn-1") }],
      latestTurn: running,
      session: session("running"),
    },
    // The pending flag ignores turns, so the orphan keeps it set.
    { hasPendingUserInput: true },
  );
  assert.deepStrictEqual(
    agentCallWorkEvent({
      delegationId: "delegation",
      target: {
        messageId: MessageId.make("forwarded"),
        answeredRequestId: null,
        sentAt: at(10),
        busyTurnId: TurnId.make("turn-2"),
      },
      view: orphaned,
    }),
    { delegationId: "delegation", status: "running", text: "Working on it in my chat." },
  );
});

it("answers by voice only questions whose provider keeps free text", () => {
  assert.deepStrictEqual(voiceAnswerableRequest(question(), "codex"), {
    requestId: "ask",
    questionIds: ["Which account should I use?"],
  });
  assert.isNotNull(voiceAnswerableRequest(question(), "claudeAgent"));
  // Kimi takes only one of its own option labels; free text dismisses the question.
  assert.isNull(voiceAnswerableRequest(question(), "kimi"));
  const kimiEvent = (activities: ReadonlyArray<OrchestrationThreadActivity>) =>
    agentCallWorkEvent({
      delegationId: "delegation",
      // The forwarded words dismissed the question open when they were sent.
      target: {
        messageId: MessageId.make("forwarded"),
        answeredRequestId: "ask",
        sentAt: at(10),
        busyTurnId: null,
      },
      view: view(
        {
          activities: [...activities],
          latestTurn: turn("running", null),
          session: session("running", null, "kimi"),
        },
        { hasPendingUserInput: true },
      ),
    });
  // Until the dismissal lands, the work is just running.
  assert.deepStrictEqual(kimiEvent([question()]), {
    delegationId: "delegation",
    status: "running",
    text: "Working on it in my chat.",
  });
  // A question the chat asks after that has to be answered in the app.
  const waiting = kimiEvent([question(), question("ask-2", 12)]);
  assert.strictEqual(waiting.status, "waiting-input");
  assert.include(waiting.text, "has to be answered in Solla Code");
});

const decodeFetchBody = async (init?: RequestInit) =>
  (await new Response(init?.body).json()) as { session: { instructions: string; audio: unknown } };

function fixture(options: { readonly liveStatus?: number } = {}) {
  const requests: Array<{ session: { instructions: string; audio: unknown } }> = [];
  const dispatched: OrchestrationCommand[] = [];
  /** When set, every dispatch signals `entered` and waits for `release`. */
  let dispatchGate: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null = null;
  /** The forwarded message's delivery row; none reads as delivered. */
  let obligation = Option.none<ThreadWorkObligation>();
  /** Signalled by every read of the delivery row while set. */
  let deliveryRead: Deferred.Deferred<void> | null = null;
  let chatExists = true;
  let thread: AgentCallThreadView["thread"] = {
    messages: [],
    activities: [],
    latestTurn: null,
    session: null,
  };
  let shell = {
    runtimeMode: "approval-required" as const,
    interactionMode: "agent" as const,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null as OrchestrationThread["session"],
    latestTurn: null as OrchestrationThread["latestTurn"],
  };
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    orchestrator: { ...DEFAULT_SERVER_SETTINGS.orchestrator, voice: "alloy" },
  };
  const fetch: typeof globalThis.fetch = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(await decodeFetchBody(init));
      return options.liveStatus
        ? new Response("upstream", { status: options.liveStatus })
        : Response.json({
            session: { id: "live-call" },
            transport: { type: "webrtc", sdp: "answer" },
          });
    },
    { preconnect: () => undefined },
  );
  const base = Layer.mergeAll(
    Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
    Layer.mock(ServerSecretStore)({
      get: (name) =>
        Effect.succeed(
          name === "orchestrator-openai-api-key"
            ? Option.some(new TextEncoder().encode("sk-fixture"))
            : Option.none(),
        ),
    }),
    Layer.mock(VmAgentStore)({ getById: () => Effect.succeed(Option.some(agent)) }),
  );
  return {
    requests,
    dispatched,
    setThread: (next: Partial<AgentCallThreadView["thread"]>) => {
      thread = { ...thread, ...next };
    },
    setShell: (next: Partial<typeof shell>) => {
      shell = { ...shell, ...next };
    },
    setDispatchGate: (gate: typeof dispatchGate) => {
      dispatchGate = gate;
    },
    setDeliveryRead: (signal: Deferred.Deferred<void>) => {
      deliveryRead = signal;
    },
    setObligation: (next: Partial<ThreadWorkObligation> | null) => {
      obligation =
        next === null
          ? Option.none()
          : Option.some({
              obligationId: "obligation",
              threadId,
              sourceTurnId: TurnId.make("source"),
              kind: "active-turn-recovery",
              state: "completed",
              providerInstanceId: ProviderInstanceId.make("codex"),
              attempt: 1,
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: null,
              createdAt: at(0),
              updatedAt: at(0),
              ...next,
            });
    },
    /** The agent's chat is deleted. */
    removeChat: () => {
      chatExists = false;
    },
    layer: (events: PubSub.PubSub<OrchestrationEvent>, firstRead?: Deferred.Deferred<void>) =>
      Layer.mergeAll(
        AgentCallsLayer.pipe(Layer.provideMerge(base)),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.gen(function* () {
              if (dispatchGate) {
                yield* Deferred.succeed(dispatchGate.entered, undefined);
                yield* Deferred.await(dispatchGate.release);
              }
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.fromPubSub(events),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () =>
            Effect.sync(() => (chatExists ? Option.some({ ...shell } as never) : Option.none())),
          getThreadDetailById: () =>
            Effect.gen(function* () {
              const current = { ...thread };
              if (firstRead) yield* Deferred.succeed(firstRead, undefined);
              return Option.some(current as never);
            }),
        }),
        // Forwarded messages have been delivered unless a test says otherwise.
        Layer.mock(ThreadWorkObligationRepository)({
          getByKey: () =>
            Effect.gen(function* () {
              const current = obligation;
              if (deliveryRead) yield* Deferred.succeed(deliveryRead, undefined);
              return current;
            }),
        }),
        FetchHttpClient.layer,
      ).pipe(Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch))),
  };
}

const offer = { sdp: "offer", history: [] };
const sessionSet = {
  type: "thread.session-set",
  aggregateKind: "thread",
  aggregateId: threadId,
} as never;

it.effect("answering claims the call once and opens GPT-Live as the agent", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const rung = yield* calls.ring({
        vmAgentId,
        reason: "blocker",
        topic: "Sign in to Google.",
        key: "blocker:one",
      });
      if (rung.status !== "ringing") return assert.fail(rung.status);
      const result = yield* live.start({ callId: rung.call.callId, ...offer }, "Sol's iPhone");
      assert.deepStrictEqual(result, {
        sessionId: "live-call",
        sdp: "answer",
        model: "gpt-live-1",
        voice: "marin",
        agentName: "Scout",
      });
      assert.include(f.requests[0]?.session.instructions, "You are Scout");
      assert.include(f.requests[0]?.session.instructions, "because: Sign in to Google.");
      assert.notInclude(JSON.stringify(result), "sk-fixture");
      const answered = Option.getOrUndefined(yield* calls.get(rung.call.callId));
      assert.strictEqual(answered?.status, "active");
      assert.strictEqual(answered?.answeredBy, "Sol's iPhone");

      const second = yield* Effect.flip(
        live.start({ callId: rung.call.callId, ...offer }, "Office Mac"),
      );
      assert.strictEqual(second.status, 409);
      assert.strictEqual(second.detail, "Answered on Sol's iPhone");
      assert.strictEqual(f.requests.length, 1);

      const unknown = yield* Effect.flip(
        live.start({ callId: AgentCallId.make("gone"), ...offer }, "Office Mac"),
      );
      assert.strictEqual(unknown.status, 409);

      yield* live.release("live-call");
      assert.strictEqual(
        Option.getOrUndefined(yield* calls.get(rung.call.callId))?.status,
        "ended",
      );
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("a GPT-Live failure fails the call instead of leaving it active", () => {
  const f = fixture({ liveStatus: 500 });
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      const error = yield* Effect.flip(
        live.start({ callId: placed.callId, ...offer }, "Office Mac"),
      );
      assert.strictEqual(error.status, 502);
      assert.strictEqual(Option.getOrUndefined(yield* calls.get(placed.callId))?.status, "failed");
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("heartbeats and delegations keep the call; silence ends it", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      yield* TestClock.adjust(`${AGENT_CALL_LEASE_SECONDS - 10} seconds`);
      yield* live.heartbeat("live-call");
      yield* TestClock.adjust(`${AGENT_CALL_LEASE_SECONDS - 10} seconds`);
      yield* live
        .delegate({
          sessionId: "live-call",
          delegationId: "d1",
          sequence: 1,
          context: "user [0-900ms]: Is the deploy green?",
        })
        .pipe(Effect.asVoid);
      yield* TestClock.adjust(`${AGENT_CALL_LEASE_SECONDS - 1} seconds`);
      assert.strictEqual(Option.getOrUndefined(yield* calls.get(placed.callId))?.status, "active");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(Option.getOrUndefined(yield* calls.get(placed.callId))?.status, "ended");
      assert.strictEqual((yield* Effect.flip(live.heartbeat("live-call"))).status, 409);
      assert.strictEqual((yield* Effect.flip(live.heartbeat("unknown"))).status, 409);
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("forwards each stretch of the call once and streams the chat's reply", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at(0)));
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const firstRead = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      const context = "user: earlier\nuser [0-900ms]: Is the deploy green?";
      const request = { sessionId: "live-call", delegationId: "d1", sequence: 1, context };

      const stream = yield* live.delegate(request);
      assert.strictEqual(f.dispatched.length, 1);
      const command = f.dispatched[0];
      if (command?.type !== "thread.turn.start") return assert.fail("expected a turn start");
      assert.strictEqual(command.threadId, threadId);
      assert.strictEqual(
        command.message.text,
        "From our voice call:\nYou said: Is the deploy green?",
      );
      assert.strictEqual(command.message.inputOrigin, "transcription");
      assert.strictEqual(command.runtimeMode, "approval-required");
      assert.strictEqual(command.interactionMode, "agent");
      const sentSecond = Number(command.createdAt.slice(17, 19));

      // The chat is still working when the stream starts.
      f.setThread({
        session: session("running"),
        latestTurn: turn("running", null, { requestedSecond: sentSecond }),
      });
      const fiber = yield* Stream.runCollect(stream).pipe(Effect.forkChild);
      yield* Deferred.await(firstRead);
      f.setThread({
        messages: [message("reply", "assistant", "Yes, all green.", sentSecond)],
        session: session("ready"),
        latestTurn: turn("completed", sentSecond, { requestedSecond: sentSecond }),
      });
      yield* PubSub.publish(events, sessionSet);
      const updates = [...(yield* Fiber.join(fiber))];
      assert.deepStrictEqual(
        updates.map((update) => update.status),
        ["running", "completed"],
      );
      assert.strictEqual(updates.at(-1)?.text, "Yes, all green.");

      // A retry of the same delegation reattaches instead of sending again.
      const retried = yield* live.delegate(request);
      assert.strictEqual(f.dispatched.length, 1);
      assert.strictEqual((yield* Stream.runCollect(retried)).at(-1)?.status, "completed");

      // A new delegation with no new words (its transcript trails it) neither
      // re-sends nor repeats the finished reply: it ends quietly.
      const quiet = yield* live.delegate({ ...request, delegationId: "d-quiet", sequence: 2 });
      assert.strictEqual(f.dispatched.length, 1);
      assert.deepStrictEqual(
        [...(yield* Stream.runCollect(quiet))],
        [{ delegationId: "d-quiet", status: "completed", text: "" }],
      );

      // It is not remembered: retried once the person's words have arrived,
      // it forwards them, and only what was said since.
      yield* TestClock.adjust("1 second");
      const nextUpdates = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d-quiet",
        sequence: 2,
        context: `${context}\nassistant [1000-1500ms]: Checking.\nuser [2000-2400ms]: And staging?`,
      });
      const next = f.dispatched[1];
      assert.strictEqual(
        next?.type === "thread.turn.start" ? next.message.text : undefined,
        "From our voice call:\nYou said: And staging?\n(On the call I replied: Checking.)",
      );
      assert.strictEqual(
        (yield* Stream.runHead(nextUpdates)).pipe(Option.getOrUndefined)?.status,
        "running",
      );

      // Hanging up ends the session for later delegations.
      yield* calls.end(placed.callId);
      const afterHangUp = yield* Effect.flip(
        live.delegate({ ...request, delegationId: "d3", sequence: 4 }),
      );
      assert.strictEqual(afterHangUp.status, 409);
    }).pipe(Effect.provide(f.layer(events, firstRead)));
  }).pipe(Effect.scoped);
});

it.effect("a spoken answer to the chat's open question answers it instead of queueing", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const rung = yield* calls.ring({
        vmAgentId,
        reason: "question",
        topic: "Which account should I use?",
        key: "input:thread-scout:ask",
      });
      if (rung.status !== "ringing") return assert.fail(rung.status);
      yield* live.start({ callId: rung.call.callId, ...offer }, "Sol's iPhone");
      f.setShell({
        hasPendingUserInput: true,
        session: session("running", null, "codex"),
        latestTurn: turn("running", null, { requestedSecond: 1 }),
      });
      f.setThread({
        activities: [question()],
        session: session("running", null, "codex"),
        latestTurn: turn("running", null, { requestedSecond: 1 }),
      });
      const context = "assistant [0-900ms]: Which account?\nuser [1000-1600ms]: The work one.";
      const updates = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d1",
        sequence: 1,
        context,
      });
      const command = f.dispatched[0];
      if (command?.type !== "thread.user-input.respond")
        return assert.fail("expected an answer to the open question");
      assert.strictEqual(command.requestId, "ask");
      assert.deepStrictEqual(command.answers, { "Which account should I use?": "The work one." });
      // Answered: the call no longer reads the question back.
      assert.strictEqual(
        (yield* Stream.runHead(updates)).pipe(Option.getOrUndefined)?.status,
        "running",
      );

      // Its resolution has not landed yet; what the person says next is a
      // message, not a second answer to the same question.
      yield* live
        .delegate({
          sessionId: "live-call",
          delegationId: "d2",
          sequence: 2,
          context: `${context}\nuser [2000-2600ms]: And check staging.`,
        })
        .pipe(Effect.asVoid);
      const next = f.dispatched[1];
      assert.strictEqual(next?.type, "thread.turn.start");
      assert.strictEqual(
        next?.type === "thread.turn.start" ? next.message.text : undefined,
        "From our voice call:\nYou said: And check staging.",
      );

      // An action approval is never answered by voice: the words are forwarded.
      f.setThread({
        activities: [
          activity("user-input.requested", {
            requestId: "send",
            questions: [{ id: "q", header: "Send", question: "Send it?", options: [] }],
            actionApproval: { actionKind: "send_email" },
          }),
        ],
      });
      yield* live
        .delegate({
          sessionId: "live-call",
          delegationId: "d3",
          sequence: 3,
          context: `${context}\nuser [2000-2600ms]: And check staging.\nuser [3000-3400ms]: Yes, send it.`,
        })
        .pipe(Effect.asVoid);
      assert.strictEqual(f.dispatched[2]?.type, "thread.turn.start");
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("a question its turn left behind, or its provider forgot, gets a message instead", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      // Turn 1 asked and was replaced by turn 2 without an answer; the
      // pending flag ignores turns, so it stays set.
      const running = turn("running", null, { turnId: "turn-2", requestedSecond: 1 });
      f.setShell({ hasPendingUserInput: true, session: session("running"), latestTurn: running });
      f.setThread({
        activities: [{ ...question("old-ask"), turnId: TurnId.make("turn-1") }],
        session: session("running"),
        latestTurn: running,
      });
      const context = "user [0-900ms]: How's the deploy going?";
      const updates = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d1",
        sequence: 1,
        context,
      });
      assert.strictEqual(f.dispatched[0]?.type, "thread.turn.start");
      assert.deepStrictEqual((yield* Stream.runHead(updates)).pipe(Option.getOrUndefined), {
        delegationId: "d1",
        status: "running",
        text: "Working on it in my chat.",
      });

      // A respond failure that marks the question stale settles it too.
      f.setThread({
        activities: [
          question("ask"),
          activity(
            "provider.user-input.respond.failed",
            { requestId: "ask", detail: "Unknown pending user-input request: ask" },
            "Failed",
          ),
        ],
      });
      yield* live
        .delegate({
          sessionId: "live-call",
          delegationId: "d2",
          sequence: 2,
          context: `${context}\nuser [1000-1600ms]: And staging?`,
        })
        .pipe(Effect.asVoid);
      assert.strictEqual(f.dispatched[1]?.type, "thread.turn.start");
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("on a Kimi chat the words go as a message that replaces the open question", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      const kimi = session("running", null, "kimi");
      const running = turn("running", null, { requestedSecond: 1 });
      f.setShell({ hasPendingUserInput: true, session: kimi, latestTurn: running });
      f.setThread({ activities: [question()], session: kimi, latestTurn: running });
      const updates = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d1",
        sequence: 1,
        context: "user [0-900ms]: The work one, please.",
      });
      const command = f.dispatched[0];
      if (command?.type !== "thread.turn.start") return assert.fail("expected a forwarded message");
      assert.include(command.message.text, "You said: The work one, please.");
      // The message interrupts the question's turn, which dismisses the question:
      // the call doesn't send the person to a card that is about to go.
      const first = (yield* Stream.runHead(updates)).pipe(Option.getOrUndefined);
      assert.strictEqual(first?.status, "running");
      assert.notInclude(first?.text, "Solla Code");
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("a steer the provider has not confirmed is not the reply yet", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at(20)));
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const deliveryRead = yield* Deferred.make<void>();
    f.setDeliveryRead(deliveryRead);
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      // Nothing showed as running when the words went out, but the provider
      // had started a turn and the reactor claimed the message to steer it in.
      const stream = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d1",
        sequence: 1,
        context: "user [0-900ms]: And staging?",
      });
      f.setThread({
        messages: [message("reply", "assistant", "Staging is green.", 22)],
        latestTurn: turn("completed", 23, { turnId: "live", requestedSecond: 15 }),
        session: session("ready"),
      });
      f.setObligation({ blockedReason: ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON });
      const fiber = yield* Stream.runCollect(stream).pipe(Effect.forkChild);
      yield* Deferred.await(deliveryRead);
      // The provider accepted the steer.
      f.setObligation({});
      yield* PubSub.publish(events, sessionSet);
      assert.deepStrictEqual(
        [...(yield* Fiber.join(fiber))],
        [
          { delegationId: "d1", status: "running", text: "Working on it in my chat." },
          { delegationId: "d1", status: "completed", text: "Staging is green." },
        ],
      );
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect(
  "a steer confirmed after its turn ended, with no event, still ends the call's wait",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at(20)));
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      yield* Effect.gen(function* () {
        const calls = yield* AgentCalls;
        const live = yield* makeAgentCallLive;
        const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
        yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
        // A Cursor chat is busy, so the words are steered into its turn. Cursor
        // sends no delivery receipt: the reactor confirms the steer only once
        // the merged turn has ended, and that writes no domain event.
        const busyTurnId = TurnId.make("busy");
        const busy = turn("running", null, { turnId: "busy", requestedSecond: 1 });
        const running = session("running", null, "cursor");
        f.setShell({ session: running, latestTurn: busy });
        f.setThread({ session: running, latestTurn: busy });
        f.setObligation({ blockedReason: ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON });
        const stream = yield* live.delegate({
          sessionId: "live-call",
          delegationId: "d1",
          sequence: 1,
          context: "user [0-900ms]: And staging?",
        });
        const firstRead = yield* Deferred.make<void>();
        f.setDeliveryRead(firstRead);
        const fiber = yield* Stream.runCollect(stream).pipe(Effect.forkChild);
        yield* Deferred.await(firstRead);

        // The merged turn ends and wakes the watch before the steer is confirmed.
        f.setThread({
          messages: [
            message("reply", "assistant", "Staging is green.", 22, { turnId: busyTurnId }),
          ],
          latestTurn: turn("completed", 23, { turnId: "busy", requestedSecond: 1 }),
          session: session("ready", null, "cursor"),
        });
        const completionRead = yield* Deferred.make<void>();
        f.setDeliveryRead(completionRead);
        yield* PubSub.publish(events, sessionSet);
        yield* Deferred.await(completionRead);

        // The reactor clears the marker silently; the watch notices it anyway.
        f.setObligation({});
        yield* TestClock.adjust("2 seconds");
        assert.deepStrictEqual(
          [...(yield* Fiber.join(fiber))],
          [
            // Steered into the running turn: working on it, not queued behind it.
            { delegationId: "d1", status: "running", text: "Working on it in my chat." },
            { delegationId: "d1", status: "completed", text: "Staging is green." },
          ],
        );
      }).pipe(Effect.provide(f.layer(events)));
    }).pipe(Effect.scoped);
  },
);

it.effect("a delegation to a deleted chat ends the call", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      f.removeChat();
      const refused = yield* Effect.flip(
        live.delegate({
          sessionId: "live-call",
          delegationId: "d1",
          sequence: 1,
          context: "user [0-900ms]: Hello?",
        }),
      );
      assert.strictEqual(refused.status, 409);
      assert.strictEqual(f.dispatched.length, 0);
      assert.strictEqual(Option.getOrUndefined(yield* calls.get(placed.callId))?.status, "failed");
      assert.strictEqual((yield* Effect.flip(live.heartbeat("live-call"))).status, 409);
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("a heartbeat never waits behind a delegation", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.setDispatchGate({ entered, release });
      const delegation = yield* live
        .delegate({
          sessionId: "live-call",
          delegationId: "d1",
          sequence: 1,
          context: "user [0-900ms]: Deploy it.",
        })
        .pipe(Effect.forkChild);
      // The delegation waits in the chat's command queue; the call still beats.
      yield* Deferred.await(entered);
      yield* live.heartbeat("live-call");
      assert.strictEqual(Option.getOrUndefined(yield* calls.get(placed.callId))?.status, "active");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(delegation).pipe(Effect.asVoid);
      assert.strictEqual(f.dispatched.length, 1);
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect(
  "the call route needs vm:operate and tells a second device where the call was answered",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      let scopes: ReadonlyArray<AuthEnvironmentScope> = [AuthVmOperateScope];
      const services = yield* Layer.build(
        Layer.mergeAll(
          f.layer(events),
          Layer.mock(EnvironmentAuth)({
            authenticateHttpRequest: () =>
              Effect.sync(() => ({
                sessionId: AuthSessionId.make("phone-session"),
                subject: "fixture-user",
                method: "bearer-access-token" as const,
                scopes,
              })),
          }),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "session",
            listActive: () =>
              Effect.succeed([
                {
                  sessionId: AuthSessionId.make("phone-session"),
                  client: { label: "Sol's iPhone", deviceType: "mobile" },
                } as never,
              ]),
          }),
        ),
      );
      const provided = Layer.succeedContext(services);
      const app = HttpRouter.toWebHandler(
        agentCallRouteLayer.pipe(
          HttpRouter.provideRequest(AgentCallLiveLayer.pipe(Layer.provide(provided))),
          HttpRouter.provideRequest(provided),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
      const post = (path: string, body: object) =>
        Effect.promise(() =>
          app.handler(
            new Request(`http://fixture.test${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          ),
        );
      const calls = Context.get(services, AgentCalls);
      const rung = yield* calls.ring({
        vmAgentId,
        reason: "request",
        topic: null,
        key: "request:1",
      });
      if (rung.status !== "ringing") return assert.fail(rung.status);
      const body = { callId: rung.call.callId, sdp: "offer", history: [] };

      const first = yield* post(AGENT_CALL_SESSION_PATH, body);
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.headers.get("cache-control"), "no-store");
      assert.strictEqual(
        Option.getOrUndefined(yield* calls.get(rung.call.callId))?.answeredBy,
        "Sol's iPhone",
      );
      const second = yield* post(AGENT_CALL_SESSION_PATH, body);
      assert.strictEqual(second.status, 409);
      assert.strictEqual(yield* Effect.promise(() => second.text()), "Answered on Sol's iPhone");

      assert.strictEqual(
        (yield* post(AGENT_CALL_SESSION_RELEASE_PATH, { sessionId: "live-call" })).status,
        204,
      );
      assert.strictEqual(
        Option.getOrUndefined(yield* calls.get(rung.call.callId))?.status,
        "ended",
      );

      scopes = [AuthOrchestrationOperateScope];
      assert.strictEqual((yield* post(AGENT_CALL_SESSION_PATH, body)).status, 403);
    }).pipe(Effect.scoped);
  },
);

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
  type OrchestratorLiveWorkEvent,
  type VmAgent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { VoiceLookups } from "../voice/VoiceLookups.ts";
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
  agentCallRole,
  agentCallWorkEvent,
  extractCallDelta,
  forwardedCallMessage,
  AgentCallLiveLayer,
  makeAgentCallLive,
  mergeCallWorkEvents,
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
  avatarColor: 0,
  voice: null,
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
  assert.strictEqual(first.latestUserText, "Can you check the deploy?");
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
  assert.strictEqual(late.latestUserText, "And staging too.");

  assert.deepStrictEqual(extractCallDelta("user: no timestamps", new Set()), {
    userText: "",
    latestUserText: "",
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

it("tells the person's latest words apart from what the voice already handled", () => {
  // "Add Gregg" was handled by the voice itself, never delegated: it stays in
  // the next delegation's words but does not decide who they are for.
  const delta = extractCallDelta(
    [
      "user [0-900ms]: Add Gregg to the call.",
      "assistant [1000-1800ms]: Adding Gregg to the call.",
      "user [3000-3600ms]:  What's on my calendar",
      "user [3600-3900ms]:  today?",
      // The voice says it is asking, after the words it delegates.
      "assistant [4000-4400ms]: Let me check.",
    ].join("\n"),
    new Set(),
  );
  assert.strictEqual(delta.userText, "Add Gregg to the call. What's on my calendar today?");
  assert.strictEqual(delta.latestUserText, "What's on my calendar today?");
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
  assert.include(incoming, "Your role: Watch the deploy dashboards.");
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
  assert.include(outgoing, "Your role: Triage.\n");
  assert.include(outgoing, "Speak French.");
  assert.notInclude(outgoing, "You called the person");
  assert.include(outgoing, "The person called you. Pick up");
  assert.notInclude(outgoing, "transfer");
  assert.notInclude(outgoing, "bring people onto this call");
});

it("gives the voice the agent's role, not the rules its chat works by", () => {
  // The Personal Assistant's purpose shape: a role, then its operating rules.
  // With the rules, its voice turned an app request down itself and said it
  // had no chat to use, instead of delegating.
  const purpose = [
    "A personal chief of staff. Runs personal life: triages email, tracks commitments.",
    "SCOPE: personal and administrative life only. Not engineering (@engineer).",
    "READ FREELY, ACT ONLY WITH APPROVAL. Every outward action first requires request_action_approval.",
  ].join("\n\n");
  assert.strictEqual(
    agentCallRole(purpose),
    "A personal chief of staff. Runs personal life: triages email, tracks commitments.",
  );
  const instructions = agentCallInstructions({
    name: "Personal Assistant",
    purpose,
    language: "en",
    direction: "outgoing",
    topic: null,
  });
  assert.notInclude(instructions, "SCOPE");
  assert.notInclude(instructions, "request_action_approval");
  assert.include(instructions, "Never say you have no tools or no access");
  assert.include(instructions, "never turn a request down yourself");
  assert.include(instructions, "including requests that seem outside your role");
  const grok = agentCallInstructions({
    name: "Personal Assistant",
    purpose,
    language: "en",
    direction: "outgoing",
    topic: null,
    engine: "grok",
  });
  assert.include(grok, "Never say you have no tools or no access");
  assert.include(grok, "including requests that seem outside your role");

  // A long opening paragraph ends on a whole sentence within the bound.
  const long = `${"Keeps the books. ".repeat(40)}Then more.`;
  const role = agentCallRole(long);
  assert.isAtMost(role.length, 400);
  assert.match(role, /books\.$/u);
  // One unbroken run of words still ends on a whole word.
  assert.match(agentCallRole("word ".repeat(200)), /word…$/u);
});

it("never hands the voice the chat's stop token to read out", () => {
  assert.strictEqual(spokenReply("The deploy is green.\n\nAGENT_STOP"), "The deploy is green.");
  assert.strictEqual(spokenReplies(["Done. AGENT_STOP", "All set."]), "Done. All set.");
});

it("speaks as the agent doing the work, never as a relay to its chat", () => {
  // The person heard "let me check with my chat" when the voice was told its
  // work happened in a separate chat.
  for (const engine of ["gpt-live", "grok"] as const) {
    const instructions = agentCallInstructions({
      name: "Scout",
      purpose: "Triage.",
      language: "en",
      direction: "outgoing",
      topic: null,
      engine,
    });
    assert.include(instructions, "The person hears one agent: you.");
    assert.include(instructions, "Never talk about your own chat or thread");
    assert.include(instructions, "say them conversationally as yours");
    assert.notMatch(instructions, /\byour chat\b/iu);
  }
  assert.notMatch(spokenReply(`${"The deploy is green. ".repeat(120)}`), /\bmy chat\b/iu);
  assert.include(
    spokenReply("Here:\n```ts\nconst a = 1;\n```\nDone."),
    "(the code is in Solla Code)",
  );
});

it("leaves who the voice can transfer to or add to the device holding the call", () => {
  // Only a device that acts on the phrases teaches them (apps/web callDirectives).
  const instructions = agentCallInstructions({
    name: "Scout",
    purpose: "Triage.",
    language: "en",
    direction: "outgoing",
    topic: null,
  });
  assert.notInclude(instructions, "Transferring you to");
  assert.notInclude(instructions, "to the call.");
  // Nothing follows the language but how to pick up.
  assert.match(instructions, /Speak English\.\nThe person called you\. Pick up[^\n]*$/u);
});

it("merges the replies of several chats on a call, each read out as soon as it lands", () => {
  const work = (
    status: "running" | "queued" | "waiting-input" | "pending-approval" | "completed" | "failed",
    text: string,
  ) => ({ delegationId: "d", status, text });
  const merge = (
    targets: ReadonlyArray<{
      name: string;
      event: ReturnType<typeof work> | null;
      reported?: boolean;
      heardRequest?: string;
    }>,
  ) => mergeCallWorkEvents({ delegationId: "d", targets });
  const last = (targets: Parameters<typeof merge>[0]) => merge(targets).events.at(-1);

  // A reply that lands while someone still works is read out at once (an
  // audible event), then the call goes back to working.
  const early = merge([
    { name: "Scout", event: work("completed", "All green.") },
    { name: "Gregg", event: null },
  ]);
  assert.deepStrictEqual(early, {
    events: [
      {
        delegationId: "d",
        status: "waiting-input",
        text: "Scout: All green.\n\nNot done yet: Gregg.",
      },
      {
        delegationId: "d",
        status: "running",
        text: "Scout is done.\nGregg: On it.",
      },
    ],
    reported: [0],
    asked: [],
  });
  // Once heard, it is not read out again.
  assert.deepStrictEqual(
    merge([
      { name: "Scout", event: work("completed", "All green."), reported: true },
      { name: "Gregg", event: work("running", "Working on it.") },
    ]).events,
    [
      {
        delegationId: "d",
        status: "running",
        text: "Scout is done.\nGregg: Working on it.",
      },
    ],
  );
  assert.strictEqual(
    last([
      { name: "Scout", event: work("queued", "Your request is waiting.") },
      { name: "Gregg", event: work("completed", "Done.") },
    ])?.status,
    "queued",
  );
  // A question surfaces at once, by name; an approval outranks it.
  assert.deepStrictEqual(
    merge([
      { name: "Scout", event: work("running", "Working on it.") },
      { name: "Gregg", event: work("waiting-input", "I need to ask you: Which account?") },
    ]),
    {
      events: [
        {
          delegationId: "d",
          status: "waiting-input",
          text: "Gregg: I need to ask you: Which account?",
        },
      ],
      reported: [],
      asked: [1],
    },
  );
  // A request the call already read out is not read again: still not done.
  const heardAsk = merge([
    { name: "Scout", event: work("completed", "Production is green.") },
    {
      name: "Gregg",
      event: work("pending-approval", "I need your approval."),
      heardRequest: "I need your approval.",
    },
  ]);
  // Gregg waits on the person, so nobody works: after the reply, a quiet
  // waiting event (nothing to say) instead of "working".
  assert.deepStrictEqual(
    heardAsk.events.map((event) => [event.status, event.text]),
    [
      ["waiting-input", "Scout: Production is green.\n\nNot done yet: Gregg."],
      ["waiting-input", ""],
    ],
  );
  assert.deepStrictEqual(heardAsk.asked, []);
  // Nobody new to read out and nobody working: quiet, never a "working" spinner.
  assert.deepStrictEqual(
    merge([
      { name: "Scout", event: work("completed", "Production is green."), reported: true },
      {
        name: "Gregg",
        event: work("waiting-input", "I need to ask you: Which?"),
        heardRequest: "I need to ask you: Which?",
      },
    ]).events.map((event) => [event.status, event.text]),
    [["waiting-input", ""]],
  );
  // A request is read out as its watch framed it, never cut like a reply.
  const approval = `I need your approval for ${"a long email draft ".repeat(60)}— please approve or decline it in Solla Code; a spoken yes can't approve it.`;
  const asked = merge([
    { name: "Scout", event: work("running", "Working on it.") },
    { name: "Gregg", event: work("pending-approval", approval) },
  ]).events.at(-1);
  assert.strictEqual(asked?.text, `Gregg: ${approval}`);
  assert.deepStrictEqual(
    merge([
      { name: "Scout", event: work("running", "Working on it.") },
      {
        name: "Gregg",
        event: work("pending-approval", "I need your approval."),
        heardRequest: "I need your approval.",
      },
    ]).events.map((event) => event.status),
    ["running"],
  );
  assert.strictEqual(
    last([
      { name: "Scout", event: work("pending-approval", "I need your approval.") },
      { name: "Gregg", event: work("waiting-input", "I need to ask you: Which?") },
    ])?.status,
    "pending-approval",
  );
  // A reply not heard yet goes out with the question, never behind it.
  assert.deepStrictEqual(
    merge([
      { name: "Scout", event: work("completed", "Production is green.") },
      { name: "Gregg", event: work("waiting-input", "I need to ask you: Which account?") },
    ]),
    {
      events: [
        {
          delegationId: "d",
          status: "waiting-input",
          text: "Scout: Production is green.\n\nGregg: I need to ask you: Which account?",
        },
      ],
      reported: [0],
      asked: [1],
    },
  );
  // Done once everyone is: each reply not heard yet by name, a failure said as such.
  assert.deepStrictEqual(
    last([
      { name: "Scout", event: work("completed", "Production is green.") },
      { name: "Gregg", event: work("failed", "I ran into an error.") },
    ]),
    {
      delegationId: "d",
      status: "completed",
      text: "Scout: Production is green.\n\nGregg couldn't answer: I ran into an error.",
    },
  );
  assert.deepStrictEqual(
    last([
      { name: "Scout", event: work("completed", "Production is green."), reported: true },
      { name: "Gregg", event: work("completed", "Staging too.") },
    ]),
    { delegationId: "d", status: "completed", text: "Gregg: Staging too." },
  );
  assert.strictEqual(
    last([
      { name: "Scout", event: work("failed", "I stopped before I got to that.") },
      { name: "Gregg", event: work("failed", "I ran into an error.") },
    ])?.status,
    "failed",
  );
  // Long replies share the spoken budget.
  const long = "The deploy is green and every check passed. ".repeat(80);
  const merged = last([
    { name: "Scout", event: work("completed", long) },
    { name: "Gregg", event: work("completed", long) },
    { name: "Release notes", event: work("completed", long) },
  ]);
  assert.isAtMost(merged?.text.length ?? Infinity, 1_500);
  assert.match(merged?.text ?? "", /^Scout: The deploy is green/u);
  assert.include(merged?.text, "\n\nRelease notes: The deploy is green");
});

it("speaks short replies whole and long ones up to a sentence", () => {
  assert.strictEqual(
    spokenReply("Done.\n\n```ts\nconst x = 1;\n```"),
    "Done. (the code is in Solla Code)",
  );
  const long = `${"The deploy is green. ".repeat(100)}`;
  const spoken = spokenReply(long, 200);
  assert.isAtMost(spoken.length, 230);
  assert.match(spoken, /green\. The rest is written up in Solla Code\.$/u);
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
  assert.match(spoken, /The deploy is green\. The rest is written up in Solla Code\.$/u);
  assert.notInclude(spoken, "I'll check the dashboard.");
  // A final message too long on its own is cut at a sentence.
  const alone = spokenReplies(["Checking.", "The deploy is green. ".repeat(100)]);
  assert.match(alone, /^The deploy is green\./u);
  assert.match(alone, /The rest is written up in Solla Code\.$/u);
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
    text: "On it.",
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
    "Working on it.",
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
  assert.include(waiting.text, "I need to ask you: Which account should I use?");

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
    { delegationId: "delegation", status: "running", text: "Working on it." },
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
    text: "Working on it.",
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
    { delegationId: "delegation", status: "running", text: "Working on it." },
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
    text: "Working on it.",
  });
  // A question the chat asks after that has to be answered in the app.
  const waiting = kimiEvent([question(), question("ask-2", 12)]);
  assert.strictEqual(waiting.status, "waiting-input");
  assert.include(waiting.text, "has to be answered in Solla Code");
});

const decodeFetchBody = async (init?: RequestInit) =>
  (await new Response(init?.body).json()) as { session: { instructions: string; audio: unknown } };

const greggThreadId = ThreadId.make("thread-gregg");
const gregg: VmAgent = {
  ...agent,
  vmAgentId: VmAgentId.make("agent-gregg"),
  name: "Gregg",
  handle: "gregg",
  vmId: VmId.make("vm-gregg"),
  threadId: greggThreadId,
};

function fixture(
  options: {
    readonly liveStatus?: number;
    readonly voice?: VmAgent["voice"];
    /** Whether an xAI key is saved, for Grok calls. */
    readonly xaiKey?: boolean;
  } = {},
) {
  /** Every upstream URL called, in order. */
  const urls: string[] = [];
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
  /** Other chats by id: an agent's main chat or a regular one, for merged calls. */
  const chats = new Map<
    string,
    { title: string; thread: AgentCallThreadView["thread"]; shell: typeof shell }
  >();
  const shellFor = (id: string) =>
    id === threadId
      ? chatExists
        ? Option.some({ ...shell, id, title: agent.name, archivedAt: null } as never)
        : Option.none()
      : Option.fromUndefinedOr(chats.get(id)).pipe(
          Option.map(
            (chat) => ({ ...chat.shell, id, title: chat.title, archivedAt: null }) as never,
          ),
        );
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    orchestrator: { ...DEFAULT_SERVER_SETTINGS.orchestrator, voice: "alloy" },
  };
  const fetch: typeof globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url).startsWith("https://api.x.ai/"))
        return Response.json({ value: "xai-ephemeral", expires_at: 1_800_000_000 });
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
            : name === "orchestrator-xai-api-key" && options.xaiKey
              ? Option.some(new TextEncoder().encode("xai-fixture"))
              : Option.none(),
        ),
    }),
    Layer.mock(VmAgentStore)({
      getById: () => Effect.succeed(Option.some({ ...agent, voice: options.voice ?? null })),
      list: () => Effect.succeed([agent, gregg]),
      getByThreadId: (id) =>
        Effect.succeed(Option.fromUndefinedOr([agent, gregg].find((row) => row.threadId === id))),
    }),
  );
  return {
    requests,
    urls,
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
    /** Another chat, idle until a test says otherwise. */
    addChat: (id: ThreadId, title: string) => {
      chats.set(id, {
        title,
        thread: { messages: [], activities: [], latestTurn: null, session: null },
        shell: { ...shell, session: null, latestTurn: null },
      });
    },
    setChatThread: (id: ThreadId, next: Partial<AgentCallThreadView["thread"]>) => {
      const chat = chats.get(id);
      if (chat) chat.thread = { ...chat.thread, ...next };
    },
    setChatShell: (id: ThreadId, next: Partial<typeof shell>) => {
      const chat = chats.get(id);
      if (chat) chat.shell = { ...chat.shell, ...next };
    },
    deleteChat: (id: ThreadId) => {
      chats.delete(id);
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
          getThreadShellById: (id) => Effect.sync(() => shellFor(id)),
          getThreadDetailById: (id) =>
            Effect.gen(function* () {
              if (id !== threadId)
                return Option.map(Option.fromUndefinedOr(chats.get(id)), (chat) => ({
                  ...chat.thread,
                })) as never;
              const current = { ...thread };
              if (firstRead) yield* Deferred.succeed(firstRead, undefined);
              return Option.some(current as never);
            }),
          getShellSnapshot: () =>
            Effect.sync(() => ({
              snapshotSequence: 1,
              projects: [],
              threads: [threadId, ...chats.keys()].flatMap((id) =>
                Option.toArray(shellFor(id)).map((row) => ({
                  ...(row as object),
                  updatedAt: at(1),
                })),
              ) as never,
              updatedAt: at(1),
            })),
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
/** What a call's device reads out of work events: terminal ones, questions and approvals. */
const spokenText = (events: ReadonlyArray<OrchestratorLiveWorkEvent>) =>
  events
    .filter((event) => event.status !== "running" && event.status !== "queued")
    .map((event) => event.text)
    .join("\n\n");
const sessionSet = {
  type: "thread.session-set",
  aggregateKind: "thread",
  aggregateId: threadId,
} as never;

it.effect("each agent speaks with its own voice, chosen or from its character", () =>
  Effect.gen(function* () {
    for (const [voice, expected] of [
      [null, "marin"],
      ["willow", "willow"],
      ["a-voice-gpt-live-dropped", "marin"],
      // A device that started GPT-Live before the agent got a Grok voice.
      ["eve", "marin"],
    ] as const) {
      // An xAI key is saved, so the Grok-voiced agent still rings.
      const f = fixture({ voice, xaiKey: true });
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      yield* Effect.gen(function* () {
        const calls = yield* AgentCalls;
        const live = yield* makeAgentCallLive;
        const rung = yield* calls.ring({
          vmAgentId,
          reason: "blocker",
          topic: "Sign in to Google.",
          key: `voice:${String(voice)}`,
        });
        if (rung.status !== "ringing") return assert.fail(rung.status);
        const result = yield* live.start({ callId: rung.call.callId, ...offer }, "Sol's iPhone");
        assert.strictEqual(result.voice, expected);
        // The orchestrator's own voice ("alloy" here) no longer decides a call's.
        assert.deepStrictEqual(f.requests[0]?.session.audio, { output: { voice: expected } });
      }).pipe(Effect.provide(f.layer(events)));
    }
  }).pipe(Effect.scoped),
);

it.effect("a Grok-voiced agent's call opens on Grok Voice with a short-lived xAI secret", () => {
  const f = fixture({ voice: "eve", xaiKey: true });
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const rung = yield* calls.ring({
        vmAgentId,
        reason: "blocker",
        topic: "Sign in to Google.",
        key: "grok:one",
      });
      if (rung.status !== "ringing") return assert.fail(rung.status);
      const result = yield* live.startGrok(
        { callId: rung.call.callId, history: [{ role: "user", text: "Earlier." }] },
        "Sol's iPhone",
      );
      assert.match(result.sessionId, /^grok-call-/u);
      assert.strictEqual(result.clientSecret, "xai-ephemeral");
      assert.strictEqual(result.voice, "eve");
      assert.strictEqual(result.model, "grok-voice-latest");
      assert.strictEqual(result.agentName, "Scout");
      assert.include(result.instructions, "You are Scout");
      assert.include(result.instructions, "which only start_work reaches");
      assert.include(result.instructions, "because: Sign in to Google.");
      assert.include(result.instructions, "user: Earlier.");
      // Only the ephemeral secret leaves the host; GPT-Live was never asked.
      assert.notInclude(JSON.stringify(result), "xai-fixture");
      assert.deepStrictEqual(f.urls, ["https://api.x.ai/v1/realtime/client_secrets"]);
      const answered = Option.getOrUndefined(yield* calls.get(rung.call.callId));
      assert.strictEqual(answered?.status, "active");
      assert.strictEqual(answered?.answeredBy, "Sol's iPhone");
      // The rest of the call is the same as GPT-Live's: the lease, then release.
      yield* live.heartbeat(result.sessionId);
      yield* live.release(result.sessionId);
      assert.strictEqual(
        Option.getOrUndefined(yield* calls.get(rung.call.callId))?.status,
        "ended",
      );
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("a Grok call without an xAI key fails the call and says which key", () => {
  const f = fixture({ voice: "eve" });
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls
        .place({ vmAgentId, deviceLabel: "Sol's iPhone" })
        .pipe(Effect.flip);
      assert.include(placed.detail, "xAI key");
      const rung = yield* calls.ring({
        vmAgentId,
        reason: "blocker",
        topic: null,
        key: "grok:nokey",
      });
      // Nothing rings for a call that could never connect.
      assert.strictEqual(rung.status, "disabled");
      const error = yield* Effect.flip(
        live.startGrok({ callId: AgentCallId.make("missing"), history: [] }, "Sol's iPhone"),
      );
      assert.strictEqual(error.status, 409);
      assert.deepStrictEqual(f.urls, []);
    }).pipe(
      Effect.provide(f.layer(events)),
      // No XAI_API_KEY from whoever runs the tests.
      Effect.provideService(HostProcessEnvironment, {}),
    );
  }).pipe(Effect.scoped);
});

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
      // Within the take-back window, replay the answer the device may have missed.
      assert.strictEqual(
        (yield* Stream.runHead(nextUpdates)).pipe(Option.getOrUndefined)?.text,
        "Yes, all green.",
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
        text: "Working on it.",
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
          { delegationId: "d1", status: "running", text: "Working on it." },
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
            { delegationId: "d1", status: "running", text: "Working on it." },
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
          HttpRouter.provideRequest(
            Layer.mock(VoiceLookups)({ quickAnswer: () => Effect.succeed(Option.none()) }),
          ),
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

it.effect("a call starts with a roster its voice and its device share", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    f.addChat(ThreadId.make("thread-release"), "Release notes");
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      // No session holds the call yet.
      assert.strictEqual(
        (yield* Effect.flip(live.roster(placed.callId))).detail,
        "This call has ended.",
      );
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      const roster = yield* live.roster(placed.callId);
      assert.deepStrictEqual(roster.entries, [
        { name: "Gregg", threadId: greggThreadId, vmAgentId: gregg.vmAgentId },
        { name: "Release notes", threadId: ThreadId.make("thread-release"), vmAgentId: null },
      ]);
      // The device holding the call teaches the voice who they are.
      const instructions = f.requests[0]?.session.instructions ?? "";
      assert.notInclude(instructions, "Gregg");
      assert.notInclude(instructions, "Release notes");

      yield* live.release("live-call");
      assert.strictEqual(
        (yield* Effect.flip(live.roster(placed.callId))).detail,
        "This call has ended.",
      );
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("chats join under their own names; internal or missing ones are refused", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    f.addChat(greggThreadId, "Gregg's chat");
    f.addChat(ThreadId.make("thread-release"), "Release notes");
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      const join = (id: string) =>
        live.addParticipant({ callId: placed.callId, threadId: ThreadId.make(id) });
      // An agent's main chat joins as the agent.
      yield* join(greggThreadId);
      const joined = yield* join("thread-release");
      assert.deepStrictEqual(joined.participants, [
        { threadId: greggThreadId, title: "Gregg", vmAgentId: gregg.vmAgentId },
        { threadId: ThreadId.make("thread-release"), title: "Release notes", vmAgentId: null },
      ]);
      assert.strictEqual(
        (yield* Effect.flip(join(threadId))).detail,
        "You're already talking to Scout.",
      );
      assert.strictEqual(
        (yield* Effect.flip(join("thread-missing"))).detail,
        "That chat no longer exists.",
      );
      assert.strictEqual(
        (yield* Effect.flip(join("solla-orchestrator"))).detail,
        "The orchestrator can't join a call.",
      );
      const left = yield* live.removeParticipant({
        callId: placed.callId,
        threadId: greggThreadId,
      });
      assert.deepStrictEqual(
        left.participants?.map((entry) => entry.title),
        ["Release notes"],
      );
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("words go to the chats the person names, and their replies come back merged", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at(0)));
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    f.addChat(greggThreadId, "Gregg's chat");
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      yield* live.addParticipant({ callId: placed.callId, threadId: greggThreadId });

      // Named: only Gregg's chat hears it, told who else is on the call.
      const first = "user [0-900ms]: Gregg, is staging green?";
      const toGregg = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d1",
        sequence: 1,
        context: first,
      });
      assert.strictEqual(f.dispatched.length, 1);
      const sent = f.dispatched[0];
      if (sent?.type !== "thread.turn.start") return assert.fail("expected a forwarded message");
      assert.strictEqual(sent.threadId, greggThreadId);
      assert.strictEqual(sent.message.inputOrigin, "transcription");
      assert.isUndefined(sent.message.senderThreadId);
      assert.strictEqual(
        sent.message.text,
        "From our voice call:\nYou said: Gregg, is staging green?\n(Group call: you're on a call with the person and Scout. The person addressed you.)",
      );
      const finished = (second: number, text: string) => ({
        messages: [message(`reply-${second}`, "assistant", text, second)],
        session: session("ready"),
        latestTurn: turn("completed", second, { requestedSecond: second }),
      });
      f.setChatThread(greggThreadId, finished(0, "Staging is green."));
      assert.deepStrictEqual((yield* Stream.runCollect(toGregg)).at(-1), {
        delegationId: "d1",
        status: "completed",
        text: "Gregg: Staging is green.",
      });

      // Everyone: both chats, one reply each, by name.
      const second = `${first}\nassistant [1000-1500ms]: Gregg says it's green.\nuser [2000-2600ms]: Thanks, everyone. Anything else?`;
      const toAll = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d2",
        sequence: 2,
        context: second,
      });
      assert.deepStrictEqual(
        f.dispatched
          .slice(1)
          .map((command) => (command.type === "thread.turn.start" ? command.threadId : null)),
        [threadId, greggThreadId],
      );
      const [toScout, toGreggAgain] = f.dispatched.slice(1);
      assert.strictEqual(
        toScout?.type === "thread.turn.start" ? toScout.message.text : undefined,
        "From our voice call:\nYou said: Thanks, everyone. Anything else?\n(On the call I replied: Gregg says it's green.)\n(Group call: you're on a call with the person and Gregg. The person addressed everyone.)",
      );
      assert.include(
        toGreggAgain?.type === "thread.turn.start" ? toGreggAgain.message.text : "",
        "(On the call Scout replied: Gregg says it's green.)",
      );
      // Distinct, stable ids per chat.
      assert.notStrictEqual(toScout?.commandId, toGreggAgain?.commandId);
      f.setThread(finished(0, "Nothing else from me."));
      f.setChatThread(greggThreadId, {
        messages: [message("reply-gregg", "assistant", "All quiet.", 0)],
      });
      const merged = [...(yield* Stream.runCollect(toAll))];
      assert.strictEqual(merged.at(-1)?.status, "completed");
      // Each reply is read out once, by name, whichever lands first.
      const heard = spokenText(merged);
      assert.include(heard, "Scout: Nothing else from me.");
      assert.include(heard, "Gregg: All quiet.");
      assert.strictEqual(heard.split("Scout:").length, 2);
      // The preceding reply is also recovered within the take-back window.
      assert.include(heard, "Gregg: Staging is green.");
      assert.strictEqual(heard.split("Gregg:").length, 3);

      // A retry reattaches to both chats instead of sending again.
      const retried = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d2",
        sequence: 2,
        context: second,
      });
      assert.strictEqual(f.dispatched.length, 3);
      assert.strictEqual((yield* Stream.runCollect(retried)).at(-1)?.status, "completed");
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("unnamed words answer the question a chat on the call just asked", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    f.addChat(greggThreadId, "Gregg's chat");
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      yield* live.addParticipant({ callId: placed.callId, threadId: greggThreadId });
      const first = "user [0-900ms]: Gregg, set up staging.";
      yield* live
        .delegate({ sessionId: "live-call", delegationId: "d1", sequence: 1, context: first })
        .pipe(Effect.asVoid);
      const sentTo = (index: number) => {
        const command = f.dispatched[index];
        return command !== undefined && "threadId" in command ? command.threadId : undefined;
      };
      assert.strictEqual(sentTo(0), greggThreadId);
      // Gregg asks which account; the person answers without naming Gregg.
      const asking = {
        session: session("running", null, "codex"),
        latestTurn: turn("running", null, { requestedSecond: 1 }),
      };
      f.setChatShell(greggThreadId, { hasPendingUserInput: true, ...asking });
      f.setChatThread(greggThreadId, { activities: [question()], ...asking });
      yield* live
        .delegate({
          sessionId: "live-call",
          delegationId: "d2",
          sequence: 2,
          context: `${first}\nassistant [1000-1500ms]: Gregg asks which account.\nuser [2000-2600ms]: The work one.`,
        })
        .pipe(Effect.asVoid);
      const answer = f.dispatched[1];
      if (answer?.type !== "thread.user-input.respond")
        return assert.fail("expected an answer to Gregg's question");
      assert.strictEqual(answer.threadId, greggThreadId);
      assert.deepStrictEqual(answer.answers, { "Which account should I use?": "The work one." });

      // Once nobody on the call is asking, unnamed words go to the agent called.
      f.setChatShell(greggThreadId, { hasPendingUserInput: false });
      yield* live
        .delegate({
          sessionId: "live-call",
          delegationId: "d3",
          sequence: 3,
          context: `${first}\nassistant [1000-1500ms]: Gregg asks which account.\nuser [2000-2600ms]: The work one.\nuser [3000-3400ms]: Thanks.`,
        })
        .pipe(Effect.asVoid);
      assert.strictEqual(sentTo(2), threadId);
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect(
  "unnamed words never answer an action approval or a question only Solla Code takes",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      f.addChat(greggThreadId, "Gregg's chat");
      yield* Effect.gen(function* () {
        const calls = yield* AgentCalls;
        const live = yield* makeAgentCallLive;
        const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
        yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
        yield* live.addParticipant({ callId: placed.callId, threadId: greggThreadId });
        const sentTo = (index: number) => {
          const command = f.dispatched[index];
          return command === undefined
            ? undefined
            : `${command.type}:${String("threadId" in command ? command.threadId : "")}`;
        };
        let context = "user [0-900ms]: Gregg, email Bob the draft.";
        const say = (sequence: number, words: string) => {
          context = `${context}\nuser [${sequence * 1000}-${sequence * 1000 + 400}ms]: ${words}`;
          return live
            .delegate({ sessionId: "live-call", delegationId: `d${sequence}`, sequence, context })
            .pipe(Effect.asVoid);
        };
        yield* live
          .delegate({ sessionId: "live-call", delegationId: "d1", sequence: 1, context })
          .pipe(Effect.asVoid);
        assert.strictEqual(sentTo(0), `thread.turn.start:${greggThreadId}`);

        // Gregg asks to approve sending the email: approved in Solla Code, never by voice.
        const running = {
          session: session("running", null, "codex"),
          latestTurn: turn("running", null, { requestedSecond: 1 }),
        };
        const approval = activity("user-input.requested", {
          requestId: "send",
          questions: [{ id: "q", header: "Send", question: "Send the draft to Bob?", options: [] }],
          actionApproval: { actionKind: "send_email" },
        });
        f.setChatShell(greggThreadId, { hasPendingUserInput: true, ...running });
        f.setChatThread(greggThreadId, { activities: [approval], ...running });
        context = `${context}\nuser [2000-2400ms]: OK, later. What's on my calendar today?`;
        const toScout = yield* live.delegate({
          sessionId: "live-call",
          delegationId: "d2",
          sequence: 2,
          context,
        });
        assert.strictEqual(sentTo(1), `thread.turn.start:${threadId}`);

        // The agent called waits on an approval while Gregg, still followed,
        // asks something a spoken answer fills, and the call reads it out:
        // the answer is Gregg's.
        f.setShell({ hasPendingUserInput: true });
        f.setThread({ activities: [approval] });
        f.setChatThread(greggThreadId, { activities: [question()] });
        yield* Stream.runCollect(
          toScout.pipe(Stream.takeUntil((event) => event.text.includes("Which account"))),
        );
        // The person answers once they have heard it.
        yield* TestClock.adjust("5 seconds");
        yield* say(3, "The work one.");
        assert.strictEqual(sentTo(2), `thread.user-input.respond:${greggThreadId}`);
      }).pipe(Effect.provide(f.layer(events)));
    }).pipe(Effect.scoped);
  },
);

it.effect(
  "a finished reply is read out even when another chat asks, and its answer goes on",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at(0)));
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      f.addChat(greggThreadId, "Gregg's chat");
      yield* Effect.gen(function* () {
        const calls = yield* AgentCalls;
        const live = yield* makeAgentCallLive;
        const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
        yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
        yield* live.addParticipant({ callId: placed.callId, threadId: greggThreadId });
        const first = "user [0-900ms]: Everyone, status?";
        const status = yield* live.delegate({
          sessionId: "live-call",
          delegationId: "d1",
          sequence: 1,
          context: first,
        });
        assert.strictEqual(f.dispatched.length, 2);
        // Scout answers; Gregg asks which account before it can.
        f.setThread({
          messages: [message("reply-scout", "assistant", "Production is green.", 0)],
          session: session("ready"),
          latestTurn: turn("completed", 0, { requestedSecond: 0 }),
        });
        const asking = {
          session: session("running", null, "codex"),
          latestTurn: turn("running", null, { requestedSecond: 1 }),
        };
        f.setChatShell(greggThreadId, { hasPendingUserInput: true, ...asking });
        f.setChatThread(greggThreadId, { activities: [question()], ...asking });
        let heard = "";
        yield* Stream.runCollect(
          status.pipe(
            Stream.takeUntil((event) => {
              heard += `${spokenText([event])}\n`;
              return heard.includes("Production is green.") && heard.includes("Which account");
            }),
          ),
        );
        assert.include(heard, "Scout: Production is green.");
        assert.include(heard, "Gregg: I need to ask you: Which account should I use?");

        // The person answers Gregg; Scout's reply, already heard, is not followed again.
        yield* TestClock.adjust("5 seconds");
        const answer = yield* live.delegate({
          sessionId: "live-call",
          delegationId: "d2",
          sequence: 2,
          context: `${first}\nuser [2000-2600ms]: The work one.`,
        });
        const respond = f.dispatched[2];
        assert.strictEqual(respond?.type, "thread.user-input.respond");
        f.setChatShell(greggThreadId, { hasPendingUserInput: false });
        f.setChatThread(greggThreadId, {
          messages: [message("reply-gregg", "assistant", "Deployed with the work account.", 6)],
          session: session("ready"),
          latestTurn: turn("completed", 6, { requestedSecond: 1 }),
        });
        assert.deepStrictEqual([...(yield* Stream.runCollect(answer))].at(-1), {
          delegationId: "d2",
          status: "completed",
          text: "Gregg: Deployed with the work account.",
        });
      }).pipe(Effect.provide(f.layer(events)));
    }).pipe(Effect.scoped);
  },
);

it.effect("a finished reply survives new words sent to the same chat", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at(0)));
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      const first = "user [0-900ms]: Run the tests.";
      const old = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d1",
        sequence: 1,
        context: first,
      });
      f.setThread({
        messages: [message("first-reply", "assistant", "All tests pass.", 0)],
        session: session("ready"),
        latestTurn: turn("completed", 0, { requestedSecond: 0 }),
      });
      yield* Stream.runCollect(old);
      yield* TestClock.adjust("1 second");
      const next = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d2",
        sequence: 2,
        context: `${first}\nuser [1000-1900ms]: And lint?`,
      });
      f.setThread({
        messages: [message("second-reply", "assistant", "Lint is clean.", 1)],
        session: session("ready"),
        latestTurn: turn("completed", 1, { requestedSecond: 1 }),
      });
      const heard = spokenText([...(yield* Stream.runCollect(next))]);
      assert.include(heard, "All tests pass.");
      assert.include(heard, "Lint is clean.");
      assert.strictEqual(f.dispatched.length, 2);
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("a chat still working on earlier words is followed by the next delegation", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at(0)));
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    f.addChat(greggThreadId, "Gregg's chat");
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      yield* live.addParticipant({ callId: placed.callId, threadId: greggThreadId });
      const first = "user [0-900ms]: Gregg, run the tests.";
      // Its stream is dropped by the client once the next delegation answers.
      yield* live
        .delegate({ sessionId: "live-call", delegationId: "d1", sequence: 1, context: first })
        .pipe(Effect.asVoid);
      f.setChatThread(greggThreadId, {
        session: session("running"),
        latestTurn: turn("running", null, { requestedSecond: 0 }),
      });
      const next = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d2",
        sequence: 2,
        context: `${first}\nuser [2000-2600ms]: Scout, what's next?`,
      });
      // Only Scout hears the new words.
      assert.deepStrictEqual(
        f.dispatched.map((command) => ("threadId" in command ? command.threadId : null)),
        [greggThreadId, threadId],
      );
      const finished = (text: string) => ({
        messages: [message(`reply-${text.length}`, "assistant", text, 0)],
        session: session("ready"),
        latestTurn: turn("completed", 0, { requestedSecond: 0 }),
      });
      f.setThread(finished("Ship the release."));
      f.setChatThread(greggThreadId, finished("All tests pass."));
      const updates = [...(yield* Stream.runCollect(next))];
      assert.strictEqual(updates.at(-1)?.status, "completed");
      const heard = spokenText(updates);
      assert.include(heard, "Scout: Ship the release.");
      assert.include(heard, "Gregg: All tests pass.");
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("a chat on the call that goes away leaves it, and the call goes on", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    f.addChat(greggThreadId, "Gregg's chat");
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      yield* live.addParticipant({ callId: placed.callId, threadId: greggThreadId });
      f.deleteChat(greggThreadId);
      const updates = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d1",
        sequence: 1,
        context: "user [0-900ms]: Gregg, are you there?",
      });
      assert.strictEqual(f.dispatched.length, 0);
      assert.deepStrictEqual(
        [...(yield* Stream.runCollect(updates))],
        [
          {
            delegationId: "d1",
            status: "failed",
            text: "Gregg couldn't answer: I'm no longer available, so I've left the call.",
          },
        ],
      );
      const call = Option.getOrUndefined(yield* calls.get(placed.callId));
      assert.strictEqual(call?.status, "active");
      assert.deepStrictEqual(call?.participants, []);
      // Nobody is left to name: the next words go to the agent called.
      yield* live
        .delegate({
          sessionId: "live-call",
          delegationId: "d2",
          sequence: 2,
          context: "user [0-900ms]: Gregg, are you there?\nuser [1000-1400ms]: Never mind.",
        })
        .pipe(Effect.asVoid);
      const next = f.dispatched[0];
      if (next?.type !== "thread.turn.start") return assert.fail("expected a forwarded message");
      assert.strictEqual(next.threadId, threadId);
      assert.strictEqual(next.message.text, "From our voice call:\nYou said: Never mind.");
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it("cuts a merged call's request to its share but keeps what the person must do", () => {
  const draft = "Hi Ana, thanks for the meeting yesterday. ".repeat(40);
  const approval = activity("user-input.requested", {
    requestId: "send",
    questions: [{ id: "q", header: "Send", question: `Send this email? ${draft}`, options: [] }],
    actionApproval: { actionKind: "send_email" },
  });
  const asking = (activities: ReadonlyArray<OrchestrationThreadActivity>, maxChars?: number) =>
    agentCallWorkEvent({
      delegationId: "d",
      target: {
        messageId: MessageId.make("m"),
        answeredRequestId: null,
        sentAt: at(1),
        busyTurnId: null,
      },
      view: view(
        { activities: [...activities], session: session("running", null, "codex") },
        { hasPendingUserInput: true },
      ),
      maxChars,
    });
  const cut = asking([approval], 400);
  assert.strictEqual(cut.status, "pending-approval");
  assert.match(cut.text, /^I need your approval for Send this email\? Hi Ana/u);
  assert.match(
    cut.text,
    / … — please approve or decline it in Solla Code; a spoken yes can't approve it\.$/u,
  );
  assert.notInclude(cut.text, "The rest is written up in Solla Code.");
  assert.isAtMost(cut.text.length, 400);
  // A question only Solla Code takes keeps saying so.
  const kimi = agentCallWorkEvent({
    delegationId: "d",
    target: {
      messageId: MessageId.make("m"),
      answeredRequestId: null,
      sentAt: at(1),
      busyTurnId: null,
    },
    view: view(
      {
        activities: [
          activity("user-input.requested", {
            requestId: "ask",
            questions: [{ id: "q", header: "Pick", question: draft, options: [] }],
          }),
        ],
        session: session("running", null, "kimi"),
      },
      { hasPendingUserInput: true },
    ),
    maxChars: 300,
  });
  assert.match(
    kimi.text,
    /it has to be answered in Solla Code; it can't be answered on this call\.$/u,
  );
  // A call with one chat reads it whole, as before.
  assert.include(asking([approval]).text, draft.trim());
});

it.effect("words the voice handled itself never decide who later words are for", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    f.addChat(greggThreadId, "Gregg's chat");
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      yield* live.addParticipant({ callId: placed.callId, threadId: greggThreadId });
      yield* live
        .delegate({
          sessionId: "live-call",
          delegationId: "d1",
          sequence: 1,
          context: [
            "user [0-900ms]: Add Gregg to the call.",
            "assistant [1000-1800ms]: Adding Gregg to the call.",
            "user [3000-3600ms]:  What's on my calendar today?",
          ].join("\n"),
        })
        .pipe(Effect.asVoid);
      const sent = f.dispatched[0];
      if (sent?.type !== "thread.turn.start") return assert.fail("expected a forwarded message");
      // The agent called gets it, with everything said, not Gregg.
      assert.strictEqual(sent.threadId, threadId);
      assert.include(sent.message.text, "You said: Add Gregg to the call. What's on my calendar");
      assert.strictEqual(f.dispatched.length, 1);
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("a reply sent on a stream the device had already dropped is read out again", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at(0)));
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    f.addChat(greggThreadId, "Gregg's chat");
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      yield* live.addParticipant({ callId: placed.callId, threadId: greggThreadId });
      let context = "user [0-900ms]: Gregg, run the tests.";
      const say = (sequence: number, words: string) => {
        context = `${context}\nuser [${sequence * 1000}-${sequence * 1000 + 400}ms]: ${words}`;
        return live.delegate({
          sessionId: "live-call",
          delegationId: `d${sequence}`,
          sequence,
          context,
        });
      };
      const toGregg = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d1",
        sequence: 1,
        context,
      });
      const finished = (text: string, second: number) => ({
        messages: [message(`reply-${second}`, "assistant", text, second)],
        session: session("ready"),
        latestTurn: turn("completed", second, { requestedSecond: 0 }),
      });
      // Gregg's reply goes out on d1's stream a moment before the person's
      // next words reach the host: the device had already moved on to d2.
      f.setChatThread(greggThreadId, finished("All tests pass.", 0));
      assert.include(spokenText([...(yield* Stream.runCollect(toGregg))]), "All tests pass.");
      const next = yield* say(2, "Scout, what's next?");
      f.setThread(finished("Ship the release.", 2));
      const heard = spokenText([...(yield* Stream.runCollect(next))]);
      assert.include(heard, "Scout: Ship the release.");
      assert.include(heard, "Gregg: All tests pass.");

      // A stream a newer delegation has replaced marks nothing as heard.
      yield* TestClock.adjust("10 seconds");
      const older = yield* say(3, "Gregg, and lint?");
      f.setChatThread(greggThreadId, {
        session: session("running"),
        latestTurn: turn("running", null, { requestedSecond: 10 }),
      });
      yield* say(4, "Scout, thanks.").pipe(Effect.asVoid);
      f.setChatThread(greggThreadId, finished("Lint is clean.", 11));
      assert.include(spokenText([...(yield* Stream.runCollect(older))]), "Lint is clean.");
      yield* TestClock.adjust("10 seconds");
      const later = yield* say(5, "Scout, anything else?");
      let laterHeard = "";
      yield* Stream.runCollect(
        later.pipe(
          Stream.takeUntil((event) => {
            laterHeard += spokenText([event]);
            return laterHeard.includes("Lint is clean.");
          }),
        ),
      );
      assert.include(laterHeard, "Gregg: Lint is clean.");
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("an answer whose words trail the delegation still reaches the chat that asked", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at(0)));
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    f.addChat(greggThreadId, "Gregg's chat");
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      yield* live.addParticipant({ callId: placed.callId, threadId: greggThreadId });
      const first = "user [0-900ms]: Gregg, deploy staging.";
      const deploy = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d1",
        sequence: 1,
        context: first,
      });
      const asking = {
        session: session("running", null, "codex"),
        latestTurn: turn("running", null, { requestedSecond: 1 }),
      };
      f.setChatShell(greggThreadId, { hasPendingUserInput: true, ...asking });
      f.setChatThread(greggThreadId, { activities: [question()], ...asking });
      yield* Stream.runCollect(
        deploy.pipe(Stream.takeUntil((event) => event.text.includes("Which account"))),
      );
      yield* TestClock.adjust("5 seconds");

      // "The work one." is delegated before its transcript arrives: the
      // delegation ends quietly, so the device asks again once it settles.
      const early = () =>
        live.delegate({ sessionId: "live-call", delegationId: "d2", sequence: 2, context: first });
      assert.deepStrictEqual(
        [...(yield* Stream.runCollect(yield* early()))],
        [{ delegationId: "d2", status: "completed", text: "" }],
      );
      // Asked again still without words: Gregg waits on a question the call
      // already read out and nobody works, so it ends quietly, never spinning.
      assert.deepStrictEqual(
        [...(yield* Stream.runCollect(yield* early()))],
        [{ delegationId: "d2", status: "completed", text: "" }],
      );
      assert.strictEqual(f.dispatched.length, 1);
      yield* live
        .delegate({
          sessionId: "live-call",
          delegationId: "d2",
          sequence: 2,
          context: `${first}\nuser [6000-6400ms]: The work one.`,
        })
        .pipe(Effect.asVoid);
      const answer = f.dispatched[1];
      if (answer?.type !== "thread.user-input.respond")
        return assert.fail("expected an answer to Gregg's question");
      assert.strictEqual(answer.threadId, greggThreadId);
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

it.effect("a question the person talked past does not take their next unnamed words", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at(0)));
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    f.addChat(greggThreadId, "Gregg's chat");
    yield* Effect.gen(function* () {
      const calls = yield* AgentCalls;
      const live = yield* makeAgentCallLive;
      const placed = yield* calls.place({ vmAgentId, deviceLabel: "Office Mac" });
      yield* live.start({ callId: placed.callId, ...offer }, "Office Mac");
      yield* live.addParticipant({ callId: placed.callId, threadId: greggThreadId });
      let context = "user [0-900ms]: Gregg, deploy.";
      const deploy = yield* live.delegate({
        sessionId: "live-call",
        delegationId: "d1",
        sequence: 1,
        context,
      });
      const asking = {
        session: session("running", null, "codex"),
        latestTurn: turn("running", null, { requestedSecond: 1 }),
      };
      f.setChatShell(greggThreadId, { hasPendingUserInput: true, ...asking });
      f.setChatThread(greggThreadId, { activities: [question()], ...asking });
      yield* Stream.runCollect(
        deploy.pipe(Stream.takeUntil((event) => event.text.includes("Which account"))),
      );
      const say = (sequence: number, words: string) => {
        context = `${context}\nuser [${sequence * 1000}-${sequence * 1000 + 400}ms]: ${words}`;
        return live
          .delegate({ sessionId: "live-call", delegationId: `d${sequence}`, sequence, context })
          .pipe(Effect.asVoid);
      };
      yield* TestClock.adjust("5 seconds");
      yield* say(2, "Scout, what's on my calendar?");
      yield* TestClock.adjust("5 seconds");
      yield* say(3, "And what about tomorrow?");
      assert.deepStrictEqual(
        f.dispatched.map((command) =>
          "threadId" in command ? `${command.type}:${String(command.threadId)}` : command.type,
        ),
        [
          `thread.turn.start:${greggThreadId}`,
          `thread.turn.start:${threadId}`,
          `thread.turn.start:${threadId}`,
        ],
      );
    }).pipe(Effect.provide(f.layer(events)));
  }).pipe(Effect.scoped);
});

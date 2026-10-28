import { assert, it } from "@effect/vitest";
import {
  AGENT_BUILDER_THREAD_PREFIX,
  ORCHESTRATOR_THREAD_ID,
  ThreadId,
  VmAgentId,
  type AgentCallParticipant,
  type VmAgent,
} from "@t3tools/contracts";

import {
  addressesEveryone,
  callDelegationTargets,
  callParticipantFor,
  callRoster,
  groupCallNote,
} from "./agentCallGroup.ts";

const at = (minute: number) => `2026-10-28T12:${String(minute).padStart(2, "0")}:00.000Z`;
const agentRow = (
  id: string,
  name: string,
  status: VmAgent["status"] = "running",
  threadId: string | null = `thread-${id}`,
) => ({
  vmAgentId: VmAgentId.make(id),
  name,
  status,
  threadId: threadId === null ? null : ThreadId.make(threadId),
});
const chat = (
  id: string,
  title: string,
  minute: number,
  extra: { readonly archivedAt?: string | null; readonly isSideChat?: boolean } = {},
) => ({
  id: ThreadId.make(id),
  title,
  updatedAt: at(minute),
  archivedAt: extra.archivedAt ?? null,
  ...(extra.isSideChat === undefined ? {} : { isSideChat: extra.isSideChat }),
});
const scout = agentRow("scout", "Scout");

it("lists the other live agents, then the most recent plain chats", () => {
  const roster = callRoster({
    agent: scout,
    agents: [
      scout,
      agentRow("gregg", "Gregg"),
      agentRow("idle", "Idle", "stopped"),
      agentRow("broken", "Broken", "failed", null),
      agentRow("nova", "Nova", "starting"),
    ],
    threads: [
      chat("thread-scout", "Scout", 59),
      chat("thread-idle", "Idle", 58),
      chat("older", "Release notes", 1),
      chat("newer", "Fix the login bug", 30),
      chat("archived", "Archived plan", 50, { archivedAt: at(51) }),
      chat("side", "Side question", 52, { isSideChat: true }),
      chat(ORCHESTRATOR_THREAD_ID, "Orchestrator", 53),
      chat(`${AGENT_BUILDER_THREAD_PREFIX}one`, "Build an agent", 54),
      chat("delegation-worker:d-1", "Delegated work", 55),
      // Sounds like an agent already listed, or like the agent called.
      chat("gregg-chat", "GRÉGG", 40),
      chat("scout-chat", "scout", 41),
    ],
  });
  assert.deepStrictEqual(roster.entries, [
    { name: "Gregg", threadId: ThreadId.make("thread-gregg"), vmAgentId: VmAgentId.make("gregg") },
    { name: "Nova", threadId: ThreadId.make("thread-nova"), vmAgentId: VmAgentId.make("nova") },
    { name: "Fix the login bug", threadId: ThreadId.make("newer"), vmAgentId: null },
    { name: "Release notes", threadId: ThreadId.make("older"), vmAgentId: null },
  ]);
});

it("bounds the roster: twelve chats, thirty names, about 1,500 characters", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    chat(`chat-${index}`, `Chat ${index}`, index),
  );
  const chats = callRoster({ agent: scout, agents: [scout], threads: many }).entries;
  assert.strictEqual(chats.length, 12);
  assert.strictEqual(chats[0]?.name, "Chat 39");

  const agents = Array.from({ length: 40 }, (_, index) => agentRow(`a-${index}`, `Agent ${index}`));
  assert.strictEqual(
    callRoster({ agent: scout, agents: [scout, ...agents], threads: many }).entries.length,
    30,
  );

  const long = Array.from({ length: 30 }, (_, index) =>
    agentRow(`long-${index}`, `${"Long agent name ".repeat(4)}${index}`),
  );
  const bounded = callRoster({ agent: scout, agents: [scout, ...long], threads: [] }).entries;
  const chars = bounded.reduce((total, entry) => total + entry.name.length, 0);
  assert.isAtMost(chars, 1_500);
  assert.isAbove(bounded.length, 15);
  // A long title is cut to something sayable.
  const titled = callRoster({
    agent: scout,
    agents: [scout],
    threads: [chat("long", `Investigate ${"the flaky build ".repeat(20)}`, 1)],
  }).entries;
  assert.isAtMost(titled[0]?.name.length ?? 0, 100);
});

const primary = { threadId: ThreadId.make("thread-scout"), name: "Scout" };
const onCall = (
  title: string,
  id = title.toLowerCase().replace(/\W+/gu, "-"),
  vmAgentId: string | null = null,
) =>
  ({
    threadId: ThreadId.make(id),
    title,
    vmAgentId: vmAgentId === null ? null : VmAgentId.make(vmAgentId),
  }) satisfies AgentCallParticipant;
const gregg = onCall("Gregg");
const release = onCall("Release notes");
const names = (text: string, participants: ReadonlyArray<AgentCallParticipant>) =>
  callDelegationTargets(text, primary, participants).map((target) => target.name);

it("sends the person's words to whoever they named, else the agent called", () => {
  // Nobody added: always the agent called, whatever was said.
  assert.deepStrictEqual(callDelegationTargets("Gregg, check staging", primary, []), [
    { ...primary, primary: true },
  ]);
  assert.deepStrictEqual(names("Is the deploy green?", [gregg]), ["Scout"]);
  assert.deepStrictEqual(names("gregg, is staging green?", [gregg, release]), ["Gregg"]);
  assert.deepStrictEqual(names("Scout and Gregg, compare notes.", [gregg]), ["Scout", "Gregg"]);
  // Whole words only, accents ignored.
  assert.deepStrictEqual(names("Ask Greggory instead.", [gregg]), ["Scout"]);
  assert.deepStrictEqual(names("Ask Zoë about it.", [onCall("Zoe")]), ["Zoe"]);
  assert.deepStrictEqual(names("Ask Zoe about it.", [onCall("Zoë")]), ["Zoë"]);
  // Punctuation in a title is never said aloud.
  for (const [title, words] of [
    ["Fix login (Safari)", "Fix login Safari, where are we?"],
    ["Fix: preview flicker", "Fix preview flicker, where are we?"],
    ["Sign-in popup", "Sign in popup, any news?"],
  ] as const)
    assert.deepStrictEqual(names(words, [gregg, onCall(title)]), [title]);
});

it("knows an agent by its first name, but a chat only by its whole title", () => {
  const novaBright = onCall("Nova Bright", "thread-nova", "nova");
  assert.deepStrictEqual(names("Nova, what's on today?", [novaBright]), ["Nova Bright"]);
  assert.deepStrictEqual(names("What does Nova think?", [novaBright, onCall("Nova plans")]), [
    "Scout",
  ]);
  // Chat titles open with everyday verbs: "review", "update", "check".
  assert.deepStrictEqual(names("Scout, can you review my calendar?", [onCall("Review auth PR")]), [
    "Scout",
  ]);
  assert.deepStrictEqual(
    names("Give me an update on the deploy.", [onCall("Update release docs")]),
    ["Scout"],
  );
  assert.deepStrictEqual(names("What does release say?", [gregg, release]), ["Scout"]);
  assert.deepStrictEqual(names("What do the release notes say?", [gregg, release]), [
    "Release notes",
  ]);
  assert.deepStrictEqual(names("Fix it.", [onCall("Fix the login bug")]), ["Scout"]);
});

it("sends words to everyone only when they are said to everyone", () => {
  for (const text of [
    "What do you all think?",
    "Y’all ready?",
    "Everyone, status please.",
    "Okay everyone, listen up.",
    "Everybody ready?",
    "Thanks, everyone.",
    "What does everyone think?",
    "Any blockers, everybody?",
    "Both of you, check in.",
    "All three of you, listen.",
  ])
    assert.deepStrictEqual(
      names(text, [gregg, release]),
      ["Scout", "Gregg", "Release notes"],
      text,
    );
  // "Everyone" as who something is for, not who is spoken to.
  assert.deepStrictEqual(names("Scout, send the release notes to everyone on the team.", [gregg]), [
    "Scout",
  ]);
  assert.deepStrictEqual(names("Scout, email everyone the summary.", [gregg]), ["Scout"]);
  assert.deepStrictEqual(names("Gregg, tell everybody the build is green.", [gregg]), ["Gregg"]);
  assert.deepStrictEqual(names("Send the notes to everyone.", [gregg]), ["Scout"]);
  assert.isTrue(addressesEveryone("Thank you all."));
  assert.isFalse(addressesEveryone("You allow that?"));
  assert.isFalse(addressesEveryone("Scout, email everyone the summary."));
  assert.isFalse(addressesEveryone("Has everyone's build passed?"));
});

it("hears the usual ways of speaking to the group", () => {
  for (const text of [
    "What do you guys think?",
    "What do you two think?",
    "Can you two compare notes?",
    "what do you think everyone",
    "Okay so everyone what's the status",
    "Okay, so everyone, what's the status?",
    "Guys, what's the status?",
    "Hey guys, quick one.",
    "Okay everyone listen up",
    "Thanks everyone",
  ])
    assert.deepStrictEqual(
      names(text, [gregg, release]),
      ["Scout", "Gregg", "Release notes"],
      text,
    );
  // Not said to the group.
  assert.deepStrictEqual(names("I'll give you two options.", [gregg]), ["Scout"]);
  assert.deepStrictEqual(names("Can you send it to everyone?", [gregg]), ["Scout"]);
});

it("lets a name win over 'everyone' that is about other people", () => {
  const nova = onCall("Nova", "thread-nova", "nova");
  const atlas = onCall("Atlas", "thread-atlas", "atlas");
  const migration = onCall("Atlas migration");
  const call = [onCall("Gregg", "thread-gregg", "gregg"), nova, migration, atlas];
  for (const [text, expected] of [
    ["Scout, does everyone on the team have access to the repo?", ["Scout"]],
    ["Scout, is everyone invited to the review?", ["Scout"]],
    ["Gregg, are you all set with the deploy?", ["Gregg"]],
    ["Scout, are you all right with merging this?", ["Scout"]],
    ["Everyone on the team needs repo access. Scout, can you set that up?", ["Scout"]],
  ] as const)
    assert.deepStrictEqual(names(text, call), [...expected], text);
  // Asked of the group with nobody named first, it still goes to everyone.
  assert.deepStrictEqual(names("What does everyone think?", call).length, 5);
});

it("hears a name inside a longer one as the longer name only", () => {
  const atlas = onCall("Atlas", "thread-atlas", "atlas");
  const migration = onCall("Atlas migration");
  assert.deepStrictEqual(names("Atlas migration, how's it going?", [atlas, migration]), [
    "Atlas migration",
  ]);
  assert.deepStrictEqual(names("Atlas, how's it going?", [atlas, migration]), ["Atlas"]);
  assert.deepStrictEqual(names("Scout report, any updates?", [onCall("Scout report")]), [
    "Scout report",
  ]);
  // Both said: both hear it.
  assert.deepStrictEqual(names("Atlas and Atlas migration, sync up.", [atlas, migration]), [
    "Atlas",
    "Atlas migration",
  ]);
});

it("forgives the transcriber's spelling of a name the person addresses", () => {
  const greggAgent = onCall("Gregg", "thread-gregg", "gregg");
  const john = onCall("John", "thread-john", "john");
  for (const text of [
    "Hey Greg, can you check staging?",
    "Greg what do you think",
    "Can you check staging, Greg?",
  ])
    assert.deepStrictEqual(names(text, [greggAgent, john]), ["Gregg"], text);
  assert.deepStrictEqual(names("Jon, are you there?", [greggAgent, john]), ["John"]);
  // Only where someone is addressed, only one slip, and only when one name fits.
  assert.deepStrictEqual(names("I asked Greg about staging.", [greggAgent]), ["Scout"]);
  assert.deepStrictEqual(names("Grekg, check staging.", [greggAgent]), ["Gregg"]);
  assert.deepStrictEqual(names("Grog, check staging.", [greggAgent]), ["Scout"]);
  assert.deepStrictEqual(names("Gr, check staging.", [greggAgent]), ["Scout"]);
  assert.deepStrictEqual(
    names("Greg, check staging.", [greggAgent, onCall("Greig", "thread-greig", "greig")]),
    ["Scout"],
  );
  // Short names need the exact word.
  assert.deepStrictEqual(names("Zoey, are you there?", [onCall("Zoe")]), ["Scout"]);
});

it("sends unnamed words to the one chat on the call waiting on an answer", () => {
  const asking = (text: string, waiting: ReadonlyArray<ThreadId>) =>
    callDelegationTargets(text, primary, [gregg, release], new Set(waiting)).map(
      (target) => target.name,
    );
  assert.deepStrictEqual(asking("The work one.", [gregg.threadId]), ["Gregg"]);
  // Naming someone, or everyone, still decides.
  assert.deepStrictEqual(asking("Scout, the work one.", [gregg.threadId]), ["Scout"]);
  assert.deepStrictEqual(asking("Everyone, the work one.", [gregg.threadId]), [
    "Scout",
    "Gregg",
    "Release notes",
  ]);
  // The agent called asking too, or two chats asking: the agent called.
  assert.deepStrictEqual(asking("The work one.", [primary.threadId, gregg.threadId]), ["Scout"]);
  assert.deepStrictEqual(asking("The work one.", [gregg.threadId, release.threadId]), ["Scout"]);
  // A chat no longer on the call is nobody to answer.
  assert.deepStrictEqual(
    callDelegationTargets("The work one.", primary, [release], new Set([gregg.threadId])).map(
      (target) => target.name,
    ),
    ["Scout"],
  );
});

it("joins a chat to a call under its title, or an agent's main chat under the agent", () => {
  const threadId = ThreadId.make("thread-chat");
  const thread = { title: "Release notes", archivedAt: null };
  assert.deepStrictEqual(callParticipantFor({ threadId, thread, agent: null }), {
    threadId,
    title: "Release notes",
    vmAgentId: null,
  });
  assert.deepStrictEqual(
    callParticipantFor({
      threadId,
      thread,
      agent: { vmAgentId: VmAgentId.make("gregg"), name: "Gregg" },
    }),
    { threadId, title: "Gregg", vmAgentId: VmAgentId.make("gregg") },
  );
  const refusal = (input: Parameters<typeof callParticipantFor>[0]) => {
    const result = callParticipantFor(input);
    return "refusal" in result ? result.refusal : null;
  };
  assert.strictEqual(
    refusal({ threadId, thread: null, agent: null }),
    "That chat no longer exists.",
  );
  assert.include(
    refusal({ threadId, thread: { ...thread, archivedAt: at(1) }, agent: null }),
    "archived",
  );
  assert.strictEqual(
    refusal({ threadId: ThreadId.make(ORCHESTRATOR_THREAD_ID), thread, agent: null }),
    "The orchestrator can't join a call.",
  );
  assert.strictEqual(
    refusal({ threadId: ThreadId.make(`${AGENT_BUILDER_THREAD_PREFIX}x`), thread, agent: null }),
    "Agent Builder can't join a call.",
  );
  assert.strictEqual(
    refusal({ threadId: ThreadId.make("delegation-worker:d-1"), thread, agent: null }),
    "A delegated worker's chat can't join a call.",
  );
});

it("tells each chat on a group call who else is on it", () => {
  assert.strictEqual(
    groupCallNote({ others: ["Scout", "Nova"], everyone: false }),
    "(Group call: you're on a call with the person, Scout and Nova. The person addressed you.)",
  );
  assert.strictEqual(
    groupCallNote({ others: ["Gregg"], everyone: true }),
    "(Group call: you're on a call with the person and Gregg. The person addressed everyone.)",
  );
});

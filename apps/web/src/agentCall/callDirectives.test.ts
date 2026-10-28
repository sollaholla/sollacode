import { ThreadId, VmAgentId, type AgentCallParticipant } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  callParticipantNotice,
  callRosterInstructions,
  foldCallName,
  readCallDirectives,
  resolveRosterName,
  resolveSpokenNames,
} from "./callDirectives";

const entry = (name: string, agent: boolean) => ({
  name,
  threadId: ThreadId.make(`thread-${name}`),
  vmAgentId: agent ? VmAgentId.make(`agent-${name}`) : null,
});

const gregg = entry("Gregg", true);
const nova = entry("Nóva", true);
const notes = entry("Release notes draft", false);
const roster = [gregg, nova, notes];

const participant = (title: string): AgentCallParticipant => ({
  threadId: ThreadId.make(`thread-${title}`),
  title,
  vmAgentId: null,
});

/** The one directive an utterance ends with, or null. */
const readCallDirective = (words: string) => {
  const directives = readCallDirectives(words);
  expect(directives.length, words).toBeLessThanOrEqual(1);
  return directives[0] ?? null;
};

describe("readCallDirectives", () => {
  it("hears a transfer only when it ends what was said", () => {
    for (const words of [
      "Transferring you to Gregg.",
      "Sure thing. Transferring you to Gregg!",
      "Okay,   transferring you to “Gregg”.",
      "Transferring you to Gregg",
      'transferring you to Gregg."',
      "Okay, sure — transferring you to Gregg.",
    ]) {
      expect(readCallDirective(words), words).toEqual({ kind: "transfer", name: "Gregg" });
    }
    for (const words of [
      "Should I be transferring you to Gregg?",
      "I can't reach that person.",
      "",
    ]) {
      expect(readCallDirective(words), words).toBeNull();
    }
    // Words after the name make it nobody on the roster.
    const trailing = readCallDirective("Transferring you to Gregg. He'll pick up in a moment.");
    expect(resolveRosterName(trailing?.name ?? "", roster, { agentsOnly: true })).toBeNull();
  });

  it("hears a transfer only as its own sentence, never refused, put off or read out", () => {
    for (const words of [
      "Okay, I'll hold off on transferring you to Gregg.",
      "I'm not transferring you to Gregg.",
      "Sure. Once you're done here I'll be transferring you to Gregg.",
      "Scout says it would recommend transferring you to Gregg.",
      "No problem, I won't be transferring you to Gregg.",
      "Got it, no transfer. I'll stop transferring you to Gregg.",
    ])
      expect(readCallDirectives(words), words).toEqual([]);
  });

  it("keeps a name with dots in it whole", () => {
    expect(readCallDirective("Transferring you to Fix v1.2 build.")).toEqual({
      kind: "transfer",
      name: "Fix v1.2 build",
    });
    const doctor = readCallDirective("Transferring you to Dr. Nova.");
    expect(doctor).toEqual({ kind: "transfer", name: "Dr. Nova" });
    expect(
      resolveRosterName(doctor!.name, [entry("Dr. Nova", true)], { agentsOnly: true }),
    ).toEqual(entry("Dr. Nova", true));
  });

  it("hears adding and removing when they end what was said", () => {
    expect(readCallDirective("Adding Gregg to the call.")).toEqual({ kind: "add", name: "Gregg" });
    expect(readCallDirective("Got it. Sure, adding ‘Release notes’ to this call!")).toEqual({
      kind: "add",
      name: "Release notes",
    });
    expect(readCallDirective("Removing Gregg from the call.")).toEqual({
      kind: "remove",
      name: "Gregg",
    });
  });

  it("hears every add and remove the utterance closes with, in order", () => {
    for (const words of [
      "Sure. Adding Gregg to the call. Adding Nova to the call.",
      "Sure. Adding Gregg to the call, and adding Nova to the call.",
      "Adding Gregg to the call and adding Nova to the call.",
    ])
      expect(readCallDirectives(words), words).toEqual([
        { kind: "add", name: "Gregg" },
        { kind: "add", name: "Nova" },
      ]);
    expect(
      readCallDirectives("Removing Gregg from the call. Adding Release notes to the call."),
    ).toEqual([
      { kind: "remove", name: "Gregg" },
      { kind: "add", name: "Release notes" },
    ]);
    // Only the run that ends the utterance: an earlier phrase before other words is over.
    expect(
      readCallDirectives("Adding Gregg to the call. That's done. Adding Nova to the call."),
    ).toEqual([{ kind: "add", name: "Nova" }]);
    // A joined phrase needs one before it.
    expect(readCallDirectives("I'll check that and adding Nova to the call.")).toEqual([]);
  });

  it("keeps a name's own sentence punctuation", () => {
    for (const [words, name] of [
      ["Adding Why does login fail? to the call.", "Why does login fail?"],
      ['Adding "Why does CI fail?" to the call.', "Why does CI fail?"],
      ["Adding Fix login. Add tests to the call.", "Fix login. Add tests"],
      ["Sure. Adding Fix the build! to the call.", "Fix the build"],
      ["Adding Dr. Nova to the call.", "Dr. Nova"],
    ] as const)
      expect(readCallDirective(words), words).toEqual({ kind: "add", name });
    expect(readCallDirective("Removing Why does login fail? from the call.")).toEqual({
      kind: "remove",
      name: "Why does login fail?",
    });
    expect(
      resolveRosterName("Why does login fail?", [entry("Why does login fail?", false), gregg]),
    ).toEqual(entry("Why does login fail?", false));
  });

  it("ignores adding or removing that is not said as the phrase", () => {
    for (const words of [
      "Adding Gregg to the call. Go ahead.",
      "Want me to try adding Gregg to the call?",
      "Removing the old tests broke the build.",
      // A reply read out: not said as the phrase, or not at the end.
      "Gregg says the fetch fails on slow networks, so he's adding a timeout to the call.",
      "Gregg says he wrapped the fetch in a try-catch, adding logging to the call.",
      "He's adding auth headers to the call.",
      "Okay. I'm adding retries to this call in the client.",
      "Gregg finished. He's removing the retry from the call.",
    ])
      expect(readCallDirectives(words), words).toEqual([]);
  });
});

describe("resolveSpokenNames", () => {
  const release = entry("Release notes", false);
  const tests = entry("Tests for login flow", false);
  const people = [gregg, nova, release, tests];

  it("finds everyone a list names", () => {
    expect(resolveSpokenNames("Gregg and Nova", people)).toEqual({
      found: [gregg, nova],
      missing: [],
    });
    expect(resolveSpokenNames("Gregg, Nova and Release notes", people).found).toEqual([
      gregg,
      nova,
      release,
    ]);
    expect(resolveSpokenNames("Gregg and Morgan", people)).toEqual({
      found: [gregg],
      missing: ["Morgan"],
    });
  });

  it("hears a chat named the way people say it, but never by a word it starts with", () => {
    expect(resolveSpokenNames("the release notes chat", people).found).toEqual([release]);
    expect(resolveSpokenNames("Greg", people).found).toEqual([gregg]);
    // "Tests" is a word from a reply, not the "Tests for login flow" chat.
    expect(resolveSpokenNames("tests", people)).toEqual({ found: [], missing: ["tests"] });
    expect(resolveSpokenNames("logging", [entry("Logging cleanup", false)]).found).toEqual([]);
    expect(resolveSpokenNames("Release notes", people, { agentsOnly: true }).found).toEqual([]);
  });
});

describe("callRosterInstructions", () => {
  it("teaches the exact phrases only when there is someone to name", () => {
    expect(callRosterInstructions([])).toEqual([]);
    const lines = callRosterInstructions([gregg, nova, entry("Release notes", false)]);
    expect(lines).toEqual([
      "If the person asks to talk to one of the agents on your transfer list, say exactly 'Transferring you to <Name>.' and nothing after it; the call moves to them. If they ask for someone not on that list, say you can't reach them.",
      "Your transfer list: Gregg, Nóva.",
      expect.stringContaining("end what you say with exactly 'Adding <Name> to the call.'"),
      expect.stringContaining("Read those out as theirs."),
      "Your call list: Gregg, Nóva, Release notes.",
    ]);
    expect(lines[2]).toContain("end with exactly 'Removing <Name> from the call.'");
    // Only chats: nobody to transfer to. A title with a comma changes the separator.
    const chatsOnly = callRosterInstructions([
      entry("Login, again", false),
      entry("Release notes", false),
    ]);
    expect(chatsOnly).toHaveLength(3);
    expect(chatsOnly.at(-1)).toBe("Your call list: Login, again; Release notes.");
  });

  it("fits every line in one append, never cutting a name or a phrase", () => {
    const names = Array.from({ length: 30 }, (_, index) =>
      entry(`${"調査報告".repeat(12)}${index}`, index < 10),
    );
    const lines = callRosterInstructions(names);
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    for (const line of lines) expect(bytes(line)).toBeLessThanOrEqual(480);
    // The phrases come before any name, whole.
    expect(lines[0]).toContain("'Transferring you to <Name>.'");
    const listed = lines
      .filter((line) => line.startsWith("Your call list:"))
      .flatMap((line) => line.replace(/^Your call list: |\.$/gu, "").split(", "));
    expect(listed).toEqual(names.map((each) => each.name));
  });
});

describe("resolveRosterName", () => {
  it("matches ignoring case, accents and punctuation", () => {
    expect(resolveRosterName("gregg", roster)).toBe(gregg);
    expect(resolveRosterName("Nova", roster)).toBe(nova);
    expect(resolveRosterName("release notes, draft", roster)).toBe(notes);
  });

  it("forgives one slip, but never takes a beginning for the whole name", () => {
    expect(resolveRosterName("Greg", roster)).toBe(gregg);
    expect(resolveRosterName("Grekg", roster)).toBe(gregg);
    expect(resolveRosterName("Release", roster)).toBeNull();
    expect(resolveRosterName("Re", roster)).toBeNull();
  });

  it("refuses a name that fits more than one entry, or none", () => {
    expect(resolveRosterName("Greg", [entry("Gregory", true), entry("Gregson", true)])).toBeNull();
    expect(resolveRosterName("Mia", [entry("Mira", true), entry("Mila", true)])).toBeNull();
    expect(resolveRosterName("Morgan", roster)).toBeNull();
    expect(resolveRosterName("", roster)).toBeNull();
  });

  it("only offers agents for a transfer", () => {
    expect(resolveRosterName("Release notes draft", roster, { agentsOnly: true })).toBeNull();
    expect(resolveRosterName("Gregg", roster, { agentsOnly: true })).toBe(gregg);
  });

  it("folds names the same way on both sides", () => {
    expect(foldCallName("  Zoë’s  “Plan” ")).toBe("zoe s plan");
  });
});

describe("callParticipantNotice", () => {
  it("tells the voice who joined and who left, once", () => {
    const g = participant("Gregg");
    const n = participant("Notes");
    expect(callParticipantNotice([], [g])).toMatch(
      /^Gregg joined the call\. .*their replies come back with their name; read them out as theirs\.$/u,
    );
    expect(callParticipantNotice([g], [g])).toBeNull();
    expect(callParticipantNotice([g], [{ ...g, title: "Gregg" }, n])).toMatch(
      /^Notes joined the call\./u,
    );
    expect(callParticipantNotice([g, n], [n])).toBe("Gregg left the call.");
  });
});

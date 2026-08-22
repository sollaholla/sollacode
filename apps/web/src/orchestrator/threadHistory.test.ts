import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  MAX_SNIPPET_CHARS,
  buildSnippet,
  STATUS_TAIL_BUDGET_CHARS,
  STATUS_TAIL_MESSAGE_CHARS,
  readThreadHistory,
  resolveLimit,
  statusMessageTail,
  searchThreadMessages,
  type ThreadHistoryMessageInput,
} from "./threadHistory";

function message(
  overrides: Partial<ThreadHistoryMessageInput> & { text: string },
): ThreadHistoryMessageInput {
  return {
    role: "assistant",
    turnId: null,
    streaming: false,
    createdAt: "2026-08-17T12:00:00.000Z",
    ...overrides,
  };
}

describe("resolveLimit", () => {
  it("falls back when the model omits or garbles the limit", () => {
    expect(resolveLimit(undefined, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT)).toBe(
      DEFAULT_MESSAGE_LIMIT,
    );
    expect(resolveLimit("twenty", DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT)).toBe(
      DEFAULT_MESSAGE_LIMIT,
    );
    expect(resolveLimit(Number.NaN, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT)).toBe(
      DEFAULT_MESSAGE_LIMIT,
    );
  });

  it("clamps rather than trusting a spoken number", () => {
    expect(resolveLimit(5_000, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT)).toBe(MAX_MESSAGE_LIMIT);
    expect(resolveLimit(0, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT)).toBe(1);
    expect(resolveLimit(-3, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT)).toBe(1);
  });
});

describe("readThreadHistory", () => {
  it("returns the newest messages last and reports what was cut", () => {
    const result = readThreadHistory({
      messages: [
        message({ text: "one", role: "user" }),
        message({ text: "two" }),
        message({ text: "three", role: "user" }),
      ],
      limit: 2,
      includeActivities: false,
    });

    expect(result.messages.map((entry) => entry.text)).toEqual(["two", "three"]);
    expect(result.totalMessages).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("drops streaming and empty rows", () => {
    const result = readThreadHistory({
      messages: [
        message({ text: "settled" }),
        message({ text: "half-writt", streaming: true }),
        message({ text: "   " }),
      ],
      limit: 10,
      includeActivities: false,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("settled");
    expect(result.truncated).toBe(false);
  });

  it("numbers turns so the model can say which turn a message came from", () => {
    const result = readThreadHistory({
      messages: [
        message({ text: "a", turnId: "turn-aaa" }),
        message({ text: "b", turnId: "turn-aaa" }),
        message({ text: "c", turnId: "turn-bbb" }),
        message({ text: "d", turnId: null }),
      ],
      limit: 10,
      includeActivities: false,
    });

    expect(result.messages.map((entry) => entry.turn)).toEqual([1, 1, 2, null]);
  });

  it("returns activities only when asked, sharing the turn numbering", () => {
    const input = {
      messages: [message({ text: "a", turnId: "turn-aaa" })],
      activities: [
        {
          kind: "tool",
          summary: "ran the tests",
          tone: "info",
          turnId: "turn-aaa",
          createdAt: "2026-08-17T12:00:01.000Z",
        },
      ],
      limit: 10,
    };

    expect(readThreadHistory({ ...input, includeActivities: false }).activities).toEqual([]);
    const withActivities = readThreadHistory({ ...input, includeActivities: true });
    expect(withActivities.activities).toHaveLength(1);
    expect(withActivities.activities[0]?.turn).toBe(1);
  });

  it("truncates a long message rather than returning a wall of text", () => {
    const result = readThreadHistory({
      messages: [message({ text: "x".repeat(9_000) })],
      limit: 10,
      includeActivities: false,
    });

    const text = result.messages[0]?.text ?? "";
    expect(text.length).toBeLessThan(9_000);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("buildSnippet", () => {
  it("keeps short text whole", () => {
    expect(buildSnippet("the build is green", 4, 5)).toBe("the build is green");
  });

  it("centres on the match instead of returning the start of the message", () => {
    const needle = "PASSKEY-ENTITLEMENT";
    const text = `${"filler ".repeat(200)}${needle}${" trailer".repeat(200)}`;
    const snippet = buildSnippet(text, text.indexOf(needle), needle.length);

    expect(snippet).toContain(needle);
    expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS + 2);
  });

  it("collapses newlines so a snippet stays one spoken line", () => {
    expect(buildSnippet("first\n\n   second", 0, 5)).toBe("first second");
  });
});

describe("searchThreadMessages", () => {
  const messages = [
    message({ text: "started the migration", role: "user", turnId: "t1" }),
    message({ text: "the migration failed on step two", turnId: "t1" }),
    message({ text: "unrelated chatter", turnId: "t2" }),
    message({ text: "MIGRATION is now green", turnId: "t3" }),
  ];

  it("matches case-insensitively and reports the thread and turn", () => {
    const matches = searchThreadMessages({
      thread: "Vera Medical intake",
      project: "Vera Medical",
      messages,
      query: "migration",
      limit: 10,
    });

    expect(matches).toHaveLength(3);
    expect(matches[0]?.thread).toBe("Vera Medical intake");
    expect(matches[0]?.project).toBe("Vera Medical");
    // Newest first: the most recent mention is the one being asked about.
    expect(matches[0]?.snippet).toBe("MIGRATION is now green");
    expect(matches[0]?.turn).toBe(3);
  });

  it("honours the limit", () => {
    const matches = searchThreadMessages({
      thread: "t",
      project: "p",
      messages,
      query: "migration",
      limit: 1,
    });
    expect(matches).toHaveLength(1);
  });

  it("finds nothing for an empty query rather than matching everything", () => {
    expect(
      searchThreadMessages({ thread: "t", project: "p", messages, query: "   ", limit: 10 }),
    ).toEqual([]);
  });

  it("indexes error records at the time they occurred", () => {
    // An error is an activity, not a message. A search that read only messages
    // could not find a failure unless the agent also wrote it out in prose.
    const matches = searchThreadMessages({
      thread: "Native runtime rendering",
      project: "sample-project",
      messages: [
        message({ text: "starting the build", createdAt: "2026-08-17T09:00:00.000Z" }),
        message({ text: "trying again", createdAt: "2026-08-17T09:10:00.000Z" }),
      ],
      activities: [
        {
          kind: "provider-error",
          summary: "ECONNREFUSED talking to the provider bridge",
          tone: "error",
          turnId: null,
          createdAt: "2026-08-17T09:05:00.000Z",
        },
      ],
      query: "econnrefused",
      limit: 10,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.source).toBe("activity");
    expect(matches[0]?.isError).toBe(true);
    expect(matches[0]?.role).toBe("provider-error");
    // Its own timestamp, not the next message's.
    expect(matches[0]?.at).toBe("2026-08-17T09:05:00.000Z");
  });

  it("orders errors and messages by when each actually happened", () => {
    const matches = searchThreadMessages({
      thread: "t",
      project: "p",
      messages: [
        message({ text: "deploy step one", createdAt: "2026-08-17T09:00:00.000Z" }),
        message({ text: "deploy step three", createdAt: "2026-08-17T09:20:00.000Z" }),
      ],
      activities: [
        {
          kind: "provider-error",
          summary: "deploy step two failed",
          tone: "error",
          turnId: null,
          createdAt: "2026-08-17T09:10:00.000Z",
        },
      ],
      query: "deploy",
      limit: 10,
    });

    // Newest first, with the error interleaved by its own timestamp.
    expect(matches.map((match) => match.snippet)).toEqual([
      "deploy step three",
      "deploy step two failed",
      "deploy step one",
    ]);
  });

  it("marks non-error activities as matches without flagging them as failures", () => {
    const matches = searchThreadMessages({
      thread: "t",
      project: "p",
      messages: [],
      activities: [
        {
          kind: "tool",
          summary: "ran the migration script",
          tone: "tool",
          turnId: null,
          createdAt: "2026-08-17T09:05:00.000Z",
        },
      ],
      query: "migration",
      limit: 10,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.isError).toBe(false);
    expect(matches[0]?.source).toBe("activity");
  });

  it("skips streaming rows, which change under the reader", () => {
    const matches = searchThreadMessages({
      thread: "t",
      project: "p",
      messages: [message({ text: "migration in progress", streaming: true })],
      query: "migration",
      limit: 10,
    });
    expect(matches).toEqual([]);
  });
});

describe("statusMessageTail", () => {
  it("carries the last three messages when they are short", () => {
    const tail = statusMessageTail([
      message({ text: "older context" }),
      message({ role: "user", text: "run the tests" }),
      message({ text: "Tests passing." }),
      message({ text: "Done — pushed to main." }),
    ]);
    expect(tail.map((entry) => entry.text)).toEqual([
      "run the tests",
      "Tests passing.",
      "Done — pushed to main.",
    ]);
    expect(tail[0]?.role).toBe("user");
  });

  it("drops the older context first when the budget cuts", () => {
    // Three messages at the per-message cap total more than the budget, so
    // exactly the oldest one goes.
    const long = "a".repeat(STATUS_TAIL_BUDGET_CHARS);
    const tail = statusMessageTail([
      message({ text: `oldest ${long}` }),
      message({ text: `middle ${long}` }),
      message({ text: `ending ${long}` }),
    ]);
    expect(tail).toHaveLength(2);
    expect(tail[0]?.text.startsWith("middle")).toBe(true);
    expect(tail[1]?.text.startsWith("ending")).toBe(true);
  });

  it("always ships the final message, truncated, even when it alone is over budget", () => {
    const tail = statusMessageTail([message({ text: "b".repeat(5_000) })]);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.text.length).toBe(STATUS_TAIL_MESSAGE_CHARS + 1);
  });

  it("ignores streaming and empty rows", () => {
    const tail = statusMessageTail([
      message({ text: "kept" }),
      message({ text: "half-written", streaming: true }),
      message({ text: "   " }),
    ]);
    expect(tail.map((entry) => entry.text)).toEqual(["kept"]);
  });

  it("returns nothing for a thread with no spoken content", () => {
    expect(statusMessageTail([])).toEqual([]);
  });
});

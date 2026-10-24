import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationLiveBeat,
  type OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  beatsForEvent,
  commandSnippet,
  layer,
  LiveFeed,
  makeLiveFeedState,
  pathSnippet,
  plainSnippet,
  toolLabel,
} from "./LiveFeed.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const threadId = ThreadId.make("thread-live");
let sequence = 0;

function event(type: OrchestrationEvent["type"], payload: unknown): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-10-11T20:00:00.000Z",
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: payload as never,
  } as OrchestrationEvent;
}

function activity(
  id: string,
  kind: string,
  payload: unknown,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationEvent {
  return event("thread.activity-appended", {
    threadId,
    activity: {
      id: EventId.make(id),
      tone: "tool",
      kind,
      summary: kind,
      payload,
      turnId: null,
      createdAt: `2026-10-11T20:00:0${sequence % 10}.000Z`,
      ...overrides,
    },
  });
}

function message(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
  readonly updatedAt?: string;
  readonly extra?: Record<string, unknown>;
}): OrchestrationEvent {
  return event("thread.message-sent", {
    threadId,
    messageId: MessageId.make(input.id),
    role: input.role,
    text: input.text,
    turnId: null,
    streaming: input.streaming,
    createdAt: "2026-10-11T20:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-10-11T20:00:00.000Z",
    ...input.extra,
  });
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  itemType: "command_execution",
  title: "Command run",
  detail: `Bash: ${command}`,
  data: { toolName: "Bash", input: { command }, ...extra },
});

describe("live feed snippets", () => {
  it("reads like prose, a command or a path", () => {
    expect(plainSnippet("## Done\n**All** `237` tests pass. See [the log](http://x).", 200)).toBe(
      "Done All 237 tests pass. See the log.",
    );
    expect(plainSnippet("keep snake_case_names as they are", 200)).toBe(
      "keep snake_case_names as they are",
    );
    expect(plainSnippet("```ts\nconst a = 1;\n```", 200)).toBeNull();
    expect(commandSnippet("cd /Users/me/project && pnpm test --filter web")).toBe(
      "pnpm test --filter web",
    );
    expect(commandSnippet("cd '/a b'; python3 - <<'EOF'\nprint(1)\nEOF")).toBe(
      "python3 - <<'EOF' …",
    );
    expect(pathSnippet("/Users/me/Documents/project/apps/web/src/components/Thing.tsx")).toBe(
      "…/src/components/Thing.tsx",
    );
    expect(toolLabel("mcp__t3-code__preview_evaluate")).toBe("preview evaluate");
    expect(toolLabel("WebFetch")).toBe("web fetch");
  });
});

describe("beatsForEvent", () => {
  it("follows a command from running to done as one beat, never reading its output", () => {
    const state = makeLiveFeedState();
    // A call's first event carries no input yet.
    expect(
      beatsForEvent(
        state,
        activity("a1", "tool.started", {
          itemType: "command_execution",
          title: "Command run",
          detail: "Bash: {}",
        }),
      ),
    ).toEqual([]);
    const running = beatsForEvent(
      state,
      activity("a2", "tool.updated", bash("cd /repo && pnpm test")),
    );
    expect(running).toMatchObject([
      { id: "a2", kind: "command", title: "Running", detail: "pnpm test", live: true },
    ]);
    // The same update again changes nothing on screen.
    expect(
      beatsForEvent(state, activity("a3", "tool.updated", bash("cd /repo && pnpm test"))),
    ).toEqual([]);
    const done = beatsForEvent(
      state,
      activity(
        "a4",
        "tool.completed",
        bash("cd /repo && pnpm test", { result: { content: "x".repeat(100_000) } }),
      ),
    );
    expect(done).toMatchObject([
      { id: "a2", kind: "command", title: "Ran", detail: "pnpm test", live: false },
    ]);
    expect(JSON.stringify(done).length).toBeLessThan(400);
  });

  it("names file, search and other tools for what they did", () => {
    const state = makeLiveFeedState();
    expect(
      beatsForEvent(
        state,
        activity("r1", "tool.completed", {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail:
            'Read: {"file_path":"/Users/someone/Documents/work/a-long-project-name/src/app/main.ts"}',
          data: {
            toolName: "Read",
            input: {
              file_path: "/Users/someone/Documents/work/a-long-project-name/src/app/main.ts",
            },
          },
        }),
      ),
    ).toMatchObject([{ kind: "read", title: "Read", detail: "…/src/app/main.ts" }]);
    expect(
      beatsForEvent(
        state,
        activity("m1", "tool.completed", {
          itemType: "mcp_tool_call",
          title: "MCP tool call",
          detail: 'mcp__t3-code__preview_evaluate: {"expression":"1"}',
          data: { toolName: "mcp__t3-code__preview_evaluate", input: { expression: "1" } },
        }),
      ),
    ).toMatchObject([{ kind: "tool", title: "Used preview evaluate", detail: null }]);
  });

  it("keeps the plumbing out", () => {
    const state = makeLiveFeedState();
    for (const kind of ["context-window.updated", "provider.usage.updated", "turn.usage"]) {
      expect(beatsForEvent(state, activity(`n-${kind}`, kind, {}, { tone: "info" }))).toEqual([]);
    }
    expect(
      beatsForEvent(
        state,
        event("thread.activity-appended", {
          threadId,
          historicalReplay: true,
          activity: {
            id: EventId.make("old"),
            tone: "error",
            kind: "runtime.error",
            summary: "Runtime error",
            payload: {},
            turnId: null,
            createdAt: "2026-10-11T20:00:00.000Z",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("calls out what needs the person, and what went wrong", () => {
    const state = makeLiveFeedState();
    expect(
      beatsForEvent(
        state,
        activity(
          "q1",
          "user-input.requested",
          { questions: [{ id: "cap", question: "How much money may it spend?" }] },
          { tone: "info" },
        ),
      ),
    ).toMatchObject([
      { kind: "attention", title: "Asked you a question", detail: "How much money may it spend?" },
    ]);
    expect(
      beatsForEvent(
        state,
        activity(
          "p1",
          "approval.requested",
          { requestKind: "command", detail: "rm -rf build" },
          { tone: "approval" },
        ),
      ),
    ).toMatchObject([
      { kind: "attention", title: "Wants approval to run a command", detail: "rm -rf build" },
    ]);
    expect(
      beatsForEvent(
        state,
        activity(
          "e1",
          "runtime.error",
          { message: "You've hit your session limit" },
          { tone: "error", summary: "Runtime error" },
        ),
      ),
    ).toMatchObject([
      { kind: "error", title: "Runtime error", detail: "You've hit your session limit" },
    ]);
  });

  it("tracks a background task from start to finish, and skips finishes it never saw start", () => {
    const state = makeLiveFeedState();
    const started = beatsForEvent(
      state,
      activity(
        "t1",
        "task.started",
        { taskId: "build", detail: "Wait for the APK build" },
        { tone: "info" },
      ),
    );
    expect(started).toMatchObject([{ id: "t1", kind: "task", live: true }]);
    expect(
      beatsForEvent(
        state,
        activity(
          "t2",
          "task.completed",
          { taskId: "build", status: "completed" },
          { tone: "info" },
        ),
      ),
    ).toMatchObject([{ id: "t1", kind: "task", title: "Finished in the background", live: false }]);
    expect(
      beatsForEvent(
        state,
        activity("t3", "task.completed", { taskId: "other", status: "stopped" }, { tone: "info" }),
      ),
    ).toEqual([]);
  });

  it("shows a reply as it is written, at most every second and a half, then settles it", () => {
    const state = makeLiveFeedState();
    const first = beatsForEvent(
      state,
      message({ id: "reply", role: "assistant", text: "I'll **fix** the", streaming: true }),
    );
    expect(first).toMatchObject([
      { id: "reply", kind: "said", detail: "I'll fix the", live: true },
    ]);
    expect(
      beatsForEvent(
        state,
        message({
          id: "reply",
          role: "assistant",
          text: " failing test",
          streaming: true,
          updatedAt: "2026-10-11T20:00:01.000Z",
        }),
      ),
    ).toEqual([]);
    expect(
      beatsForEvent(
        state,
        message({
          id: "reply",
          role: "assistant",
          text: " now.",
          streaming: true,
          updatedAt: "2026-10-11T20:00:02.000Z",
        }),
      ),
    ).toMatchObject([{ detail: "I'll fix the failing test now.", live: true }]);
    expect(
      beatsForEvent(state, message({ id: "reply", role: "assistant", text: "", streaming: false })),
    ).toMatchObject([{ id: "reply", detail: "I'll fix the failing test now.", live: false }]);
  });

  it("shows messages sent to a thread, typed or spoken", () => {
    const state = makeLiveFeedState();
    expect(
      beatsForEvent(
        state,
        message({
          id: "ask",
          role: "user",
          text: "Run the tests again",
          streaming: false,
          extra: { senderThreadTitle: "Orchestrator" },
        }),
      ),
    ).toMatchObject([{ kind: "asked", title: "Message from Orchestrator" }]);
    expect(
      beatsForEvent(
        state,
        message({
          id: "voice",
          role: "user",
          text: "what's going on",
          streaming: false,
          extra: { voiceTranscript: true },
        }),
      ),
    ).toMatchObject([{ kind: "asked", title: "You said", detail: "what's going on" }]);
  });
});

describe("LiveFeed", () => {
  it.effect("sends the recent beats, then each new one, to every viewer", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const liveLayer = layer.pipe(
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({ streamDomainEvents: Stream.fromQueue(events) }),
        ),
      );
      yield* Effect.gen(function* () {
        const feed = yield* LiveFeed;
        const watching = yield* Deferred.make<void>();
        const first = yield* feed.stream.pipe(
          Stream.tap((item) =>
            item.type === "snapshot" ? Deferred.succeed(watching, undefined) : Effect.void,
          ),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(watching);
        yield* Queue.offerAll(events, [
          activity("x1", "context-window.updated", {}, { tone: "info" }),
          activity("x2", "tool.updated", bash("pnpm lint")),
          activity("x3", "tool.completed", bash("pnpm lint")),
        ]);
        const seen = yield* Fiber.join(first);
        expect(seen.map((item) => item.type)).toEqual(["snapshot", "beat", "beat"]);
        expect(seen.flatMap((item) => (item.type === "beat" ? [item.beat.live] : []))).toEqual([
          true,
          false,
        ]);

        // A viewer arriving later starts from the finished beat, not the running one.
        const later = yield* feed.stream.pipe(Stream.take(1), Stream.runCollect);
        const snapshot = later[0];
        expect(snapshot?.type).toBe("snapshot");
        const beats: ReadonlyArray<OrchestrationLiveBeat> =
          snapshot?.type === "snapshot" ? snapshot.beats : [];
        expect(beats).toMatchObject([{ id: "x2", title: "Ran", live: false }]);
      }).pipe(Effect.provide(liveLayer));
    }),
  );
});

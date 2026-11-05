import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  isPausedShell,
  makePausedThreadResumer,
  resumeOutcomeOf,
  undeliveredMessageId,
} from "./PausedThreadResumer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const paused = {
  archivedAt: null,
  pendingWork: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  session: { status: "error", activeTurnId: null, lastError: "You hit your limit" },
};
const threadEvent = (threadId: string, type: string, payload: unknown) =>
  ({
    eventId: EventId.make(`event-${threadId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type,
    payload,
  }) as unknown as OrchestrationEvent;
const replied = (threadId: string) =>
  threadEvent(threadId, "thread.message-sent", { role: "assistant" });
const refused = (threadId: string) =>
  threadEvent(threadId, "thread.session-set", { session: { status: "error" } });

/** A workspace where `answer` decides what each started chat does. */
const harness = (
  shells: Record<string, unknown>,
  answer: (threadId: string) => OrchestrationEvent | null,
) => {
  const dispatched: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const layer = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        streamDomainEvents: Stream.fromPubSub(events),
        dispatch: (command) =>
          Effect.gen(function* () {
            dispatched.push(command as OrchestrationCommand);
            const event = "threadId" in command ? answer(command.threadId) : null;
            if (event !== null) yield* PubSub.publish(events, event);
            return { sequence: dispatched.length };
          }),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (id) => Effect.succeed(Option.fromUndefinedOr(shells[id]) as never),
        getThreadDetailById: () =>
          Effect.succeed(Option.some({ messages: [], activities: [] }) as never),
      }),
    );
    const resumer = yield* makePausedThreadResumer.pipe(Effect.provide(layer));
    return { resumer, events, dispatched };
  });
};

/** Lets the background run reach its next step. */
const settle = Effect.gen(function* () {
  for (let tick = 0; tick < 40; tick += 1) yield* Effect.yieldNow;
});

const started = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) => (command.type === "thread.turn.start" ? [command.threadId] : []));

const ids = (...names: ReadonlyArray<string>) => names.map((name) => ThreadId.make(name));

describe("PausedThreadResumer", () => {
  it.effect("brings chats back in order, each after the last replied", () =>
    Effect.gen(function* () {
      const { resumer, dispatched } = yield* harness({ a: paused, b: paused }, replied);
      assert.deepStrictEqual(yield* resumer.resume({ threadIds: ids("a", "b") }), { queued: 2 });
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["a", "b"]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops when the provider refuses again, leaving the rest paused", () =>
    Effect.gen(function* () {
      const { resumer, dispatched } = yield* harness({ a: paused, b: paused }, refused);
      yield* resumer.resume({ threadIds: ids("a", "b") });
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["a"]);
    }).pipe(Effect.scoped),
  );

  it.effect("waits for the chat already resuming, and starts nothing if it is refused", () =>
    Effect.gen(function* () {
      const { resumer, events, dispatched } = yield* harness({ a: paused }, replied);
      yield* resumer.resume({ threadIds: ids("a"), afterThreadId: ThreadId.make("first") });
      yield* settle;
      assert.deepStrictEqual(started(dispatched), []);
      yield* PubSub.publish(events, refused("first"));
      yield* settle;
      assert.deepStrictEqual(started(dispatched), []);
    }).pipe(Effect.scoped),
  );

  it.effect("starts the others once that chat has replied", () =>
    Effect.gen(function* () {
      const { resumer, events, dispatched } = yield* harness({ a: paused }, replied);
      yield* resumer.resume({ threadIds: ids("a"), afterThreadId: ThreadId.make("first") });
      yield* settle;
      yield* PubSub.publish(events, replied("first"));
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["a"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a chat still paused when the wait ends reads as refused", () =>
    Effect.gen(function* () {
      const { resumer, dispatched } = yield* harness({ a: paused, b: paused }, () => null);
      yield* resumer.resume({ threadIds: ids("a", "b") });
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["a"]);
      yield* TestClock.adjust("46 seconds");
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["a"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a slow first reply counts as working once the chat left its pause", () =>
    Effect.gen(function* () {
      const shells: Record<string, unknown> = { a: paused, b: paused };
      const { resumer, dispatched } = yield* harness(shells, (threadId) => {
        shells[threadId] = { ...paused, session: { status: "running", activeTurnId: "t" } };
        return null;
      });
      yield* resumer.resume({ threadIds: ids("a", "b") });
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["a"]);
      yield* TestClock.adjust("46 seconds");
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["a", "b"]);
    }).pipe(Effect.scoped),
  );

  it.effect("skips a chat that no longer needs it", () =>
    Effect.gen(function* () {
      const { resumer, dispatched } = yield* harness(
        { a: { ...paused, session: { status: "running", activeTurnId: "t" } }, b: paused },
        replied,
      );
      yield* resumer.resume({ threadIds: ids("a", "b") });
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["b"]);
    }).pipe(Effect.scoped),
  );

  it.effect("moves each chat to the account the person chose", () =>
    Effect.gen(function* () {
      const modelSelection = { instanceId: "claude_work", model: "opus" } as never;
      const { resumer, dispatched } = yield* harness({ a: paused }, replied);
      yield* resumer.resume({ threadIds: ids("a"), modelSelection });
      yield* settle;
      const [command] = dispatched;
      if (command?.type !== "thread.turn.start") return assert.fail("expected a turn");
      assert.deepStrictEqual(command.modelSelection, modelSelection);
    }).pipe(Effect.scoped),
  );

  it.effect("stopping a chat in the run ends the run", () =>
    Effect.gen(function* () {
      const { resumer, events, dispatched } = yield* harness({ a: paused, b: paused }, () => null);
      yield* resumer.resume({ threadIds: ids("a", "b") });
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["a"]);
      yield* PubSub.publish(events, threadEvent("a", "thread.turn-interrupt-requested", {}));
      yield* settle;
      yield* PubSub.publish(events, replied("a"));
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["a"]);
      assert.deepStrictEqual(yield* resumer.stop, { stopped: false });
    }).pipe(Effect.scoped),
  );

  it.effect("stop ends the run, and says when there was none", () =>
    Effect.gen(function* () {
      const { resumer, dispatched } = yield* harness({ a: paused, b: paused }, () => null);
      assert.deepStrictEqual(yield* resumer.stop, { stopped: false });
      yield* resumer.resume({ threadIds: ids("a", "b") });
      yield* settle;
      assert.deepStrictEqual(yield* resumer.stop, { stopped: true });
      yield* TestClock.adjust("2 minutes");
      yield* settle;
      assert.deepStrictEqual(started(dispatched), ["a"]);
    }).pipe(Effect.scoped),
  );
});

describe("isPausedShell", () => {
  it("is a provider stop with nothing running, queued or archived", () => {
    assert.isTrue(isPausedShell(paused as never));
    assert.isFalse(isPausedShell({ ...paused, pendingWork: {} } as never));
    assert.isFalse(isPausedShell({ ...paused, archivedAt: "2026-11-01" } as never));
    assert.isFalse(
      isPausedShell({ ...paused, session: { ...paused.session, status: "stopped" } } as never),
    );
  });
});

describe("resumeOutcomeOf", () => {
  it("reads a reply or tool use as working and a new failure as refused", () => {
    assert.strictEqual(resumeOutcomeOf(replied("a")), "working");
    assert.strictEqual(
      resumeOutcomeOf(threadEvent("a", "thread.activity-appended", { activity: { tone: "tool" } })),
      "working",
    );
    assert.strictEqual(resumeOutcomeOf(refused("a")), "refused");
    assert.isNull(resumeOutcomeOf(threadEvent("a", "thread.message-sent", { role: "user" })));
  });
});

describe("undeliveredMessageId", () => {
  const user = { id: MessageId.make("m1"), role: "user", createdAt: "2026-11-05T01:00:00.000Z" };
  const failure = (payload: unknown) => ({
    kind: "provider.turn.start.failed",
    createdAt: "2026-11-05T01:00:01.000Z",
    payload,
  });

  it("finds a message whose delivery was cancelled", () => {
    assert.strictEqual(
      undeliveredMessageId({
        messages: [user],
        activities: [failure({ messageId: "m1", deliveryCancelled: true })],
      }),
      user.id,
    );
  });

  it("leaves one still being retried, or already answered", () => {
    assert.isNull(
      undeliveredMessageId({
        messages: [user],
        activities: [failure({ messageId: "m1", deliveryCancelled: false })],
      }),
    );
    assert.isNull(
      undeliveredMessageId({
        messages: [
          user,
          {
            id: MessageId.make("m2"),
            role: "assistant",
            createdAt: "2026-11-05T01:00:02.000Z",
          },
        ],
        activities: [failure({ messageId: "m1", deliveryCancelled: true })],
      }),
    );
  });
});

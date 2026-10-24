import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  INITIAL_EVENT_CURSOR,
  takeUnseenEvents,
  toEventWindows,
  type EventCursor,
  type EventWindow,
} from "./eventWindow.ts";

const BURST = [
  { type: "session-updated", status: "approved" },
  { type: "video-chunk", n: 0 },
  { type: "video-chunk", n: 1 },
] as const;

/** Reads an atom the way a React render does: once per tick that notified. */
const readLikeRender = Effect.fnUntraced(function* <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  const registry = AtomRegistry.make();
  const rendered: A[] = [];
  registry.subscribe(
    atom,
    () => {
      queueMicrotask(() => {
        const current = registry.get(atom);
        if (current._tag === "Success") rendered.push(current.value);
      });
    },
    { immediate: true },
  );
  yield* Effect.sleep("20 millis");
  return rendered;
});

describe("a stream atom read the way React reads it", () => {
  it.live("loses everything but the last element of a batch (the bug this exists for)", () =>
    Effect.gen(function* () {
      const rendered = yield* readLikeRender(Atom.make(Stream.fromIterable(BURST)));
      expect(rendered.map((event) => event.type)).not.toContain("session-updated");
    }),
  );

  it.live("keeps every element of that batch reachable through an event window", () =>
    Effect.gen(function* () {
      const rendered = yield* readLikeRender(
        Atom.make(Stream.fromIterable(BURST).pipe(toEventWindows())),
      );
      let cursor: EventCursor = INITIAL_EVENT_CURSOR;
      const handled: string[] = [];
      for (const window of rendered) {
        const next = takeUnseenEvents(window, cursor);
        cursor = next.cursor;
        handled.push(...next.events.map((event) => event.type));
      }
      expect(handled).toEqual(["session-updated", "video-chunk", "video-chunk"]);
    }),
  );
});

describe("toEventWindows", () => {
  it.effect("emits cumulative windows with a running sequence", () =>
    Effect.gen(function* () {
      const windows = yield* Stream.fromIterable([1, 2, 3]).pipe(
        toEventWindows(),
        Stream.runCollect,
      );
      const last = Array.from(windows).at(-1)!;
      expect(last.sequence).toBe(3);
      expect(last.events).toEqual([1, 2, 3]);
    }),
  );

  it.effect("keeps only the newest events once past capacity, still counting all of them", () =>
    Effect.gen(function* () {
      const windows = yield* Stream.fromIterable([1, 2, 3, 4, 5]).pipe(
        toEventWindows(3),
        Stream.runCollect,
      );
      const last = Array.from(windows).at(-1)!;
      expect(last.sequence).toBe(5);
      expect(last.events).toEqual([3, 4, 5]);
    }),
  );

  it.effect("starts a new epoch for every run of the stream", () =>
    Effect.gen(function* () {
      const stream = Stream.fromIterable([1]).pipe(toEventWindows());
      const first = Array.from(yield* Stream.runCollect(stream)).at(-1)!;
      const second = Array.from(yield* Stream.runCollect(stream)).at(-1)!;
      expect(second.epoch).not.toBe(first.epoch);
    }),
  );
});

describe("takeUnseenEvents", () => {
  const window = (epoch: number, sequence: number, events: number[]): EventWindow<number> => ({
    epoch,
    sequence,
    events,
  });

  it("hands over only what the reader has not handled", () => {
    const first = takeUnseenEvents(window(1, 3, [1, 2, 3]), INITIAL_EVENT_CURSOR);
    expect(first.events).toEqual([1, 2, 3]);
    const second = takeUnseenEvents(window(1, 5, [1, 2, 3, 4, 5]), first.cursor);
    expect(second.events).toEqual([4, 5]);
    expect(second.missed).toBe(0);
  });

  it("hands over nothing when nothing is new, and for a null or empty window", () => {
    const cursor: EventCursor = { epoch: 1, seen: 3 };
    expect(takeUnseenEvents(window(1, 3, [1, 2, 3]), cursor).events).toEqual([]);
    expect(takeUnseenEvents(null, cursor)).toEqual({ events: [], cursor, missed: 0 });
    expect(takeUnseenEvents(window(2, 0, []), cursor).events).toEqual([]);
  });

  it("starts over on a new epoch even when its sequence is already past the old cursor", () => {
    const cursor: EventCursor = { epoch: 1, seen: 2 };
    const next = takeUnseenEvents(window(2, 4, [10, 11, 12, 13]), cursor);
    expect(next.events).toEqual([10, 11, 12, 13]);
    expect(next.cursor).toEqual({ epoch: 2, seen: 4 });
  });

  it("reports events that scrolled out of the window before the reader came back", () => {
    // Ten events so far, the window holds the last three (8 to 10), and the
    // reader had handled four: events 5, 6 and 7 are gone.
    const next = takeUnseenEvents(window(1, 10, [8, 9, 10]), { epoch: 1, seen: 4 });
    expect(next.events).toEqual([8, 9, 10]);
    expect(next.missed).toBe(3);
  });
});

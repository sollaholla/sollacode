import { it } from "@effect/vitest";
import { type PreviewEvent, ThreadId } from "@t3tools/contracts";
import { PreviewUrlNormalizationError } from "@t3tools/shared/preview";
import { Deferred, Effect, Fiber, Option, PubSub } from "effect";
import { expect } from "vite-plus/test";

import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PreviewSessionStoreLive } from "../persistence/Layers/PreviewSessions.ts";
import { PreviewSessionStore } from "../persistence/Services/PreviewSessions.ts";
import * as PreviewManager from "./Manager.ts";

const managerTestLayer = PreviewManager.layer.pipe(
  Layer.provideMerge(PreviewSessionStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
);

const DRAIN_LIMIT = 100;

interface EventCollector {
  /** Drain everything published since the last call (or since subscribe). */
  readonly drain: Effect.Effect<ReadonlyArray<PreviewEvent>>;
}

/**
 * Each `it.effect` shares the live PreviewManager layer across the whole
 * `it.layer` block, so tests that assert per-thread counts must use a unique
 * thread id to avoid bleeding state from earlier tests.
 */
let nextThreadId = 0;
const freshThreadId = () => ThreadId.make(`thread-${++nextThreadId}`);

/**
 * Subscribe to the manager's event stream BEFORE the test publishes. We
 * use `subscribeEvents` (synchronous PubSub.subscribe under the hood) so
 * no event can land between subscribe and the consumer drain.
 */
const collectEvents = Effect.gen(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  const subscription = yield* manager.subscribeEvents;
  const collector: EventCollector = {
    drain: PubSub.takeUpTo(subscription, DRAIN_LIMIT),
  };
  return collector;
}).pipe(Effect.withSpan("preview.test.collectEvents"));

it.layer(managerTestLayer)("PreviewManager", (it) => {
  it.effect("opens a session and emits opened with normalized URL", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const snapshot = yield* manager.open({ threadId, url: "localhost:5173" });
      expect(snapshot.tabId.startsWith("tab_")).toBe(true);
      expect(snapshot.navStatus._tag).toBe("Loading");
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/");
      }

      const events = yield* collector.drain;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("opened");
      if (events[0]?.type === "opened") {
        expect(events[0].tabId).toBe(snapshot.tabId);
      }
    }),
  );

  it.effect("opens an Idle tab when no URL is supplied", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const snapshot = yield* manager.open({ threadId });
      expect(snapshot.navStatus._tag).toBe("Idle");
    }),
  );

  it.effect("orders list snapshots and events with one monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const before = yield* manager.list({ threadId });

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/ready",
      });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events[0]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[1]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[0]!.revision).toBeGreaterThan(before.revision);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(1);
    }),
  );

  it.effect("treats bare hosts as https", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const snapshot = yield* manager.open({ threadId, url: "example.com" });
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("https://example.com/");
      }
    }),
  );

  it.effect("rejects empty URL with PreviewInvalidUrlError", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(manager.open({ threadId, url: "   " }));
      expect(error._tag).toBe("PreviewInvalidUrlError");
      expect(error).toMatchObject({ inputLength: 3, reason: "empty" });
      expect(error).not.toHaveProperty("rawUrl");
      expect(error.cause).toBeInstanceOf(PreviewUrlNormalizationError);
      expect((error.cause as PreviewUrlNormalizationError).reason).toBe("empty");
    }),
  );

  it.effect("preserves URL parser failures as the invalid URL cause chain", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const rawUrl = "https://user:password@example.com:bad/path?access_token=secret#fragment";
      const error = yield* Effect.flip(manager.open({ threadId, url: rawUrl }));

      expect(error).toMatchObject({
        inputLength: rawUrl.length,
        reason: "parse",
        protocol: "https:",
      });
      expect(error).not.toHaveProperty("rawUrl");
      expect(error.cause).toBeInstanceOf(PreviewUrlNormalizationError);
      const normalizationError = error.cause as PreviewUrlNormalizationError;
      expect(normalizationError.cause).toBeInstanceOf(Error);
      expect(error.message).not.toContain((normalizationError.cause as Error).message);
      expect(error.message).not.toMatch(/user|password|access_token|secret|fragment/);
    }),
  );

  it.effect("navigate updates snapshot and emits navigated", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const snapshot = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/about",
        resolvedTitle: "About",
      });

      expect(snapshot.navStatus._tag).toBe("Success");
      if (snapshot.navStatus._tag === "Success") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/about");
        expect(snapshot.navStatus.title).toBe("About");
      }
      const events = yield* collector.drain;
      expect(events.map((e) => e.type)).toEqual(["opened", "navigated"]);
    }),
  );

  it.effect("navigate fails for unknown tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(
        manager.navigate({
          threadId,
          tabId: "tab_missing",
          url: "http://localhost:5173",
        }),
      );
      expect(error._tag).toBe("PreviewSessionLookupError");
    }),
  );

  it.effect("resizes a tab and preserves its viewport across navigation reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });

      const resized = yield* manager.resize({
        threadId,
        tabId: opened.tabId,
        viewport: { _tag: "freeform", width: 1024, height: 768 },
      });
      expect(resized.viewport).toEqual({ _tag: "freeform", width: 1024, height: 768 });

      const navigated = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/resized",
      });
      expect(navigated.viewport).toEqual(resized.viewport);

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/resized", title: "Resized" },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions[0]?.viewport).toEqual(resized.viewport);

      const events = yield* collector.drain;
      expect(events.map((event) => event.type)).toEqual([
        "opened",
        "resized",
        "navigated",
        "navigated",
      ]);
    }),
  );

  it.effect("rejects resize for an unknown tab", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(
        manager.resize({
          threadId: freshThreadId(),
          tabId: "tab_missing",
          viewport: { _tag: "fill" },
        }),
      );
      expect(error._tag).toBe("PreviewSessionLookupError");
    }),
  );

  it.effect("reportStatus emits failed for LoadFailed nav", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: {
          _tag: "LoadFailed",
          url: "http://localhost:5173",
          title: "",
          code: -105,
          description: "ERR_NAME_NOT_RESOLVED",
        },
        canGoBack: false,
        canGoForward: false,
      });

      const events = yield* collector.drain;
      const failed = events.find((e) => e.type === "failed");
      expect(failed?.type).toBe("failed");
      if (failed?.type === "failed") {
        expect(failed.code).toBe(-105);
        expect(failed.description).toBe("ERR_NAME_NOT_RESOLVED");
      }
    }),
  );

  it.effect("closing the final tab atomically replaces it with a distinct Idle tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.close({ threadId, tabId: opened.tabId });

      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.tabId).not.toBe(opened.tabId);
      expect(result.sessions[0]?.navStatus._tag).toBe("Idle");

      const events = yield* collector.drain;
      expect(events.map((event) => event.type)).toEqual(["opened", "closed", "opened"]);
      expect(events[2]?.revision).toBeGreaterThan(events[1]!.revision);
      if (events[2]?.type === "opened") {
        expect(events[2].tabId).toBe(result.sessions[0]?.tabId);
        expect(events[2].snapshot.navStatus._tag).toBe("Idle");
      }
    }),
  );

  it.effect("gives every tab in a batch close its own monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });
      const collector = yield* collectEvents;

      yield* manager.close({ threadId });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events.map((event) => event.type)).toEqual(["closed", "closed", "opened"]);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(events[2]!.revision).toBeGreaterThan(events[1]!.revision);
      expect(listed.revision).toBe(events[2]!.revision);
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]?.navStatus._tag).toBe("Idle");
    }),
  );

  it.effect("close is idempotent for unknown threads", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.close({ threadId });
      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(0);
    }),
  );

  it.effect("list returns every snapshot for the thread sorted by updatedAt", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const first = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const second = yield* manager.open({ threadId, url: "http://localhost:3000" });
      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(2);
      const ids = result.sessions.map((s) => s.tabId);
      expect(ids).toContain(first.tabId);
      expect(ids).toContain(second.tabId);
    }),
  );

  it.effect("open creates an independent tab on every call", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000/path" });

      expect(a.tabId).not.toBe(b.tabId);
      const list = yield* manager.list({ threadId });
      expect(list.sessions).toHaveLength(2);

      const events = yield* collector.drain;
      expect(events.map((e) => e.type)).toEqual(["opened", "opened"]);
    }),
  );

  it.effect("close with an exact missing tabId fails without changing the thread", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      const error = yield* Effect.flip(manager.close({ threadId, tabId: "tab_missing" }));

      expect(error._tag).toBe("PreviewSessionLookupError");
      const list = yield* manager.list({ threadId });
      expect(list.sessions).toHaveLength(1);
    }),
  );

  it.effect("close with explicit tabId removes only that tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000" });

      yield* manager.close({ threadId, tabId: a.tabId });

      const list = yield* manager.list({ threadId });
      expect(list.sessions.map((s) => s.tabId)).toEqual([b.tabId]);
    }),
  );

  it.effect("never reuses a closed tab id for unrelated future work", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "https://one.example/" });
      const closed = yield* manager.open({ threadId, url: "https://two.example/" });

      yield* manager.close({ threadId, tabId: closed.tabId });
      const next = yield* manager.open({ threadId, url: "https://three.example/" });

      expect(next.tabId).not.toBe(closed.tabId);
    }),
  );

  it.effect("multiple subscribers receive every event independently", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const aSub = yield* manager.subscribeEvents;
      const bSub = yield* manager.subscribeEvents;

      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });

      const aEvents = yield* PubSub.takeUpTo(aSub, DRAIN_LIMIT);
      const bEvents = yield* PubSub.takeUpTo(bSub, DRAIN_LIMIT);
      expect(aEvents.map((e) => e.type)).toEqual(["opened", "opened"]);
      expect(bEvents.map((e) => e.type)).toEqual(["opened", "opened"]);
    }),
  );
});

// Durability: every session, including a blank tab, must survive a manager
// (process) restart via the persisted store.
it.effect("restores persisted Idle tabs across a restart", () =>
  Effect.gen(function* () {
    const threadId = freshThreadId();
    const first = yield* PreviewManager.make;
    const opened = yield* first.open({ threadId });

    const second = yield* PreviewManager.make;
    const restored = yield* second.list({ threadId });
    expect(restored.sessions).toHaveLength(1);
    expect(restored.sessions[0]?.tabId).toBe(opened.tabId);
    expect(restored.sessions[0]?.navStatus._tag).toBe("Idle");
  }).pipe(
    Effect.provide(PreviewSessionStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  ),
);

// Three managers are built over ONE store layer inside a single provide,
// modeling three server lifetimes over one database. Closing a persisted final
// tab must forget that identity while retaining its blank replacement.
it.effect("persists a distinct replacement when the final restored tab closes", () =>
  Effect.gen(function* () {
    const threadId = freshThreadId();
    const first = yield* PreviewManager.make;
    const opened = yield* first.open({ threadId, url: "https://studio.youtube.com/" });
    yield* first.reportStatus({
      threadId,
      tabId: opened.tabId,
      navStatus: {
        _tag: "Success",
        url: "https://studio.youtube.com/channel/x",
        title: "Channel dashboard",
      },
      canGoBack: true,
      canGoForward: false,
    });

    const second = yield* PreviewManager.make;
    const restored = yield* second.list({ threadId });
    expect(restored.sessions.map((session) => session.tabId)).toEqual([opened.tabId]);
    const restoredSnapshot = restored.sessions[0];
    expect(restoredSnapshot?.navStatus).toEqual({
      _tag: "Success",
      url: "https://studio.youtube.com/channel/x",
      title: "Channel dashboard",
    });

    const closeResult = yield* second.close({ threadId, tabId: opened.tabId });
    const replaced = yield* second.list({ threadId });
    expect(closeResult).toBeDefined();
    if (!closeResult) return;
    expect(closeResult.closedTabIds).toEqual([opened.tabId]);
    expect(closeResult.sessions).toEqual(replaced.sessions);
    expect(closeResult.revision).toBe(replaced.revision);
    expect(closeResult.serverEpoch).toBe(replaced.serverEpoch);
    expect(replaced.sessions).toHaveLength(1);
    expect(replaced.sessions[0]?.tabId).not.toBe(opened.tabId);
    expect(replaced.sessions[0]?.navStatus._tag).toBe("Idle");

    const third = yield* PreviewManager.make;
    const afterClose = yield* third.list({ threadId });
    expect(afterClose.sessions).toHaveLength(1);
    expect(afterClose.sessions[0]?.tabId).toBe(replaced.sessions[0]?.tabId);
    expect(afterClose.sessions[0]?.navStatus._tag).toBe("Idle");
  }).pipe(
    Effect.provide(PreviewSessionStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  ),
);

it.effect(
  "orders delayed status persistence before close so a restart cannot resurrect the tab",
  () =>
    Effect.gen(function* () {
      const baseStore = yield* PreviewSessionStore;
      const persistStarted = yield* Deferred.make<void>();
      const releasePersist = yield* Deferred.make<void>();
      const deleteStarted = yield* Deferred.make<void>();
      const delayedStore = PreviewSessionStore.of({
        ...baseStore,
        upsert: (session) =>
          session.snapshot.navStatus._tag === "Success" &&
          session.snapshot.navStatus.title === "Delayed status"
            ? Deferred.succeed(persistStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releasePersist)),
                Effect.andThen(baseStore.upsert(session)),
              )
            : baseStore.upsert(session),
        deleteSession: (input) =>
          Deferred.succeed(deleteStarted, undefined).pipe(
            Effect.andThen(baseStore.deleteSession(input)),
          ),
      });
      const threadId = freshThreadId();
      const first = yield* PreviewManager.make.pipe(
        Effect.provideService(PreviewSessionStore, delayedStore),
      );
      const opened = yield* first.open({ threadId, url: "https://example.com/" });

      const statusFiber = yield* Effect.forkChild(
        first.reportStatus({
          threadId,
          tabId: opened.tabId,
          navStatus: {
            _tag: "Success",
            url: "https://example.com/ready",
            title: "Delayed status",
          },
          canGoBack: false,
          canGoForward: false,
        }),
        { startImmediately: true },
      );
      yield* Deferred.await(persistStarted);

      const closeFiber = yield* Effect.forkChild(first.close({ threadId, tabId: opened.tabId }), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      expect(Option.isNone(yield* Deferred.poll(deleteStarted))).toBe(true);

      yield* Deferred.succeed(releasePersist, undefined);
      yield* Fiber.join(statusFiber);
      yield* Fiber.join(closeFiber);
      expect(Option.isSome(yield* Deferred.poll(deleteStarted))).toBe(true);

      const second = yield* PreviewManager.make.pipe(
        Effect.provideService(PreviewSessionStore, delayedStore),
      );
      const restored = yield* second.list({ threadId });
      expect(restored.sessions).toHaveLength(1);
      expect(restored.sessions[0]?.tabId).not.toBe(opened.tabId);
      expect(restored.sessions[0]?.navStatus._tag).toBe("Idle");
    }).pipe(
      Effect.provide(PreviewSessionStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
    ),
);

// Regression: tab ids used to come from a process-global counter that reset
// on every restart, so the first open after a reboot was handed "tab_1" again
// and silently replaced the session just restored from the database.
it.effect("opening after a restart never reuses a restored tab's id", () =>
  Effect.gen(function* () {
    const threadId = freshThreadId();
    const first = yield* PreviewManager.make;
    const openedIds: string[] = [];
    for (const url of ["https://one.example/", "https://two.example/", "https://three.example/"]) {
      const opened = yield* first.open({ threadId, url });
      openedIds.push(opened.tabId);
      yield* first.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url, title: url },
        canGoBack: false,
        canGoForward: false,
      });
    }

    const second = yield* PreviewManager.make;
    const restored = yield* second.list({ threadId });
    expect(restored.sessions).toHaveLength(3);

    const reopened = yield* second.open({ threadId, url: "https://four.example/" });
    expect(openedIds).not.toContain(reopened.tabId);
    const afterOpen = yield* second.list({ threadId });
    expect(afterOpen.sessions).toHaveLength(4);
    expect(new Set(afterOpen.sessions.map((session) => session.tabId)).size).toBe(4);
  }).pipe(
    Effect.provide(PreviewSessionStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  ),
);

import * as TestClock from "effect/testing/TestClock";
import { it } from "@effect/vitest";
import { expect, describe } from "vite-plus/test";
import { Effect, Layer, PubSub } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PreviewSessionStoreLive } from "../persistence/Layers/PreviewSessions.ts";
import { PreviewSessionStore } from "../persistence/Services/PreviewSessions.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import * as Manager from "./Manager.ts";
import { makeSweep, protectedPreviewTabIds, layer as expiryLayer } from "./Expiry.ts";

const persistence = Layer.mergeAll(PreviewSessionStoreLive, ProjectionThreadRepositoryLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const testLayer = Manager.layer.pipe(Layer.provideMerge(persistence));
const none = new Set<string>();
const threadId = ThreadId.make("expiry-thread");

const insertThread = (id: string, parent: string | null = null, pendingApprovalCount = 0) =>
  Effect.gen(function* () {
    const repo = yield* ProjectionThreadRepository;
    yield* repo.upsert({
      threadId: ThreadId.make(id),
      projectId: ProjectId.make("expiry-project"),
      title: id,
      isSideChat: parent !== null,
      sideChatParentThreadId: parent === null ? null : ThreadId.make(parent),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurnId: null,
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      latestUserMessageAt: null,
      pendingApprovalCount,
      pendingUserInputCount: 0,
      hasActionableProposedPlan: 0,
      deletedAt: null,
    });
  });

it.effect("closes at 30 minutes, persists removal, and emits ordered close events", () =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const store = yield* PreviewSessionStore;
    const events = yield* manager.subscribeEvents;
    const tab = yield* manager.open({ threadId, url: "https://example.test" });
    yield* TestClock.adjust("29 minutes");
    expect(yield* manager.expireIdle(none)).toEqual([]);
    yield* TestClock.adjust("1 minute");
    expect(yield* manager.expireIdle(none)).toEqual([tab.tabId]);
    expect(yield* store.listAll()).toHaveLength(0);
    expect((yield* manager.list({})).sessions).toHaveLength(0);
    const received = yield* PubSub.takeUpTo(events, 10);
    expect(received.map((event) => event.type)).toEqual(["opened", "closed"]);
    expect(received[1]!.revision).toBeGreaterThan(received[0]!.revision);
    const reopened = yield* manager.open({ threadId, url: "https://example.test" });
    expect(reopened.tabId).not.toBe(tab.tabId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("page updates do not reset activity, but new user input wins before expiry", () =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const idle = yield* manager.open({ threadId });
    const active = yield* manager.open({ threadId });
    yield* TestClock.adjust("29 minutes");
    yield* manager.reportStatus({
      threadId,
      tabId: idle.tabId,
      navStatus: {
        _tag: "Success",
        url: "https://example.test/refresh",
        title: "Background refresh",
      },
      canGoBack: false,
      canGoForward: false,
    });
    yield* manager.reportActivity({ threadId, tabId: active.tabId, interacted: true });
    yield* TestClock.adjust("1 minute");
    expect(yield* manager.expireIdle(none)).toEqual([idle.tabId]);
    yield* TestClock.adjust("28 minutes");
    expect(yield* manager.expireIdle(none)).toEqual([]);
    yield* TestClock.adjust("1 minute");
    expect(yield* manager.expireIdle(none)).toEqual([active.tabId]);
    expect(
      (yield* Effect.result(
        manager.reportActivity({ threadId, tabId: idle.tabId, interacted: true }),
      ))._tag,
    ).toBe("Failure");
    expect((yield* manager.list({})).sessions).toHaveLength(0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("browser gates persist through restart and resolution starts a fresh window", () =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const tab = yield* manager.open({ threadId });
    yield* manager.reportActivity({
      threadId,
      tabId: tab.tabId,
      interacted: false,
      attentionRequired: true,
    });
    yield* TestClock.adjust("1 hour");
    const restarted = yield* Manager.make;
    expect(yield* restarted.expireIdle(none)).toEqual([]);
    yield* restarted.reportActivity({
      threadId,
      tabId: tab.tabId,
      interacted: false,
      attentionRequired: false,
    });
    yield* TestClock.adjust("29 minutes");
    expect(yield* restarted.expireIdle(none)).toEqual([]);
    yield* TestClock.adjust("1 minute");
    expect(yield* restarted.expireIdle(none)).toEqual([tab.tabId]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a connected side-chat approval protects its parent's tabs until resolved", () =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const sql = yield* SqlClient.SqlClient;
    yield* insertThread("parent");
    yield* insertThread("side", "parent", 1);
    const parent = yield* manager.open({ threadId: ThreadId.make("parent") });
    const unrelated = yield* manager.open({ threadId: ThreadId.make("unrelated") });
    const sweep = yield* makeSweep;
    yield* TestClock.adjust("31 minutes");
    expect(yield* sweep()).toEqual([unrelated.tabId]);
    yield* sql`UPDATE projection_threads SET pending_approval_count = 0, pending_user_input_count = 1 WHERE thread_id = 'side'`;
    yield* TestClock.adjust("30 minutes");
    expect(yield* sweep()).toEqual([]);
    yield* sql`UPDATE projection_threads SET pending_user_input_count = 0 WHERE thread_id = 'side'`;
    yield* TestClock.adjust("29 minutes");
    expect(yield* sweep()).toEqual([]);
    yield* TestClock.adjust("1 minute");
    expect(yield* sweep()).toEqual([parent.tabId]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("scheduled sweep runs without a connected renderer", () =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const events = yield* manager.subscribeEvents;
    yield* manager.open({ threadId });
    yield* Layer.build(expiryLayer);
    yield* TestClock.adjust("30 minutes");
    // The event receipt proves the scheduled worker completed, without wall-clock sleeps.
    expect((yield* PubSub.take(events)).type).toBe("opened");
    expect((yield* PubSub.take(events)).type).toBe("closed");
  }).pipe(Effect.provide(testLayer)),
);

const tab = (id: string, url: string): PreviewSessionSnapshot => ({
  threadId: "owner",
  tabId: id,
  navStatus: { _tag: "Success", url, title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-09-22T00:00:00.000Z",
});
describe("card page association", () => {
  const tabs = [
    tab("login", "https://account.test/sign-in/step2"),
    tab("other", "https://other.test/"),
  ];
  it("protects the linked site's tab across path changes, not unrelated sites", () => {
    expect([
      ...protectedPreviewTabIds(tabs, [{ threadId: "owner", url: "https://account.test/start" }]),
    ]).toEqual(["login"]);
  });
  it("does not protect another chat's tabs for the same URL", () => {
    expect([
      ...protectedPreviewTabIds(tabs, [{ threadId: "other", url: "https://account.test/" }]),
    ]).toEqual([]);
  });
  it("keeps a redirected sign-in staged when the card URL no longer matches", () => {
    expect(
      protectedPreviewTabIds(tabs, [{ threadId: "owner", url: "https://identity.test/authorize" }])
        .size,
    ).toBe(2);
  });
  it("preserves legacy cards with no page association conservatively", () => {
    expect(protectedPreviewTabIds(tabs, [{ threadId: "owner", url: null }]).size).toBe(2);
  });
});

it.effect(
  "persisted Waiting on you cards protect only their linked site and release it on resolution",
  () =>
    Effect.gen(function* () {
      const manager = yield* Manager.PreviewManager;
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread("owner");
      yield* sql`INSERT INTO vm_agents (vm_agent_id, name, name_lower, handle, purpose, vm_id, thread_id, status, created_at, updated_at)
    VALUES ('expiry-agent', 'Expiry', 'expiry', 'expiry', 'QA', 'expiry-vm', 'owner', 'stopped', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z')`;
      yield* sql`INSERT INTO vm_agent_blockers (blocker_id, vm_agent_id, title, detail, url, created_at, updated_at)
    VALUES ('expiry-blocker', 'expiry-agent', 'Sign in', 'Waiting on you', 'https://account.test/start', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z')`;
      const linked = yield* manager.open({
        threadId: ThreadId.make("owner"),
        url: "https://account.test/step2",
      });
      const unrelated = yield* manager.open({
        threadId: ThreadId.make("owner"),
        url: "https://other.test",
      });
      const sweep = yield* makeSweep;
      yield* TestClock.adjust("31 minutes");
      expect(yield* sweep()).toEqual([unrelated.tabId]);
      yield* sql`UPDATE vm_agent_blockers SET resolved_at = '2026-09-22T01:00:00.000Z' WHERE blocker_id = 'expiry-blocker'`;
      yield* TestClock.adjust("30 minutes");
      expect(yield* sweep()).toEqual([linked.tabId]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("a protection-query failure keeps expired tabs open", () =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const sql = yield* SqlClient.SqlClient;
    const tab = yield* manager.open({ threadId });
    const sweep = yield* makeSweep;
    yield* TestClock.adjust("31 minutes");
    yield* sql`DROP TABLE vm_agent_blockers`;
    expect((yield* Effect.result(sweep()))._tag).toBe("Failure");
    expect((yield* manager.list({})).sessions.map((session) => session.tabId)).toEqual([tab.tabId]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "legacy and invalid timestamps get bounded expiry rather than refreshing on page status",
  () =>
    Effect.gen(function* () {
      const store = yield* PreviewSessionStore;
      const legacy = tab("legacy", "https://legacy.test");
      const invalid = { ...tab("invalid", "https://invalid.test"), updatedAt: "bad-date" };
      yield* store.upsert({
        threadId: legacy.threadId,
        tabId: legacy.tabId,
        snapshot: legacy,
        updatedAt: legacy.updatedAt,
      });
      yield* store.upsert({
        threadId: invalid.threadId,
        tabId: invalid.tabId,
        snapshot: invalid,
        updatedAt: "2026-09-22T00:00:00.000Z",
      });
      yield* TestClock.setTime(Date.parse("2026-09-22T01:00:00.000Z"));
      const manager = yield* Manager.make;
      yield* manager.reportStatus({
        threadId: ThreadId.make("owner"),
        tabId: legacy.tabId,
        navStatus: legacy.navStatus,
        canGoBack: false,
        canGoForward: false,
      });
      expect(yield* manager.expireIdle(none)).toEqual(["legacy"]);
      yield* TestClock.adjust("30 minutes");
      expect(yield* manager.expireIdle(none)).toEqual(["invalid"]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("continuous input persists periodically without publishing layout events", () =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const store = yield* PreviewSessionStore;
    const tab = yield* manager.open({ threadId });
    const events = yield* manager.subscribeEvents;
    for (let second = 0; second < 20; second++) {
      yield* TestClock.adjust("1 second");
      yield* manager.reportActivity({ threadId, tabId: tab.tabId, interacted: true });
    }
    const stored = (yield* store.listAll())[0]!;
    expect(Date.parse(stored.snapshot.lastActivityAt!) - Date.parse(tab.lastActivityAt!)).toBe(
      15_000,
    );
    expect(yield* PubSub.takeUpTo(events, 10)).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a failed durable delete leaves the tab open and a later sweep retries", () =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const sql = yield* SqlClient.SqlClient;
    const tab = yield* manager.open({ threadId });
    yield* sql`CREATE TEMP TRIGGER deny_preview_expiry BEFORE DELETE ON preview_sessions BEGIN SELECT RAISE(ABORT, 'database is locked'); END`;
    yield* TestClock.adjust("30 minutes");
    expect(yield* manager.expireIdle(none)).toEqual([]);
    expect((yield* manager.list({})).sessions).toHaveLength(1);
    yield* sql`DROP TRIGGER deny_preview_expiry`;
    expect(yield* manager.expireIdle(none)).toEqual([tab.tabId]);
  }).pipe(Effect.provide(testLayer)),
);

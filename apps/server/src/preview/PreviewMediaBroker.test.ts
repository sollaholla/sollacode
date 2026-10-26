import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationStreamEvent,
  type PreviewEvent,
  type PreviewMediaWatchEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { SessionCredentialChange } from "../auth/SessionStore.ts";
import { withSessionLifetime } from "../auth/sessionLifetime.ts";
import * as MediaRelay from "../media/MediaRelay.ts";
import * as Automation from "../mcp/PreviewAutomationBroker.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PreviewManager } from "./Manager.ts";
import { make, withPreviewMediaDemand } from "./PreviewMediaBroker.ts";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const target = { threadId, tabId: "tab" };
const hostSession = AuthSessionId.make("host-session");
const viewerSession = AuthSessionId.make("viewer-session");
const otherSession = AuthSessionId.make("other-session");

const harness = Effect.gen(function* () {
  let tabExists = true;
  const events = yield* PubSub.unbounded<PreviewEvent>();
  const sessionChanges = yield* PubSub.unbounded<SessionCredentialChange>();
  const manager = PreviewManager.of({
    hasSession: (input: { threadId: string; tabId: string }) =>
      tabExists && input.threadId === threadId && input.tabId === target.tabId,
    reportActivity: () => Effect.void,
    subscribeEvents: PubSub.subscribe(events),
  } as never);
  const automation = yield* Automation.make.pipe(
    Effect.provideService(PreviewManager, manager),
    Effect.provideService(
      ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.of({
        getThreadShellById: () => Effect.succeed(Option.none()),
      } as never),
    ),
  );
  const relay = yield* MediaRelay.make;
  const broker = yield* make({
    automation,
    manager,
    relay,
    environmentId,
    owningThreadId: (id) => Effect.succeed(id === "side-chat" ? threadId : id),
  });
  const startHost = (
    overrides: Partial<PreviewAutomationHost> = {},
    sessionId: AuthSessionId | undefined = hostSession,
  ) =>
    Effect.gen(function* () {
      const host = { clientId: "desktop", environmentId, streamsPreviewMedia: true, ...overrides };
      const connected = yield* Deferred.make<string>();
      const seen: PreviewAutomationStreamEvent[] = [];
      const hostEvents = yield* automation.connect(host, sessionId);
      const stream = host.streamsPreviewMedia
        ? withPreviewMediaDemand(hostEvents, broker)
        : hostEvents;
      const changes = yield* PubSub.subscribe(sessionChanges);
      const fiber = yield* stream.pipe(
        Stream.runForEach((event) => {
          seen.push(event);
          if (event.type === "connected") return Deferred.succeed(connected, event.connectionId);
          if (event.type === "request")
            return automation.respond({
              clientId: host.clientId,
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              result: { tabId: target.tabId },
            });
          return Effect.void;
        }),
        (operation) =>
          sessionId === undefined ? operation : withSessionLifetime(sessionId, changes, operation),
        Effect.forkScoped,
      );
      return {
        clientId: host.clientId,
        connectionId: yield* Deferred.await(connected),
        fiber,
        seen,
      };
    });
  const watch = (input = target, sessionId = viewerSession) =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<PreviewMediaWatchEvent>();
      const changes = yield* PubSub.subscribe(sessionChanges);
      const fiber = yield* broker.watch(input, sessionId).pipe(
        Stream.runForEach((event) => Queue.offer(queue, event)),
        (operation) => withSessionLifetime(sessionId, changes, operation),
        Effect.forkScoped,
      );
      return { queue, fiber };
    });
  const publishClose = PubSub.publish(events, {
    type: "closed",
    ...target,
    serverEpoch: "epoch",
    revision: 1,
    createdAt: "2026-10-26T00:00:00.000Z",
  });
  const close = Effect.gen(function* () {
    tabExists = false;
    yield* publishClose;
  });
  const revoke = (sessionId: AuthSessionId) =>
    PubSub.publish(sessionChanges, { type: "clientRemoved", sessionId });
  return { broker, relay, automation, startHost, watch, close, publishClose, revoke };
});

const nextReady = (queue: Queue.Queue<PreviewMediaWatchEvent>) =>
  Effect.gen(function* () {
    const event = yield* Queue.take(queue);
    expect(event.type).toBe("ready");
    if (event.type !== "ready") return yield* Effect.die("Expected ready watch");
    return event.watchId;
  });

it.effect("binds subscriber and publisher tickets to authenticated watch/host identities", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const host = yield* h.startHost();
      const watched = yield* h.watch();
      const watchId = yield* nextReady(watched.queue);
      expect((yield* Effect.flip(h.broker.issueTicket({ watchId }, otherSession)))._tag).toBe(
        "PreviewMediaAccessDeniedError",
      );
      for (const input of [
        { ...target, clientId: "copied-client", connectionId: host.connectionId },
        { ...target, clientId: host.clientId, connectionId: "copied-connection" },
        {
          ...target,
          tabId: "another-tab",
          clientId: host.clientId,
          connectionId: host.connectionId,
        },
        {
          ...target,
          threadId: ThreadId.make("another-thread"),
          clientId: host.clientId,
          connectionId: host.connectionId,
        },
      ])
        expect((yield* Effect.flip(h.broker.issueHostTicket(input, hostSession)))._tag).toBe(
          "PreviewMediaAccessDeniedError",
        );
      const hostInput = { ...target, clientId: host.clientId, connectionId: host.connectionId };
      expect((yield* Effect.flip(h.broker.issueHostTicket(hostInput, otherSession)))._tag).toBe(
        "PreviewMediaAccessDeniedError",
      );
      const subscriber = yield* h.relay.redeemTicket(
        (yield* h.broker.issueTicket({ watchId }, viewerSession)).ticket,
      );
      const publisher = yield* h.relay.redeemTicket(
        (yield* h.broker.issueHostTicket(hostInput, hostSession)).ticket,
      );
      expect(subscriber?.role).toBe("subscribe");
      expect(publisher?.role).toBe("publish");
      expect(publisher?.topic).toBe(subscriber?.topic);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps other viewers alive and closes the generation when its last watch leaves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const host = yield* h.startHost();
      const first = yield* h.watch();
      const firstId = yield* nextReady(first.queue);
      const second = yield* h.watch(target, otherSession);
      const secondId = yield* nextReady(second.queue);
      const firstTicket = yield* h.broker.issueTicket({ watchId: firstId }, viewerSession);
      const secondTicket = yield* h.broker.issueTicket({ watchId: secondId }, otherSession);
      const publisherTicket = yield* h.broker.issueHostTicket(
        { ...target, clientId: host.clientId, connectionId: host.connectionId },
        hostSession,
      );
      const publisher = yield* h.relay.redeemTicket(publisherTicket.ticket);
      yield* Fiber.interrupt(first.fiber);
      expect(yield* h.relay.redeemTicket(firstTicket.ticket)).toBeNull();
      expect(publisher?.isActive()).toBe(true);
      yield* Fiber.interrupt(second.fiber);
      expect(yield* h.relay.redeemTicket(secondTicket.ticket)).toBeNull();
      expect(publisher?.isActive()).toBe(false);
      expect(
        (yield* h.broker.demand(host.connectionId).pipe(Stream.take(1), Stream.runCollect))[0],
      ).toEqual([]);
      expect(
        (yield* Effect.flip(
          h.broker.issueHostTicket(
            { ...target, clientId: host.clientId, connectionId: host.connectionId },
            hostSession,
          ),
        ))._tag,
      ).toBe("PreviewMediaAccessDeniedError");
      const third = yield* h.watch();
      const thirdId = yield* nextReady(third.queue);
      const thirdGrant = yield* h.relay.redeemTicket(
        (yield* h.broker.issueTicket({ watchId: thirdId }, viewerSession)).ticket,
      );
      expect(thirdGrant?.topic).not.toBe(publisher?.topic);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("invalidates a disconnected host and recovers with fresh watch IDs and topics", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const host = yield* h.startHost();
      const watched = yield* h.watch();
      const firstId = yield* nextReady(watched.queue);
      const oldTicket = yield* h.broker.issueTicket({ watchId: firstId }, viewerSession);
      const oldPublisher = yield* h.relay.redeemTicket(
        (yield* h.broker.issueHostTicket(
          { ...target, clientId: host.clientId, connectionId: host.connectionId },
          hostSession,
        )).ticket,
      );
      yield* Fiber.interrupt(host.fiber);
      expect(oldPublisher?.isActive()).toBe(false);
      expect(yield* h.relay.redeemTicket(oldTicket.ticket)).toBeNull();
      expect((yield* Queue.take(watched.queue)).type).toBe("unavailable");
      const replacement = yield* h.startHost();
      const newId = yield* nextReady(watched.queue);
      expect(newId).not.toBe(firstId);
      expect(
        (yield* Effect.flip(h.broker.issueTicket({ watchId: firstId }, viewerSession)))._tag,
      ).toBe("PreviewMediaAccessDeniedError");
      expect(
        (yield* Effect.flip(
          h.broker.issueHostTicket(
            { ...target, clientId: host.clientId, connectionId: host.connectionId },
            hostSession,
          ),
        ))._tag,
      ).toBe("PreviewMediaAccessDeniedError");
      const fresh = yield* h.relay.redeemTicket(
        (yield* h.broker.issueHostTicket(
          { ...target, clientId: replacement.clientId, connectionId: replacement.connectionId },
          hostSession,
        )).ticket,
      );
      expect(fresh?.topic).not.toBe(oldPublisher?.topic);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("revokes grants immediately when the exact canonical tab closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const host = yield* h.startHost();
      const watched = yield* h.watch({ ...target, threadId: ThreadId.make("side-chat") });
      const watchId = yield* nextReady(watched.queue);
      expect(
        (yield* h.broker.demand(host.connectionId).pipe(Stream.take(1), Stream.runCollect))[0],
      ).toEqual([target]);
      const ticket = yield* h.broker.issueTicket({ watchId }, viewerSession);
      const grant = yield* h.relay.redeemTicket(
        (yield* h.broker.issueHostTicket(
          { ...target, clientId: host.clientId, connectionId: host.connectionId },
          hostSession,
        )).ticket,
      );
      yield* h.close;
      expect(grant?.isActive()).toBe(false);
      expect(yield* h.relay.redeemTicket(ticket.ticket)).toBeNull();
      expect((yield* Queue.take(watched.queue)).type).toBe("unavailable");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("leaves JPEG-only hosts unchanged and never moves an assigned tab to a video host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const old = yield* h.startHost({ streamsPreviewMedia: false });
      yield* h.automation.invoke({
        scope: {
          environmentId,
          threadId,
          providerSessionId: "provider",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["preview"]),
          issuedAt: 1,
        },
        operation: "snapshot",
        input: {},
        tabId: target.tabId,
      });
      yield* h.startHost({ clientId: "video-host" });
      const watched = yield* h.watch();
      expect((yield* Queue.take(watched.queue)).type).toBe("unavailable");
      expect(old.seen.some((event) => event.type === "mediaDemand")).toBe(false);
      expect(h.automation.mediaHostFor({ ...target, environmentId })).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not grant media for nonexistent tabs or unauthenticated registrations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      // A legacy/internal registration without an auth session cannot publish.
      const connected = yield* h.automation.connect({
        clientId: "internal",
        environmentId,
        streamsPreviewMedia: true,
      });
      const ready = yield* Deferred.make<void>();
      yield* connected.pipe(
        Stream.runForEach(() => Deferred.succeed(ready, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      const watched = yield* h.watch();
      expect((yield* Queue.take(watched.queue)).type).toBe("unavailable");
      yield* h.startHost();
      yield* nextReady(watched.queue);
      const unknown = yield* h.watch({ ...target, tabId: "missing" });
      expect((yield* Queue.take(unknown.queue)).type).toBe("unavailable");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("honors a close receipt before the manager has committed its state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const host = yield* h.startHost();
      const watched = yield* h.watch();
      const watchId = yield* nextReady(watched.queue);
      const pendingTicket = yield* h.broker.issueTicket({ watchId }, viewerSession);
      yield* h.publishClose;
      expect((yield* Queue.take(watched.queue)).type).toBe("unavailable");
      expect(yield* h.relay.redeemTicket(pendingTicket.ticket)).toBeNull();
      expect(
        (yield* h.broker.demand(host.connectionId).pipe(Stream.take(1), Stream.runCollect))[0],
      ).toEqual([]);
      // A subsequent host registration cannot resurrect a closed tab's watch.
      yield* h.startHost({ clientId: "other-desktop" });
      expect((yield* Effect.flip(h.broker.issueTicket({ watchId }, viewerSession)))._tag).toBe(
        "PreviewMediaAccessDeniedError",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("human watching does not create an agent host assignment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const firstHost = yield* h.startHost();
      const watched = yield* h.watch();
      const firstId = yield* nextReady(watched.queue);
      const oldGrant = yield* h.relay.redeemTicket(
        (yield* h.broker.issueHostTicket(
          { ...target, clientId: firstHost.clientId, connectionId: firstHost.connectionId },
          hostSession,
        )).ticket,
      );
      const nextHost = yield* h.startHost({ clientId: "other-desktop" });
      const nextId = yield* nextReady(watched.queue);
      expect(nextId).not.toBe(firstId);
      expect(oldGrant?.isActive()).toBe(false);
      expect(h.automation.mediaHostFor({ ...target, environmentId })?.connectionId).toBe(
        nextHost.connectionId,
      );
      const fresh = yield* h.relay.redeemTicket(
        (yield* h.broker.issueHostTicket(
          { ...target, clientId: nextHost.clientId, connectionId: nextHost.connectionId },
          hostSession,
        )).ticket,
      );
      expect(fresh?.isActive()).toBe(true);
      expect(fresh?.topic).not.toBe(oldGrant?.topic);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("revocation ends only that viewer's watch and prevents ticket reissue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const host = yield* h.startHost();
      const revokedViewer = yield* h.watch();
      const revokedId = yield* nextReady(revokedViewer.queue);
      const retainedViewer = yield* h.watch(target, otherSession);
      const retainedId = yield* nextReady(retainedViewer.queue);
      const revokedTicket = yield* h.broker.issueTicket({ watchId: revokedId }, viewerSession);
      const publisher = yield* h.relay.redeemTicket(
        (yield* h.broker.issueHostTicket(
          { ...target, clientId: host.clientId, connectionId: host.connectionId },
          hostSession,
        )).ticket,
      );
      yield* h.revoke(viewerSession);
      yield* Fiber.await(revokedViewer.fiber);
      expect(yield* h.relay.redeemTicket(revokedTicket.ticket)).toBeNull();
      expect(
        (yield* Effect.flip(h.broker.issueTicket({ watchId: revokedId }, viewerSession)))._tag,
      ).toBe("PreviewMediaAccessDeniedError");
      expect(publisher?.isActive()).toBe(true);
      const retained = yield* h.relay.redeemTicket(
        (yield* h.broker.issueTicket({ watchId: retainedId }, otherSession)).ticket,
      );
      expect(retained?.isActive()).toBe(true);
      yield* h.revoke(otherSession);
      yield* Fiber.await(retainedViewer.fiber);
      expect(publisher?.isActive()).toBe(false);
      expect(retained?.isActive()).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("revoking a host session invalidates its publisher and existing viewer tickets", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const host = yield* h.startHost();
      const viewer = yield* h.watch();
      const watchId = yield* nextReady(viewer.queue);
      const subscriberTicket = yield* h.broker.issueTicket({ watchId }, viewerSession);
      const hostInput = { ...target, clientId: host.clientId, connectionId: host.connectionId };
      const publisher = yield* h.relay.redeemTicket(
        (yield* h.broker.issueHostTicket(hostInput, hostSession)).ticket,
      );
      yield* h.revoke(hostSession);
      yield* Fiber.await(host.fiber);
      expect(publisher?.isActive()).toBe(false);
      expect(yield* h.relay.redeemTicket(subscriberTicket.ticket)).toBeNull();
      expect((yield* Effect.flip(h.broker.issueHostTicket(hostInput, hostSession)))._tag).toBe(
        "PreviewMediaAccessDeniedError",
      );
      expect((yield* Queue.take(viewer.queue)).type).toBe("unavailable");
      const replacement = yield* h.startHost({ clientId: "new-host" }, otherSession);
      const newWatchId = yield* nextReady(viewer.queue);
      expect(newWatchId).not.toBe(watchId);
      const fresh = yield* h.relay.redeemTicket(
        (yield* h.broker.issueHostTicket(
          { ...target, clientId: replacement.clientId, connectionId: replacement.connectionId },
          otherSession,
        )).ticket,
      );
      expect(fresh?.isActive()).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

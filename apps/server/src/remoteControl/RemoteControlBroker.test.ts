import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  RemoteControlCapabilityDeniedError,
  RemoteControlNoHostError,
  RemoteControlSessionAccessDeniedError,
  RemoteControlSessionNotFoundError,
  type RemoteControlHost,
  type RemoteControlHostStreamEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as RemoteControlBroker from "./RemoteControlBroker.ts";

const makeBroker = RemoteControlBroker.make.pipe(Effect.provide(NodeServices.layer));

const hostSessionId = AuthSessionId.make("host-session");
const controllerSessionId = AuthSessionId.make("controller-session");
const foreignSessionId = AuthSessionId.make("foreign-session");

const host: RemoteControlHost = {
  clientId: "host-client",
  environmentId: EnvironmentId.make("environment-1"),
  platform: "windows",
  capabilities: ["screen", "keyboard"],
};
const interactiveHost: RemoteControlHost = {
  ...host,
  capabilities: ["screen", "pointer", "keyboard"],
};

const requester: RemoteControlBroker.RemoteControlRequesterContext = {
  sessionId: controllerSessionId,
  subject: "controller@example.com",
  client: {
    label: "Soloman's MacBook",
    deviceType: "desktop",
    os: "macOS",
  },
};

it.effect("requires a connected host before creating an access request", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    const error = yield* broker
      .requestAccess(
        {
          clientId: "controller-client",
          requestedCapabilities: ["screen"],
        },
        requester,
      )
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(RemoteControlNoHostError);
  }),
);

it.effect("routes approval through the host and grants only supported capabilities", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(host, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const waiting = yield* broker.requestAccess(
        {
          clientId: "controller-client",
          requestedCapabilities: ["screen", "pointer", "keyboard", "screen"],
        },
        requester,
      );
      yield* Effect.yieldNow;

      const connected = hostEvents.find((event) => event.type === "connected");
      const requested = hostEvents.find((event) => event.type === "access-requested");
      expect(connected?.type).toBe("connected");
      expect(requested?.type).toBe("access-requested");
      if (connected?.type !== "connected" || requested?.type !== "access-requested") {
        return;
      }

      const approved = yield* broker.respondToRequest(
        {
          clientId: host.clientId,
          connectionId: connected.connectionId,
          requestId: requested.requestId,
          decision: "approve",
          grantedCapabilities: ["screen", "pointer"],
        },
        hostSessionId,
      );

      expect(waiting.status).toBe("waiting-for-host-approval");
      expect(waiting.requester.deviceId).toBe(controllerSessionId);
      expect(waiting.requestedCapabilities).toEqual(["screen", "pointer", "keyboard"]);
      expect(approved.status).toBe("approved");
      expect(approved.grantedCapabilities).toEqual(["screen"]);

      const watched = yield* broker
        .watch({ sessionId: approved.sessionId }, controllerSessionId)
        .pipe(Effect.flatMap(Stream.runHead));
      expect(watched._tag).toBe("Some");
      if (watched._tag === "Some" && watched.value.type === "session-updated") {
        expect(watched.value.session.status).toBe("approved");
      }
    }),
  ),
);

it.effect("enforces controller ownership and notifies the host when a session is cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(host, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const session = yield* broker.requestAccess(
        {
          clientId: "controller-client",
          requestedCapabilities: ["screen"],
        },
        requester,
      );
      yield* Effect.yieldNow;

      const denied = yield* broker
        .cancel({ sessionId: session.sessionId }, foreignSessionId)
        .pipe(Effect.flip);
      expect(denied).toBeInstanceOf(RemoteControlSessionAccessDeniedError);

      const cancelled = yield* broker.cancel({ sessionId: session.sessionId }, controllerSessionId);
      yield* Effect.yieldNow;

      expect(cancelled.status).toBe("cancelled");
      expect(
        hostEvents.some(
          (event) =>
            event.type === "session-ended" &&
            event.session.sessionId === session.sessionId &&
            event.session.status === "cancelled",
        ),
      ).toBe(true);
    }),
  ),
);

it.effect(
  "forwards ordered pointer and keyboard input only after explicit capability approval",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const hostEvents: RemoteControlHostStreamEvent[] = [];
        const hostStream = yield* broker.connectHost(interactiveHost, hostSessionId);
        yield* Stream.runForEach(hostStream, (event) =>
          Effect.sync(() => {
            hostEvents.push(event);
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const waiting = yield* broker.requestAccess(
          {
            clientId: "controller-client",
            requestedCapabilities: ["screen", "pointer", "keyboard"],
          },
          requester,
        );
        yield* Effect.yieldNow;
        const connected = hostEvents.find((event) => event.type === "connected");
        const requested = hostEvents.find((event) => event.type === "access-requested");
        if (connected?.type !== "connected" || requested?.type !== "access-requested") return;

        const approved = yield* broker.respondToRequest(
          {
            clientId: interactiveHost.clientId,
            connectionId: connected.connectionId,
            requestId: requested.requestId,
            decision: "approve",
            grantedCapabilities: ["screen", "pointer", "keyboard"],
          },
          hostSessionId,
        );
        expect(approved.grantedCapabilities).toEqual(["screen", "pointer", "keyboard"]);

        yield* broker.sendInput(
          {
            sessionId: waiting.sessionId,
            sequence: 0,
            input: { type: "pointer", action: "move", x: 0.25, y: 0.75, button: "left" },
          },
          controllerSessionId,
        );
        // Replayed/out-of-order input is ignored rather than applied twice.
        yield* broker.sendInput(
          {
            sessionId: waiting.sessionId,
            sequence: 0,
            input: { type: "pointer", action: "move", x: 1, y: 1, button: "left" },
          },
          controllerSessionId,
        );
        yield* broker.sendInput(
          {
            sessionId: waiting.sessionId,
            sequence: 1,
            input: { type: "key", action: "down", code: "KeyA", key: "a", repeat: false },
          },
          controllerSessionId,
        );
        yield* Effect.yieldNow;

        const inputEvents = hostEvents.filter((event) => event.type === "input");
        expect(inputEvents).toHaveLength(2);
        expect(inputEvents.map((event) => event.sequence)).toEqual([0, 1]);
      }),
    ),
);

it.effect("rejects controller input that the host approved as view-only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(interactiveHost, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const waiting = yield* broker.requestAccess(
        {
          clientId: "controller-client",
          requestedCapabilities: ["screen", "pointer"],
        },
        requester,
      );
      yield* Effect.yieldNow;
      const connected = hostEvents.find((event) => event.type === "connected");
      const requested = hostEvents.find((event) => event.type === "access-requested");
      if (connected?.type !== "connected" || requested?.type !== "access-requested") return;
      yield* broker.respondToRequest(
        {
          clientId: interactiveHost.clientId,
          connectionId: connected.connectionId,
          requestId: requested.requestId,
          decision: "approve",
          grantedCapabilities: ["screen"],
        },
        hostSessionId,
      );

      const denied = yield* broker
        .sendInput(
          {
            sessionId: waiting.sessionId,
            sequence: 0,
            input: { type: "pointer", action: "down", x: 0.5, y: 0.5, button: "left" },
          },
          controllerSessionId,
        )
        .pipe(Effect.flip);
      expect(denied).toBeInstanceOf(RemoteControlCapabilityDeniedError);

      // Switching monitors is a screen concern, so this same view-only grant
      // must allow it without conferring any pointer rights.
      yield* broker.sendInput(
        {
          sessionId: waiting.sessionId,
          sequence: 1,
          input: { type: "select-display", displayId: "display-2" },
        },
        controllerSessionId,
      );
      yield* Effect.yieldNow;
      const forwarded = hostEvents.filter((event) => event.type === "input");
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({
        input: { type: "select-display", displayId: "display-2" },
      });
    }),
  ),
);

it.effect("reports host input failures to the controlling client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(interactiveHost, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const waiting = yield* broker.requestAccess(
        {
          clientId: "controller-client",
          requestedCapabilities: ["screen", "pointer", "keyboard"],
        },
        requester,
      );
      yield* Effect.yieldNow;
      const connected = hostEvents.find((event) => event.type === "connected");
      const requested = hostEvents.find((event) => event.type === "access-requested");
      if (connected?.type !== "connected" || requested?.type !== "access-requested") return;

      yield* broker.respondToRequest(
        {
          clientId: interactiveHost.clientId,
          connectionId: connected.connectionId,
          requestId: requested.requestId,
          decision: "approve",
          grantedCapabilities: ["screen", "pointer", "keyboard"],
        },
        hostSessionId,
      );

      const failed = yield* broker.endByHost(
        {
          clientId: interactiveHost.clientId,
          connectionId: connected.connectionId,
          sessionId: waiting.sessionId,
          failureReason: "Windows rejected remote pointer input.",
        },
        hostSessionId,
      );

      expect(failed.status).toBe("failed");
      expect(failed.failureReason).toBe("Windows rejected remote pointer input.");
    }),
  ),
);

it.effect("streams video chunks in order and replays the init segment to late watchers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(interactiveHost, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const waiting = yield* broker.requestAccess(
        { clientId: "controller-client", requestedCapabilities: ["screen"] },
        requester,
      );
      yield* Effect.yieldNow;
      const connected = hostEvents.find((event) => event.type === "connected");
      const requested = hostEvents.find((event) => event.type === "access-requested");
      if (connected?.type !== "connected" || requested?.type !== "access-requested") return;
      yield* broker.respondToRequest(
        {
          clientId: interactiveHost.clientId,
          connectionId: connected.connectionId,
          requestId: requested.requestId,
          decision: "approve",
          grantedCapabilities: ["screen"],
        },
        hostSessionId,
      );

      const chunk = (sequence: number, isInit: boolean, data: string) => ({
        clientId: interactiveHost.clientId,
        connectionId: connected.connectionId,
        chunk: {
          sessionId: waiting.sessionId,
          sequence,
          capturedAt: "2026-01-01T00:00:00.000Z",
          mimeType: "video/webm;codecs=vp8",
          isInit,
          data,
        },
      });

      // Publish the header before anyone is watching.
      yield* broker.publishVideoChunk(chunk(0, true, "aW5pdA=="), hostSessionId);

      const events: string[] = [];
      const stream = yield* broker.watch({ sessionId: waiting.sessionId }, controllerSessionId);
      yield* Stream.runForEach(stream, (event) =>
        Effect.sync(() => {
          if (event.type === "video-chunk") events.push(event.chunk.data);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      // A controller joining now cannot decode anything without the header, so
      // the broker must replay it before any media chunk.
      expect(events).toEqual(["aW5pdA=="]);

      // Back-to-back chunks must all survive: unlike JPEG frames there is no
      // time-based drop, because a missing chunk corrupts everything after it.
      yield* broker.publishVideoChunk(chunk(1, false, "b25l"), hostSessionId);
      yield* broker.publishVideoChunk(chunk(2, false, "dHdv"), hostSessionId);
      yield* Effect.yieldNow;
      expect(events).toEqual(["aW5pdA==", "b25l", "dHdv"]);

      // Out-of-order or replayed sequences are still rejected.
      yield* broker.publishVideoChunk(chunk(1, false, "c3RhbGU="), hostSessionId);
      yield* Effect.yieldNow;
      expect(events).toEqual(["aW5pdA==", "b25l", "dHdv"]);
    }),
  ),
);

it.effect("does not commit a video sequence until bounded delivery succeeds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(interactiveHost, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const waiting = yield* broker.requestAccess(
        { clientId: "controller-client", requestedCapabilities: ["screen"] },
        requester,
      );
      yield* Effect.yieldNow;
      const connected = hostEvents.find((event) => event.type === "connected");
      const requested = hostEvents.find((event) => event.type === "access-requested");
      if (connected?.type !== "connected" || requested?.type !== "access-requested") return;
      yield* broker.respondToRequest(
        {
          clientId: interactiveHost.clientId,
          connectionId: connected.connectionId,
          requestId: requested.requestId,
          decision: "approve",
          grantedCapabilities: ["screen"],
        },
        hostSessionId,
      );

      const releaseConsumer = yield* Deferred.make<void>();
      const receivedSequences: number[] = [];
      const receivedFinal = yield* Deferred.make<void>();
      const stream = yield* broker.watch({ sessionId: waiting.sessionId }, controllerSessionId);
      yield* Stream.runForEach(stream, (event) =>
        event.type === "session-updated"
          ? Deferred.await(releaseConsumer)
          : event.type === "video-chunk"
            ? Effect.sync(() => {
                receivedSequences.push(event.chunk.sequence);
              }).pipe(
                Effect.andThen(
                  event.chunk.sequence === 8
                    ? Deferred.succeed(receivedFinal, undefined)
                    : Effect.void,
                ),
              )
            : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const chunk = (sequence: number) => ({
        clientId: interactiveHost.clientId,
        connectionId: connected.connectionId,
        chunk: {
          sessionId: waiting.sessionId,
          sequence,
          capturedAt: "2026-01-01T00:00:00.000Z",
          mimeType: "video/webm;codecs=vp8",
          isInit: sequence === 0,
          data: `Y2h1bmst${sequence}`,
        },
      });

      // The controller subscription exists but its consumer is deliberately
      // stalled, so eight chunks fill the broker's bounded media queue.
      for (let sequence = 0; sequence < 8; sequence += 1) {
        yield* broker.publishVideoChunk(chunk(sequence), hostSessionId);
      }

      // The next delivery must wait without claiming its sequence. Interrupting
      // it simulates a disconnected host request while backpressure is active.
      const blocked = yield* broker
        .publishVideoChunk(chunk(8), hostSessionId)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(blocked.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(blocked);

      // Once the controller catches up, retrying the exact same sequence must
      // succeed. Committing before the bounded publish would drop it as stale.
      yield* Deferred.succeed(releaseConsumer, undefined);
      yield* Effect.yieldNow;
      yield* broker.publishVideoChunk(chunk(8), hostSessionId);
      yield* Deferred.await(receivedFinal);
      expect(receivedSequences).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }),
  ),
);

it.effect("prunes expired terminal sessions and their retained media state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(host, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const session = yield* broker.requestAccess(
        { clientId: "controller-client", requestedCapabilities: ["screen"] },
        requester,
      );
      yield* Effect.yieldNow;
      const connected = hostEvents.find((event) => event.type === "connected");
      const requested = hostEvents.find(
        (event) =>
          event.type === "access-requested" && event.session.sessionId === session.sessionId,
      );
      if (connected?.type !== "connected" || requested?.type !== "access-requested") return;

      yield* broker.respondToRequest(
        {
          clientId: host.clientId,
          connectionId: connected.connectionId,
          requestId: requested.requestId,
          decision: "decline",
        },
        hostSessionId,
      );
      yield* TestClock.adjust("10 minutes");

      // Any later lifecycle operation performs the bounded retention sweep.
      yield* broker.requestAccess(
        { clientId: "second-controller", requestedCapabilities: ["screen"] },
        requester,
      );
      const error = yield* broker
        .watch({ sessionId: session.sessionId }, controllerSessionId)
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(RemoteControlSessionNotFoundError);
    }),
  ),
);

it.effect("reports pointer-lock transitions to the controller without repeating them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(interactiveHost, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const waiting = yield* broker.requestAccess(
        { clientId: "controller-client", requestedCapabilities: ["screen"] },
        requester,
      );
      yield* Effect.yieldNow;
      const connected = hostEvents.find((event) => event.type === "connected");
      const requested = hostEvents.find((event) => event.type === "access-requested");
      if (connected?.type !== "connected" || requested?.type !== "access-requested") return;
      yield* broker.respondToRequest(
        {
          clientId: interactiveHost.clientId,
          connectionId: connected.connectionId,
          requestId: requested.requestId,
          decision: "approve",
          grantedCapabilities: ["screen"],
        },
        hostSessionId,
      );

      const locks: boolean[] = [];
      const stream = yield* broker.watch({ sessionId: waiting.sessionId }, controllerSessionId);
      yield* Stream.runForEach(stream, (event) =>
        Effect.sync(() => {
          if (event.type === "pointer-lock-changed") locks.push(event.locked);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const chunkAt = (sequence: number, pointerLocked?: boolean) => ({
        clientId: interactiveHost.clientId,
        connectionId: connected.connectionId,
        ...(pointerLocked === undefined ? {} : { pointerLocked }),
        chunk: {
          sessionId: waiting.sessionId,
          sequence,
          capturedAt: "2026-01-01T00:00:00.000Z",
          mimeType: "video/webm;codecs=vp8",
          isInit: sequence === 0,
          data: "aW5pdA==",
        },
      });

      // A host that never reports says nothing about lock state; treating that
      // as "unlocked" would fight an older host.
      yield* broker.publishVideoChunk(chunkAt(0), hostSessionId);
      yield* Effect.yieldNow;
      expect(locks).toEqual([]);

      // The transition is what the controller needs.
      yield* broker.publishVideoChunk(chunkAt(1, true), hostSessionId);
      yield* Effect.yieldNow;
      expect(locks).toEqual([true]);

      // The host stamps every chunk, tens per second. Only edges may escape, or
      // the bounded changes buffer would evict real session updates.
      yield* broker.publishVideoChunk(chunkAt(2, true), hostSessionId);
      yield* broker.publishVideoChunk(chunkAt(3, true), hostSessionId);
      yield* Effect.yieldNow;
      expect(locks).toEqual([true]);

      yield* broker.publishVideoChunk(chunkAt(4, false), hostSessionId);
      yield* Effect.yieldNow;
      expect(locks).toEqual([true, false]);
    }),
  ),
);

/**
 * The watch stream concatenates a preamble ahead of three merged
 * subscriptions, so a freshly published change takes more than one scheduler
 * turn to surface. Yielding a few times is what makes the assertion about
 * delivery rather than about timing.
 */
const drainWatch = Effect.gen(function* () {
  for (let turn = 0; turn < 4; turn += 1) yield* Effect.yieldNow;
});

it.effect("relays a transient host condition without ending the session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // The UAC case: while a Windows security prompt is up the host cannot
      // capture or inject anything, and it used to report that by ending the
      // stream. It must now be a notice the controller can render over a live,
      // still-approved session.
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(interactiveHost, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const waiting = yield* broker.requestAccess(
        {
          clientId: "controller-client",
          requestedCapabilities: ["screen", "pointer", "keyboard"],
        },
        requester,
      );
      yield* Effect.yieldNow;
      const connected = hostEvents.find((event) => event.type === "connected");
      const requested = hostEvents.find((event) => event.type === "access-requested");
      if (connected?.type !== "connected" || requested?.type !== "access-requested") return;

      yield* broker.respondToRequest(
        {
          clientId: interactiveHost.clientId,
          connectionId: connected.connectionId,
          requestId: requested.requestId,
          decision: "approve",
          grantedCapabilities: ["screen", "pointer", "keyboard"],
        },
        hostSessionId,
      );

      const watched: Array<{ readonly type: string }> = [];
      const watchStream = yield* broker.watch(
        { sessionId: waiting.sessionId },
        controllerSessionId,
      );
      yield* Stream.runForEach(watchStream, (event) =>
        Effect.sync(() => {
          watched.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const report = (state: "ok" | "interrupted", reason?: "secure-desktop") =>
        broker.reportHostStatus(
          {
            clientId: interactiveHost.clientId,
            connectionId: connected.connectionId,
            sessionId: waiting.sessionId,
            status: { state, ...(reason ? { reason } : {}) },
          },
          hostSessionId,
        );

      yield* report("interrupted", "secure-desktop");
      // A held prompt makes the host re-report on every dropped event; only the
      // edges may reach the controller or the change feed fills with duplicates.
      yield* report("interrupted", "secure-desktop");
      yield* report("interrupted", "secure-desktop");
      yield* drainWatch;

      const interrupted = watched.filter((event) => event.type === "host-status");
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({
        status: { state: "interrupted", reason: "secure-desktop" },
      });

      yield* report("ok");
      yield* drainWatch;
      const statuses = watched.filter((event) => event.type === "host-status");
      expect(statuses).toHaveLength(2);
      expect(statuses[1]).toMatchObject({ status: { state: "ok" } });

      // The session itself was never touched.
      const sessionUpdates = watched.filter((event) => event.type === "session-updated");
      for (const update of sessionUpdates) {
        expect(update).toMatchObject({ session: { status: "approved" } });
      }
    }),
  ),
);

it.effect("refuses a host status report from a session that does not own the host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(interactiveHost, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const waiting = yield* broker.requestAccess(
        {
          clientId: "controller-client",
          requestedCapabilities: ["screen"],
        },
        requester,
      );
      yield* Effect.yieldNow;
      const connected = hostEvents.find((event) => event.type === "connected");
      if (connected?.type !== "connected") return;

      const error = yield* broker
        .reportHostStatus(
          {
            clientId: interactiveHost.clientId,
            connectionId: connected.connectionId,
            sessionId: waiting.sessionId,
            status: { state: "interrupted", reason: "secure-desktop" },
          },
          foreignSessionId,
        )
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(RemoteControlSessionAccessDeniedError);
    }),
  ),
);

it.effect("ignores a status report for a session it no longer knows about", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // A report racing session teardown is normal. Failing it would turn a
      // best-effort notice into an error the host has to handle mid-shutdown.
      const broker = yield* makeBroker;
      const hostEvents: RemoteControlHostStreamEvent[] = [];
      const hostStream = yield* broker.connectHost(interactiveHost, hostSessionId);
      yield* Stream.runForEach(hostStream, (event) =>
        Effect.sync(() => {
          hostEvents.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const connected = hostEvents.find((event) => event.type === "connected");
      if (connected?.type !== "connected") return;

      yield* broker.reportHostStatus(
        {
          clientId: interactiveHost.clientId,
          connectionId: connected.connectionId,
          sessionId: "session-that-never-existed",
          status: { state: "interrupted", reason: "secure-desktop" },
        },
        hostSessionId,
      );
    }),
  ),
);

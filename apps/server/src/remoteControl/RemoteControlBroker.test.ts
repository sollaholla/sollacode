import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  RemoteControlCapabilityDeniedError,
  RemoteControlNoHostError,
  RemoteControlSessionAccessDeniedError,
  type RemoteControlHost,
  type RemoteControlHostStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

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

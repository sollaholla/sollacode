import {
  RemoteControlCapabilityDeniedError,
  RemoteControlInvalidTransitionError,
  RemoteControlNoHostError,
  RemoteControlRequestNotFoundError,
  RemoteControlSessionAccessDeniedError,
  RemoteControlSessionNotFoundError,
  type AuthClientMetadata,
  type AuthSessionId,
  type RemoteControlCancelInput,
  type RemoteControlCapability,
  type RemoteControlControllerStreamEvent,
  type RemoteControlHost,
  type RemoteControlHostEndInput,
  type RemoteControlHostPublishFrameInput,
  type RemoteControlHostRespondInput,
  type RemoteControlHostStreamEvent,
  type RemoteControlRequestAccessInput,
  type RemoteControlSendInputInput,
  type RemoteControlSession,
  type RemoteControlSessionId,
  type RemoteControlWatchInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

interface RemoteControlHostConnection {
  readonly host: RemoteControlHost;
  readonly sessionId: AuthSessionId;
  readonly connectionId: string;
  readonly queue: Queue.Queue<RemoteControlHostStreamEvent>;
}

interface RemoteControlSessionRecord {
  readonly session: RemoteControlSession;
  readonly controllerSessionId: AuthSessionId;
  readonly hostConnectionId: string;
  readonly hostQueue: RemoteControlHostConnection["queue"];
  readonly requestId: string;
  readonly changes: PubSub.PubSub<RemoteControlControllerStreamEvent>;
  readonly frames: PubSub.PubSub<RemoteControlControllerStreamEvent>;
  readonly lastFrameSequence: number;
  readonly lastFramePublishedAt: number;
  readonly lastInputSequence: number;
}

interface RemoteControlBrokerState {
  readonly host: RemoteControlHostConnection | null;
  readonly sessions: ReadonlyMap<string, RemoteControlSessionRecord>;
}

type RemoteControlHostResponseResult =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Denied"; readonly sessionId: RemoteControlSessionId }
  | { readonly _tag: "Invalid"; readonly session: RemoteControlSession }
  | { readonly _tag: "Updated"; readonly record: RemoteControlSessionRecord };

type RemoteControlCancelResult =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Denied" }
  | { readonly _tag: "Invalid"; readonly session: RemoteControlSession }
  | { readonly _tag: "Updated"; readonly record: RemoteControlSessionRecord };

type RemoteControlFramePublishResult =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Denied" }
  | { readonly _tag: "Invalid"; readonly session: RemoteControlSession }
  | { readonly _tag: "Dropped" }
  | { readonly _tag: "Published"; readonly record: RemoteControlSessionRecord };

type RemoteControlInputResult =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Denied" }
  | { readonly _tag: "Invalid"; readonly session: RemoteControlSession }
  | {
      readonly _tag: "CapabilityDenied";
      readonly session: RemoteControlSession;
      readonly requiredCapability: RemoteControlCapability;
    }
  | { readonly _tag: "Dropped" }
  | { readonly _tag: "Forward"; readonly record: RemoteControlSessionRecord };

export interface RemoteControlRequesterContext {
  readonly sessionId: AuthSessionId;
  readonly client: AuthClientMetadata;
  readonly subject: string;
}

type RemoteControlBrokerError =
  | RemoteControlNoHostError
  | RemoteControlRequestNotFoundError
  | RemoteControlSessionNotFoundError
  | RemoteControlSessionAccessDeniedError
  | RemoteControlInvalidTransitionError
  | RemoteControlCapabilityDeniedError;

export class RemoteControlBroker extends Context.Service<
  RemoteControlBroker,
  {
    readonly connectHost: (
      host: RemoteControlHost,
      hostSessionId: AuthSessionId,
    ) => Effect.Effect<Stream.Stream<RemoteControlHostStreamEvent>>;
    readonly requestAccess: (
      input: RemoteControlRequestAccessInput,
      requester: RemoteControlRequesterContext,
    ) => Effect.Effect<RemoteControlSession, RemoteControlNoHostError>;
    readonly respondToRequest: (
      input: RemoteControlHostRespondInput,
      hostSessionId: AuthSessionId,
    ) => Effect.Effect<RemoteControlSession, RemoteControlBrokerError>;
    readonly publishFrame: (
      input: RemoteControlHostPublishFrameInput,
      hostSessionId: AuthSessionId,
    ) => Effect.Effect<void, RemoteControlBrokerError>;
    readonly endByHost: (
      input: RemoteControlHostEndInput,
      hostSessionId: AuthSessionId,
    ) => Effect.Effect<RemoteControlSession, RemoteControlBrokerError>;
    readonly watch: (
      input: RemoteControlWatchInput,
      controllerSessionId: AuthSessionId,
    ) => Effect.Effect<Stream.Stream<RemoteControlControllerStreamEvent>, RemoteControlBrokerError>;
    readonly sendInput: (
      input: RemoteControlSendInputInput,
      controllerSessionId: AuthSessionId,
    ) => Effect.Effect<void, RemoteControlBrokerError>;
    readonly cancel: (
      input: RemoteControlCancelInput,
      controllerSessionId: AuthSessionId,
    ) => Effect.Effect<RemoteControlSession, RemoteControlBrokerError>;
  }
>()("t3/remoteControl/RemoteControlBroker") {}

function isTerminalStatus(status: RemoteControlSession["status"]): boolean {
  return (
    status === "declined" || status === "cancelled" || status === "ended" || status === "failed"
  );
}

function requesterLabel(requester: RemoteControlRequesterContext): string {
  return requester.client.label?.trim() || requester.subject.trim() || "Connected device";
}

function intersectCapabilities(
  requested: ReadonlyArray<RemoteControlCapability>,
  supported: ReadonlyArray<RemoteControlCapability>,
  granted: ReadonlyArray<RemoteControlCapability> | undefined,
): RemoteControlCapability[] {
  const supportedSet = new Set(supported);
  const grantedSet = granted ? new Set(granted) : null;
  return [...new Set(requested)].filter(
    (capability) => supportedSet.has(capability) && (!grantedSet || grantedSet.has(capability)),
  );
}

export const make = Effect.gen(function* RemoteControlBrokerMake() {
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<RemoteControlBrokerState>({
    host: null,
    sessions: new Map(),
  });

  const publishSession = Effect.fn("RemoteControlBroker.publishSession")(function* (
    record: RemoteControlSessionRecord,
  ) {
    const event: RemoteControlControllerStreamEvent = {
      type: "session-updated",
      session: record.session,
    };
    yield* PubSub.publish(record.changes, event);
  });

  const disconnectHost = Effect.fn("RemoteControlBroker.disconnectHost")(function* (
    connection: RemoteControlHostConnection,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const changed = yield* SynchronizedRef.modify(
      state,
      (current): readonly [ReadonlyArray<RemoteControlSessionRecord>, RemoteControlBrokerState] => {
        if (
          current.host?.connectionId !== connection.connectionId ||
          current.host.queue !== connection.queue
        ) {
          return [[], current];
        }
        const sessions = new Map(current.sessions);
        const updates: RemoteControlSessionRecord[] = [];
        for (const [sessionId, record] of sessions) {
          if (
            record.hostConnectionId !== connection.connectionId ||
            isTerminalStatus(record.session.status)
          ) {
            continue;
          }
          const updated: RemoteControlSessionRecord = {
            ...record,
            session: {
              ...record.session,
              status: record.session.status === "approved" ? "ended" : "failed",
              updatedAt: now,
              ...(record.session.status === "approved"
                ? {}
                : { failureReason: "The remote-control host disconnected." }),
            },
          };
          sessions.set(sessionId, updated);
          updates.push(updated);
        }
        return [updates, { host: null, sessions }];
      },
    );
    yield* Effect.forEach(changed, publishSession, { discard: true });
    yield* Queue.shutdown(connection.queue);
  });

  const acquireHost = Effect.fn("RemoteControlBroker.acquireHost")(function* (
    host: RemoteControlHost,
    hostSessionId: AuthSessionId,
  ) {
    const queue = yield* Queue.unbounded<RemoteControlHostStreamEvent>();
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const connection: RemoteControlHostConnection = {
      host,
      sessionId: hostSessionId,
      connectionId,
      queue,
    };
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const replacementTime = DateTime.formatIso(yield* DateTime.now);
    const registration = yield* SynchronizedRef.modify(state, (current) => {
      const previous = current.host;
      const sessions = new Map(current.sessions);
      const updates: RemoteControlSessionRecord[] = [];
      if (previous) {
        for (const [sessionId, record] of sessions) {
          if (
            record.hostConnectionId !== previous.connectionId ||
            isTerminalStatus(record.session.status)
          ) {
            continue;
          }
          const updated: RemoteControlSessionRecord = {
            ...record,
            session: {
              ...record.session,
              status: record.session.status === "approved" ? "ended" : "failed",
              updatedAt: replacementTime,
              ...(record.session.status === "approved"
                ? {}
                : { failureReason: "The remote-control host was replaced." }),
            },
          };
          sessions.set(sessionId, updated);
          updates.push(updated);
        }
      }
      return [
        { previous, updates },
        { host: connection, sessions },
      ] as const;
    });
    yield* Effect.forEach(registration.updates, publishSession, { discard: true });
    if (registration.previous) {
      yield* Queue.shutdown(registration.previous.queue);
    }
    return connection;
  });

  const connectHost: RemoteControlBroker["Service"]["connectHost"] = Effect.fn(
    "RemoteControlBroker.connectHost",
  )((host, hostSessionId) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireHost(host, hostSessionId), disconnectHost).pipe(
          Effect.map((connection) => Stream.fromQueue(connection.queue)),
        ),
      ),
    ),
  );

  const requestAccess: RemoteControlBroker["Service"]["requestAccess"] = Effect.fn(
    "RemoteControlBroker.requestAccess",
  )(function* (input, requester) {
    const host = (yield* SynchronizedRef.get(state)).host;
    if (!host) return yield* new RemoteControlNoHostError();

    const now = DateTime.formatIso(yield* DateTime.now);
    const sessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const changes = yield* PubSub.sliding<RemoteControlControllerStreamEvent>(16);
    const frames = yield* PubSub.sliding<RemoteControlControllerStreamEvent>(2);
    const session: RemoteControlSession = {
      sessionId,
      status: "waiting-for-host-approval",
      requester: {
        deviceId: requester.sessionId,
        label: requesterLabel(requester),
        deviceType: requester.client.deviceType,
        ...(requester.client.os ? { os: requester.client.os } : {}),
      },
      requestedCapabilities: [...new Set(input.requestedCapabilities)],
      grantedCapabilities: [],
      createdAt: now,
      updatedAt: now,
    };
    const record: RemoteControlSessionRecord = {
      session,
      controllerSessionId: requester.sessionId,
      hostConnectionId: host.connectionId,
      hostQueue: host.queue,
      requestId,
      changes,
      frames,
      lastFrameSequence: -1,
      lastFramePublishedAt: 0,
      lastInputSequence: -1,
    };
    const registered = yield* SynchronizedRef.modify(state, (current) => {
      if (current.host?.connectionId !== host.connectionId || current.host.queue !== host.queue) {
        return [false, current] as const;
      }
      const sessions = new Map(current.sessions);
      sessions.set(sessionId, record);
      return [true, { ...current, sessions }] as const;
    });
    if (!registered) return yield* new RemoteControlNoHostError();

    const offered = yield* Queue.offer(host.queue, {
      type: "access-requested",
      connectionId: host.connectionId,
      requestId,
      session,
    });
    if (!offered) {
      yield* disconnectHost(host);
      return yield* new RemoteControlNoHostError();
    }
    return session;
  });

  const respondToRequest: RemoteControlBroker["Service"]["respondToRequest"] = Effect.fn(
    "RemoteControlBroker.respondToRequest",
  )(function* (input, hostSessionId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const result = yield* SynchronizedRef.modify(
      state,
      (current): readonly [RemoteControlHostResponseResult, RemoteControlBrokerState] => {
        const host = current.host;
        const record = [...current.sessions.values()].find(
          (candidate) => candidate.requestId === input.requestId,
        );
        if (!record) return [{ _tag: "NotFound" }, current];
        if (
          !host ||
          host.sessionId !== hostSessionId ||
          host.host.clientId !== input.clientId ||
          host.connectionId !== input.connectionId ||
          record.hostConnectionId !== input.connectionId
        ) {
          return [{ _tag: "Denied", sessionId: record.session.sessionId }, current];
        }
        if (record.session.status !== "waiting-for-host-approval") {
          return [{ _tag: "Invalid", session: record.session }, current];
        }
        const grantedCapabilities =
          input.decision === "approve"
            ? intersectCapabilities(
                record.session.requestedCapabilities,
                host.host.capabilities,
                input.grantedCapabilities,
              )
            : [];
        const updatedSession: RemoteControlSession = {
          ...record.session,
          status: input.decision === "approve" ? "approved" : "declined",
          grantedCapabilities,
          updatedAt: now,
        };
        const updatedRecord = { ...record, session: updatedSession };
        const sessions = new Map(current.sessions);
        sessions.set(updatedSession.sessionId, updatedRecord);
        return [
          { _tag: "Updated", record: updatedRecord },
          { ...current, sessions },
        ];
      },
    );
    switch (result._tag) {
      case "NotFound":
        return yield* new RemoteControlRequestNotFoundError({
          requestId: input.requestId,
        });
      case "Denied":
        return yield* new RemoteControlSessionAccessDeniedError({
          sessionId: result.sessionId,
        });
      case "Invalid":
        return yield* new RemoteControlInvalidTransitionError({
          sessionId: result.session.sessionId,
          status: result.session.status,
        });
      case "Updated":
        yield* publishSession(result.record);
        return result.record.session;
    }
  });

  const publishFrame: RemoteControlBroker["Service"]["publishFrame"] = Effect.fn(
    "RemoteControlBroker.publishFrame",
  )(function* (input, hostSessionId) {
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const result = yield* SynchronizedRef.modify(
      state,
      (current): readonly [RemoteControlFramePublishResult, RemoteControlBrokerState] => {
        const host = current.host;
        const record = current.sessions.get(input.frame.sessionId);
        if (!record) return [{ _tag: "NotFound" }, current];
        if (
          !host ||
          host.sessionId !== hostSessionId ||
          host.host.clientId !== input.clientId ||
          host.connectionId !== input.connectionId ||
          record.hostConnectionId !== input.connectionId
        ) {
          return [{ _tag: "Denied" }, current];
        }
        if (
          record.session.status !== "approved" ||
          !record.session.grantedCapabilities.includes("screen")
        ) {
          return [{ _tag: "Invalid", session: record.session }, current];
        }
        if (
          input.frame.sequence <= record.lastFrameSequence ||
          now - record.lastFramePublishedAt < 65
        ) {
          return [{ _tag: "Dropped" }, current];
        }
        const updatedRecord: RemoteControlSessionRecord = {
          ...record,
          lastFrameSequence: input.frame.sequence,
          lastFramePublishedAt: now,
        };
        const sessions = new Map(current.sessions);
        sessions.set(input.frame.sessionId, updatedRecord);
        return [
          { _tag: "Published", record: updatedRecord },
          { ...current, sessions },
        ];
      },
    );
    switch (result._tag) {
      case "NotFound":
        return yield* new RemoteControlSessionNotFoundError({
          sessionId: input.frame.sessionId,
        });
      case "Denied":
        return yield* new RemoteControlSessionAccessDeniedError({
          sessionId: input.frame.sessionId,
        });
      case "Invalid":
        return yield* new RemoteControlInvalidTransitionError({
          sessionId: input.frame.sessionId,
          status: result.session.status,
        });
      case "Dropped":
        return;
      case "Published":
        yield* PubSub.publish(result.record.frames, {
          type: "frame",
          frame: input.frame,
        });
        return;
    }
  });

  const endByHost: RemoteControlBroker["Service"]["endByHost"] = Effect.fn(
    "RemoteControlBroker.endByHost",
  )(function* (input, hostSessionId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const result = yield* SynchronizedRef.modify(
      state,
      (current): readonly [RemoteControlCancelResult, RemoteControlBrokerState] => {
        const host = current.host;
        const record = current.sessions.get(input.sessionId);
        if (!record) return [{ _tag: "NotFound" }, current];
        if (
          !host ||
          host.sessionId !== hostSessionId ||
          host.host.clientId !== input.clientId ||
          host.connectionId !== input.connectionId ||
          record.hostConnectionId !== input.connectionId
        ) {
          return [{ _tag: "Denied" }, current];
        }
        if (isTerminalStatus(record.session.status)) {
          return [{ _tag: "Invalid", session: record.session }, current];
        }
        const updatedRecord: RemoteControlSessionRecord = {
          ...record,
          session: {
            ...record.session,
            status: input.failureReason ? "failed" : "ended",
            updatedAt: now,
            ...(input.failureReason ? { failureReason: input.failureReason } : {}),
          },
        };
        const sessions = new Map(current.sessions);
        sessions.set(input.sessionId, updatedRecord);
        return [
          { _tag: "Updated", record: updatedRecord },
          { ...current, sessions },
        ];
      },
    );
    switch (result._tag) {
      case "NotFound":
        return yield* new RemoteControlSessionNotFoundError({
          sessionId: input.sessionId,
        });
      case "Denied":
        return yield* new RemoteControlSessionAccessDeniedError({
          sessionId: input.sessionId,
        });
      case "Invalid":
        return yield* new RemoteControlInvalidTransitionError({
          sessionId: input.sessionId,
          status: result.session.status,
        });
      case "Updated":
        yield* publishSession(result.record);
        yield* Queue.offer(result.record.hostQueue, {
          type: "session-ended",
          connectionId: result.record.hostConnectionId,
          session: result.record.session,
        });
        return result.record.session;
    }
  });

  const sendInput: RemoteControlBroker["Service"]["sendInput"] = Effect.fn(
    "RemoteControlBroker.sendInput",
  )(function* (input, controllerSessionId) {
    const requiredCapability: RemoteControlCapability =
      input.input.type === "key" ? "keyboard" : "pointer";
    const result = yield* SynchronizedRef.modify(
      state,
      (current): readonly [RemoteControlInputResult, RemoteControlBrokerState] => {
        const record = current.sessions.get(input.sessionId);
        if (!record) return [{ _tag: "NotFound" }, current];
        if (record.controllerSessionId !== controllerSessionId) {
          return [{ _tag: "Denied" }, current];
        }
        if (record.session.status !== "approved") {
          return [{ _tag: "Invalid", session: record.session }, current];
        }
        if (!record.session.grantedCapabilities.includes(requiredCapability)) {
          return [
            {
              _tag: "CapabilityDenied",
              session: record.session,
              requiredCapability,
            },
            current,
          ];
        }
        if (input.sequence <= record.lastInputSequence) {
          return [{ _tag: "Dropped" }, current];
        }
        const updatedRecord = {
          ...record,
          lastInputSequence: input.sequence,
        };
        const sessions = new Map(current.sessions);
        sessions.set(input.sessionId, updatedRecord);
        return [
          { _tag: "Forward", record: updatedRecord },
          { ...current, sessions },
        ];
      },
    );
    switch (result._tag) {
      case "NotFound":
        return yield* new RemoteControlSessionNotFoundError({
          sessionId: input.sessionId,
        });
      case "Denied":
        return yield* new RemoteControlSessionAccessDeniedError({
          sessionId: input.sessionId,
        });
      case "Invalid":
        return yield* new RemoteControlInvalidTransitionError({
          sessionId: input.sessionId,
          status: result.session.status,
        });
      case "CapabilityDenied":
        return yield* new RemoteControlCapabilityDeniedError({
          sessionId: input.sessionId,
          requiredCapability: result.requiredCapability,
        });
      case "Dropped":
        return;
      case "Forward": {
        const offered = yield* Queue.offer(result.record.hostQueue, {
          type: "input",
          connectionId: result.record.hostConnectionId,
          sessionId: input.sessionId,
          sequence: input.sequence,
          input: input.input,
        });
        if (!offered) return yield* new RemoteControlNoHostError();
        return;
      }
    }
  });

  const watch: RemoteControlBroker["Service"]["watch"] = Effect.fn("RemoteControlBroker.watch")(
    (input, controllerSessionId) =>
      Effect.gen(function* () {
        const initialRecord = (yield* SynchronizedRef.get(state)).sessions.get(input.sessionId);
        if (!initialRecord) {
          return yield* new RemoteControlSessionNotFoundError({
            sessionId: input.sessionId,
          });
        }
        if (initialRecord.controllerSessionId !== controllerSessionId) {
          return yield* new RemoteControlSessionAccessDeniedError({
            sessionId: input.sessionId,
          });
        }
        return Stream.unwrap(
          Effect.gen(function* () {
            const changes = yield* PubSub.subscribe(initialRecord.changes);
            const frames = yield* PubSub.subscribe(initialRecord.frames);
            return Stream.concat(
              Stream.make({
                type: "session-updated" as const,
                session: initialRecord.session,
              }),
              Stream.merge(Stream.fromSubscription(changes), Stream.fromSubscription(frames)),
            );
          }),
        );
      }),
  );

  const cancel: RemoteControlBroker["Service"]["cancel"] = Effect.fn("RemoteControlBroker.cancel")(
    function* (input, controllerSessionId) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const result = yield* SynchronizedRef.modify(
        state,
        (current): readonly [RemoteControlCancelResult, RemoteControlBrokerState] => {
          const record = current.sessions.get(input.sessionId);
          if (!record) return [{ _tag: "NotFound" }, current];
          if (record.controllerSessionId !== controllerSessionId) {
            return [{ _tag: "Denied" }, current];
          }
          if (isTerminalStatus(record.session.status)) {
            return [{ _tag: "Invalid", session: record.session }, current];
          }
          const updatedRecord: RemoteControlSessionRecord = {
            ...record,
            session: {
              ...record.session,
              status: "cancelled",
              updatedAt: now,
            },
          };
          const sessions = new Map(current.sessions);
          sessions.set(input.sessionId, updatedRecord);
          return [
            { _tag: "Updated", record: updatedRecord },
            { ...current, sessions },
          ];
        },
      );
      switch (result._tag) {
        case "NotFound":
          return yield* new RemoteControlSessionNotFoundError({
            sessionId: input.sessionId,
          });
        case "Denied":
          return yield* new RemoteControlSessionAccessDeniedError({
            sessionId: input.sessionId,
          });
        case "Invalid":
          return yield* new RemoteControlInvalidTransitionError({
            sessionId: input.sessionId,
            status: result.session.status,
          });
        case "Updated":
          yield* publishSession(result.record);
          yield* Queue.offer(result.record.hostQueue, {
            type: "session-ended",
            connectionId: result.record.hostConnectionId,
            session: result.record.session,
          });
          return result.record.session;
      }
    },
  );

  return RemoteControlBroker.of({
    connectHost,
    requestAccess,
    respondToRequest,
    publishFrame,
    endByHost,
    watch,
    sendInput,
    cancel,
  });
}).pipe(Effect.withSpan("RemoteControlBroker.make"));

export const layer = Layer.effect(RemoteControlBroker, make);

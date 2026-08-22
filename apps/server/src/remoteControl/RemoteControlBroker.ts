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
  type RemoteControlHostReportStatusInput,
  type RemoteControlHostPublishVideoChunkInput,
  type RemoteControlVideoChunk,
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
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

interface RemoteControlHostConnection {
  readonly host: RemoteControlHost;
  readonly sessionId: AuthSessionId;
  readonly connectionId: string;
  readonly queue: Queue.Queue<RemoteControlHostStreamEvent>;
  readonly deliveryLock: Semaphore.Semaphore;
}

interface RemoteControlSessionRecord {
  readonly session: RemoteControlSession;
  readonly controllerSessionId: AuthSessionId;
  readonly hostConnectionId: string;
  readonly hostQueue: RemoteControlHostConnection["queue"];
  readonly requestId: string;
  readonly changes: PubSub.PubSub<RemoteControlControllerStreamEvent>;
  readonly frames: PubSub.PubSub<RemoteControlControllerStreamEvent>;
  readonly videoChunks: PubSub.PubSub<RemoteControlControllerStreamEvent>;
  readonly deliveryLock: Semaphore.Semaphore;
  readonly lastFrameSequence: number;
  readonly lastFramePublishedAt: number;
  readonly lastInputSequence: number;
  readonly lastChunkSequence: number;
  // Retained so a controller that subscribes mid-stream can be handed the
  // container header it needs before any media chunk makes sense.
  readonly videoInitChunk: RemoteControlVideoChunk | null;
}

const REMOTE_CONTROL_HOST_QUEUE_CAPACITY = 256;
// Each chunk is schema-capped at 4,000,000 base64 characters, so this bounds
// an individual controller's queued video payload to roughly 32 MB while
// preserving the continuous stream through producer backpressure.
const REMOTE_CONTROL_VIDEO_CHUNK_CAPACITY = 8;
const REMOTE_CONTROL_MAX_RETAINED_TERMINAL_SESSIONS = 128;
const REMOTE_CONTROL_TERMINAL_RETENTION_MS = 10 * 60 * 1_000;

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
    readonly publishVideoChunk: (
      input: RemoteControlHostPublishVideoChunkInput,
      hostSessionId: AuthSessionId,
    ) => Effect.Effect<void, RemoteControlBrokerError>;
    readonly reportHostStatus: (
      input: RemoteControlHostReportStatusInput,
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

  /**
   * Last pointer-lock state broadcast per session.
   *
   * The host stamps its current state on every frame it publishes, which is
   * tens of times a second. Only the transitions are interesting to the
   * controller, so this collapses that stream into edges — otherwise the
   * changes PubSub would carry a redundant event per frame and evict real
   * session updates out of its bounded buffer.
   */
  const pointerLockBySession = yield* Ref.make(new Map<string, boolean>());

  /**
   * Last host-status signature broadcast per session, for the same reason: the
   * host re-reports on every failed input, and only the edges are interesting.
   */
  const hostStatusBySession = yield* Ref.make(new Map<string, string>());

  /** Last cursor shape broadcast per session — same edge collapsing again. */
  const cursorShapeBySession = yield* Ref.make(new Map<string, string>());

  const publishCursorShapeIfChanged = Effect.fn("RemoteControlBroker.publishCursorShape")(
    function* (record: RemoteControlSessionRecord, shape: string | undefined) {
      // Absence means the host predates the field, not "shape unknown now".
      if (shape === undefined) return;
      const sessionId = String(record.session.sessionId);
      const seen = yield* Ref.get(cursorShapeBySession);
      if (seen.get(sessionId) === shape) return;
      yield* Ref.update(cursorShapeBySession, (current) => {
        const next = new Map(current);
        next.set(sessionId, shape);
        return next;
      });
      yield* PubSub.publish(record.changes, { type: "cursor-changed", shape });
    },
  );

  const publishPointerLockIfChanged = Effect.fn("RemoteControlBroker.publishPointerLock")(
    function* (record: RemoteControlSessionRecord, locked: boolean | undefined) {
      // A host that never reports says nothing about lock state, as opposed to
      // reporting "unlocked"; treating absence as false would fight a host that
      // is simply older than this field.
      if (locked === undefined) return;
      const sessionId = String(record.session.sessionId);
      const seen = yield* Ref.get(pointerLockBySession);
      if (seen.get(sessionId) === locked) return;
      yield* Ref.update(pointerLockBySession, (current) => {
        const next = new Map(current);
        next.set(sessionId, locked);
        return next;
      });
      yield* PubSub.publish(record.changes, { type: "pointer-lock-changed", locked });
    },
  );

  const publishSession = Effect.fn("RemoteControlBroker.publishSession")(function* (
    record: RemoteControlSessionRecord,
  ) {
    const event: RemoteControlControllerStreamEvent = {
      type: "session-updated",
      session: record.session,
    };
    yield* PubSub.publish(record.changes, event);
  });

  const pruneTerminalSessions = Effect.fn("RemoteControlBroker.pruneTerminalSessions")(
    function* () {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const removed = yield* SynchronizedRef.modify(state, (current) => {
        const terminal = [...current.sessions.values()]
          .filter((record) => isTerminalStatus(record.session.status))
          .toSorted((left, right) => left.session.updatedAt.localeCompare(right.session.updatedAt));
        const excess = Math.max(0, terminal.length - REMOTE_CONTROL_MAX_RETAINED_TERMINAL_SESSIONS);
        const expiredIds = new Set(
          terminal
            .filter((record, index) => {
              const updatedAt = Date.parse(record.session.updatedAt);
              return (
                index < excess ||
                (Number.isFinite(updatedAt) &&
                  now - updatedAt >= REMOTE_CONTROL_TERMINAL_RETENTION_MS)
              );
            })
            .map((record) => record.session.sessionId),
        );
        if (expiredIds.size === 0) return [[] as RemoteControlSessionRecord[], current] as const;
        const sessions = new Map(current.sessions);
        const removed: RemoteControlSessionRecord[] = [];
        for (const sessionId of expiredIds) {
          const record = sessions.get(sessionId);
          if (!record) continue;
          sessions.delete(sessionId);
          removed.push(record);
        }
        return [removed, { ...current, sessions }] as const;
      });
      yield* Effect.forEach(
        removed,
        (record) =>
          Effect.all([
            PubSub.shutdown(record.changes),
            PubSub.shutdown(record.frames),
            PubSub.shutdown(record.videoChunks),
          ]),
        { discard: true },
      );
    },
  );

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
            videoInitChunk: null,
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
    yield* pruneTerminalSessions();
  });

  const acquireHost = Effect.fn("RemoteControlBroker.acquireHost")(function* (
    host: RemoteControlHost,
    hostSessionId: AuthSessionId,
  ) {
    const queue = yield* Queue.bounded<RemoteControlHostStreamEvent>(
      REMOTE_CONTROL_HOST_QUEUE_CAPACITY,
    );
    const deliveryLock = yield* Semaphore.make(1);
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const connection: RemoteControlHostConnection = {
      host,
      sessionId: hostSessionId,
      connectionId,
      queue,
      deliveryLock,
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
            videoInitChunk: null,
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
    yield* pruneTerminalSessions();
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
    yield* pruneTerminalSessions();
    const host = (yield* SynchronizedRef.get(state)).host;
    if (!host) return yield* new RemoteControlNoHostError();

    const now = DateTime.formatIso(yield* DateTime.now);
    const sessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const changes = yield* PubSub.bounded<RemoteControlControllerStreamEvent>(16);
    const frames = yield* PubSub.sliding<RemoteControlControllerStreamEvent>(2);
    const videoChunks = yield* PubSub.bounded<RemoteControlControllerStreamEvent>(
      REMOTE_CONTROL_VIDEO_CHUNK_CAPACITY,
    );
    const deliveryLock = yield* Semaphore.make(1);
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
      videoChunks,
      deliveryLock,
      lastFrameSequence: -1,
      lastFramePublishedAt: 0,
      lastInputSequence: -1,
      lastChunkSequence: -1,
      videoInitChunk: null,
    };
    yield* host.deliveryLock.withPermit(
      Effect.uninterruptibleMask((restore) => {
        let delivered = false;
        const rollback = SynchronizedRef.update(state, (current) => {
          if (delivered || current.sessions.get(sessionId) !== record) return current;
          const sessions = new Map(current.sessions);
          sessions.delete(sessionId);
          return { ...current, sessions };
        });
        return Effect.gen(function* () {
          const registered = yield* SynchronizedRef.modify(state, (current) => {
            if (
              current.host?.connectionId !== host.connectionId ||
              current.host.queue !== host.queue
            ) {
              return [false, current] as const;
            }
            const sessions = new Map(current.sessions);
            sessions.set(sessionId, record);
            return [true, { ...current, sessions }] as const;
          });
          if (!registered) return yield* new RemoteControlNoHostError();

          const offered = yield* restore(
            Queue.offer(host.queue, {
              type: "access-requested",
              connectionId: host.connectionId,
              requestId,
              session,
            }),
          );
          if (!offered) return yield* new RemoteControlNoHostError();
          delivered = true;
        }).pipe(Effect.ensuring(rollback));
      }),
    );
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
        const updatedRecord = {
          ...record,
          session: updatedSession,
          ...(input.decision === "decline" ? { videoInitChunk: null } : {}),
        };
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
        if (isTerminalStatus(result.record.session.status)) {
          yield* pruneTerminalSessions();
        }
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
        // 40ms floor (~25fps): frames are independent JPEGs, so this only
        // sheds load when a host outruns its viewers. The old 65ms floor
        // capped the fallback path at ~15fps and made it feel like slideware.
        if (
          input.frame.sequence <= record.lastFrameSequence ||
          now - record.lastFramePublishedAt < 40
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
        yield* publishPointerLockIfChanged(result.record, input.pointerLocked);
        yield* publishCursorShapeIfChanged(result.record, input.cursorShape);
        return;
    }
  });

  /**
   * Deliberately has no time-based drop, unlike `publishFrame`. JPEG frames are
   * independent, so discarding one only costs an update; video chunks are a
   * continuous container, so dropping one corrupts every chunk after it. Pacing
   * is the encoder's job here — the broker only enforces ordering.
   */
  const publishVideoChunk: RemoteControlBroker["Service"]["publishVideoChunk"] = Effect.fn(
    "RemoteControlBroker.publishVideoChunk",
  )(function* (input, hostSessionId) {
    const initialRecord = (yield* SynchronizedRef.get(state)).sessions.get(input.chunk.sessionId);
    if (!initialRecord) {
      return yield* new RemoteControlSessionNotFoundError({ sessionId: input.chunk.sessionId });
    }

    return yield* initialRecord.deliveryLock.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* SynchronizedRef.modify(
            state,
            (current): readonly [RemoteControlFramePublishResult, RemoteControlBrokerState] => {
              const host = current.host;
              const record = current.sessions.get(input.chunk.sessionId);
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
              if (input.chunk.sequence <= record.lastChunkSequence) {
                return [{ _tag: "Dropped" }, current];
              }
              return [{ _tag: "Published", record }, current];
            },
          );
          switch (result._tag) {
            case "NotFound":
              return yield* new RemoteControlSessionNotFoundError({
                sessionId: input.chunk.sessionId,
              });
            case "Denied":
              return yield* new RemoteControlSessionAccessDeniedError({
                sessionId: input.chunk.sessionId,
              });
            case "Invalid":
              return yield* new RemoteControlInvalidTransitionError({
                sessionId: input.chunk.sessionId,
                status: result.session.status,
              });
            case "Dropped":
              return;
            case "Published": {
              const published = yield* restore(
                PubSub.publish(result.record.videoChunks, {
                  type: "video-chunk",
                  chunk: input.chunk,
                }),
              );
              if (!published) {
                return yield* new RemoteControlSessionNotFoundError({
                  sessionId: input.chunk.sessionId,
                });
              }
              // Video is the default transport, so this is the path that
              // actually carries lock state in a normal session.
              yield* publishPointerLockIfChanged(result.record, input.pointerLocked);
              yield* publishCursorShapeIfChanged(result.record, input.cursorShape);
              yield* SynchronizedRef.update(state, (current) => {
                const record = current.sessions.get(input.chunk.sessionId);
                if (
                  !record ||
                  record.deliveryLock !== result.record.deliveryLock ||
                  record.session.status !== "approved"
                ) {
                  return current;
                }
                const updatedRecord: RemoteControlSessionRecord = {
                  ...record,
                  lastChunkSequence: input.chunk.sequence,
                  ...(input.chunk.isInit ? { videoInitChunk: input.chunk } : {}),
                };
                const sessions = new Map(current.sessions);
                sessions.set(input.chunk.sessionId, updatedRecord);
                return { ...current, sessions };
              });
            }
          }
        }),
      ),
    );
  });

  /**
   * Relays a transient host condition to the controller without touching the
   * session's status.
   *
   * The host reports edges, but it can restart mid-outage — so this de-dupes
   * again here rather than trusting the caller, and stays silent on a repeat.
   * Deliberately tolerant of a session it no longer recognises: a status report
   * racing session teardown is normal, and failing it would only turn a
   * best-effort notice into an error the host has to handle.
   */
  const reportHostStatus: RemoteControlBroker["Service"]["reportHostStatus"] = Effect.fn(
    "RemoteControlBroker.reportHostStatus",
  )(function* (input, hostSessionId) {
    const current = yield* SynchronizedRef.get(state);
    const host = current.host;
    const record = current.sessions.get(input.sessionId);
    if (!record) return;
    if (
      !host ||
      host.sessionId !== hostSessionId ||
      host.host.clientId !== input.clientId ||
      host.connectionId !== input.connectionId ||
      record.hostConnectionId !== input.connectionId
    ) {
      return yield* new RemoteControlSessionAccessDeniedError({ sessionId: input.sessionId });
    }
    if (record.session.status !== "approved") return;

    const sessionId = String(input.sessionId);
    const signature = `${input.status.state}:${input.status.reason ?? ""}`;
    const seen = yield* Ref.get(hostStatusBySession);
    if (seen.get(sessionId) === signature) return;
    yield* Ref.update(hostStatusBySession, (existing) => {
      const next = new Map(existing);
      next.set(sessionId, signature);
      return next;
    });
    yield* PubSub.publish(record.changes, { type: "host-status", status: input.status });
  });

  const endByHostUnlocked: RemoteControlBroker["Service"]["endByHost"] = Effect.fn(
    "RemoteControlBroker.endByHostUnlocked",
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
          videoInitChunk: null,
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
        yield* pruneTerminalSessions();
        return result.record.session;
    }
  });

  const endByHost: RemoteControlBroker["Service"]["endByHost"] = (input, hostSessionId) =>
    Effect.gen(function* () {
      const record = (yield* SynchronizedRef.get(state)).sessions.get(input.sessionId);
      if (!record) {
        return yield* new RemoteControlSessionNotFoundError({ sessionId: input.sessionId });
      }
      return yield* record.deliveryLock.withPermit(endByHostUnlocked(input, hostSessionId));
    });

  const sendInput: RemoteControlBroker["Service"]["sendInput"] = Effect.fn(
    "RemoteControlBroker.sendInput",
  )(function* (input, controllerSessionId) {
    // Retargeting capture is a screen concern, not an input one, so a
    // view-only grant can still switch monitors without gaining pointer rights.
    const requiredCapability: RemoteControlCapability =
      input.input.type === "key" || input.input.type === "text"
        ? "keyboard"
        : input.input.type === "select-display" || input.input.type === "request-image-fallback"
          ? "screen"
          : "pointer";
    const initialRecord = (yield* SynchronizedRef.get(state)).sessions.get(input.sessionId);
    if (!initialRecord) {
      return yield* new RemoteControlSessionNotFoundError({ sessionId: input.sessionId });
    }
    return yield* initialRecord.deliveryLock.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
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
              return [{ _tag: "Forward", record }, current];
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
              const offered = yield* restore(
                Queue.offer(result.record.hostQueue, {
                  type: "input",
                  connectionId: result.record.hostConnectionId,
                  sessionId: input.sessionId,
                  sequence: input.sequence,
                  input: input.input,
                }),
              );
              if (!offered) return yield* new RemoteControlNoHostError();
              yield* SynchronizedRef.update(state, (current) => {
                const record = current.sessions.get(input.sessionId);
                if (
                  !record ||
                  record.deliveryLock !== result.record.deliveryLock ||
                  record.session.status !== "approved"
                ) {
                  return current;
                }
                const sessions = new Map(current.sessions);
                sessions.set(input.sessionId, { ...record, lastInputSequence: input.sequence });
                return { ...current, sessions };
              });
            }
          }
        }),
      ),
    );
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
            const videoChunks = yield* PubSub.subscribe(initialRecord.videoChunks);
            // A subscriber joining an ALREADY-approved session lands in the
            // middle of a WebM container, and Chromium's demuxer hard-fails
            // on the discontinuity (replaying just the retained init segment
            // is not enough — the bytes in between are gone). Ask the host to
            // restart its encoder so a fresh init segment and a contiguous
            // stream begin at this subscription. Ordered after the PubSub
            // subscriptions above so the restarted stream cannot be missed.
            // Best-effort: a full host queue only means a restart request is
            // already in flight.
            if (initialRecord.session.status === "approved") {
              yield* Queue.offer(initialRecord.hostQueue, {
                type: "video-restart-requested",
                connectionId: initialRecord.hostConnectionId,
                sessionId: initialRecord.session.sessionId,
              }).pipe(Effect.ignore);
            }
            // Replay the retained init segment so a controller joining an
            // already-running video stream can decode what follows.
            const preamble: ReadonlyArray<RemoteControlControllerStreamEvent> = [
              { type: "session-updated" as const, session: initialRecord.session },
              ...(initialRecord.videoInitChunk
                ? [{ type: "video-chunk" as const, chunk: initialRecord.videoInitChunk }]
                : []),
            ];
            return Stream.concat(
              Stream.fromIterable(preamble),
              Stream.merge(
                Stream.merge(Stream.fromSubscription(changes), Stream.fromSubscription(frames)),
                Stream.fromSubscription(videoChunks),
              ),
            );
          }),
        );
      }),
  );

  const cancel: RemoteControlBroker["Service"]["cancel"] = Effect.fn("RemoteControlBroker.cancel")(
    function* (input, controllerSessionId) {
      const initialRecord = (yield* SynchronizedRef.get(state)).sessions.get(input.sessionId);
      if (!initialRecord) {
        return yield* new RemoteControlSessionNotFoundError({ sessionId: input.sessionId });
      }
      return yield* initialRecord.deliveryLock.withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
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
                return [
                  {
                    _tag: "Updated",
                    record: {
                      ...record,
                      videoInitChunk: null,
                      session: {
                        ...record.session,
                        status: "cancelled",
                        updatedAt: now,
                      },
                    },
                  },
                  current,
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
              case "Updated": {
                const offered = yield* restore(
                  Queue.offer(result.record.hostQueue, {
                    type: "session-ended",
                    connectionId: result.record.hostConnectionId,
                    session: result.record.session,
                  }),
                );
                if (!offered) return yield* new RemoteControlNoHostError();
                yield* SynchronizedRef.update(state, (current) => {
                  const record = current.sessions.get(input.sessionId);
                  if (record?.deliveryLock !== result.record.deliveryLock) return current;
                  const sessions = new Map(current.sessions);
                  sessions.set(input.sessionId, result.record);
                  return { ...current, sessions };
                });
                yield* publishSession(result.record);
                yield* pruneTerminalSessions();
                return result.record.session;
              }
            }
          }),
        ),
      );
    },
  );

  return RemoteControlBroker.of({
    connectHost,
    requestAccess,
    respondToRequest,
    publishFrame,
    publishVideoChunk,
    endByHost,
    reportHostStatus,
    watch,
    sendInput,
    cancel,
  });
}).pipe(Effect.withSpan("RemoteControlBroker.make"));

export const layer = Layer.effect(RemoteControlBroker, make);

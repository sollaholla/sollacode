import { IsoDateTime, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ThreadRuntimePhase = Schema.Literals([
  "provider-running",
  "tool-running",
  "subagent-running",
  "provider-retrying",
  "context-compacting",
  "waiting-provider-interaction",
]);
export type ThreadRuntimePhase = typeof ThreadRuntimePhase.Type;

export const ThreadRuntimeLease = Schema.Struct({
  threadId: ThreadId,
  activeTurnId: Schema.NullOr(TurnId),
  phase: ThreadRuntimePhase,
  lastHeartbeatAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type ThreadRuntimeLease = typeof ThreadRuntimeLease.Type;

export interface ThreadRuntimeLeaseHandle {
  readonly lease: ThreadRuntimeLease;
  /** In-memory fencing token; stale owners cannot extend or release a replacement lease. */
  readonly leaseToken: string;
}

export interface ThreadRuntimeReapReservation {
  readonly threadId: ThreadId;
  /** Fences a reaper from another reaper and from new runtime acquisition. */
  readonly reservationToken: string;
}

export interface RuntimeLeaseRegistryShape {
  /** Acquire an unowned/expired thread lease. */
  readonly acquire: (
    lease: ThreadRuntimeLease,
  ) => Effect.Effect<Option.Option<ThreadRuntimeLeaseHandle>>;

  readonly heartbeat: (input: {
    readonly threadId: ThreadId;
    readonly leaseToken: string;
    readonly activeTurnId?: TurnId | null;
    readonly phase: ThreadRuntimePhase;
    readonly lastHeartbeatAt: string;
    readonly expiresAt: string;
  }) => Effect.Effect<boolean>;

  readonly release: (input: {
    readonly threadId: ThreadId;
    readonly leaseToken: string;
  }) => Effect.Effect<boolean>;

  readonly getLive: (threadId: ThreadId) => Effect.Effect<Option.Option<ThreadRuntimeLeaseHandle>>;

  readonly hasLiveWork: (threadId: ThreadId) => Effect.Effect<boolean>;

  readonly listLive: () => Effect.Effect<ReadonlyArray<ThreadRuntimeLeaseHandle>>;

  /**
   * Atomically prove a thread has no live work and prevent new work from
   * acquiring a lease until the destructive reaper operation finishes.
   */
  readonly tryReserveReap: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ThreadRuntimeReapReservation>>;

  readonly releaseReap: (reservation: ThreadRuntimeReapReservation) => Effect.Effect<boolean>;
}

export class RuntimeLeaseRegistry extends Context.Service<
  RuntimeLeaseRegistry,
  RuntimeLeaseRegistryShape
>()("t3/provider/Services/RuntimeLeaseRegistry") {}

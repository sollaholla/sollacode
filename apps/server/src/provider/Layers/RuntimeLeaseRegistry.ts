import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  RuntimeLeaseRegistry,
  type RuntimeLeaseRegistryShape,
  type ThreadRuntimeLease,
  type ThreadRuntimeLeaseHandle,
  type ThreadRuntimeReapReservation,
} from "../Services/RuntimeLeaseRegistry.ts";

interface RegistryState {
  readonly leases: ReadonlyMap<string, ThreadRuntimeLeaseHandle>;
  readonly reapReservations: ReadonlyMap<string, string>;
  readonly nextToken: number;
}

const isLiveAt = (lease: ThreadRuntimeLease, now: number): boolean => {
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
};

const make = Effect.gen(function* () {
  const state = yield* Ref.make<RegistryState>({
    leases: new Map(),
    reapReservations: new Map(),
    nextToken: 1,
  });

  const acquire: RuntimeLeaseRegistryShape["acquire"] = (lease) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (!isLiveAt(lease, now)) {
        return Option.none<ThreadRuntimeLeaseHandle>();
      }
      return yield* Ref.modify(state, (current) => {
        if (current.reapReservations.has(lease.threadId)) {
          return [Option.none<ThreadRuntimeLeaseHandle>(), current] as const;
        }
        const existing = current.leases.get(lease.threadId);
        if (existing !== undefined && isLiveAt(existing.lease, now)) {
          return [Option.none<ThreadRuntimeLeaseHandle>(), current] as const;
        }

        const handle: ThreadRuntimeLeaseHandle = {
          lease,
          leaseToken: `runtime-lease:${current.nextToken}`,
        };
        const leases = new Map(current.leases);
        leases.set(lease.threadId, handle);
        return [
          Option.some(handle),
          { ...current, leases, nextToken: current.nextToken + 1 },
        ] as const;
      });
    });

  const heartbeat: RuntimeLeaseRegistryShape["heartbeat"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const proposedLease = {
        threadId: input.threadId,
        activeTurnId: null,
        phase: input.phase,
        lastHeartbeatAt: input.lastHeartbeatAt,
        expiresAt: input.expiresAt,
      } satisfies ThreadRuntimeLease;
      return yield* Ref.modify(state, (current) => {
        const existing = current.leases.get(input.threadId);
        if (
          existing === undefined ||
          existing.leaseToken !== input.leaseToken ||
          !isLiveAt(existing.lease, now) ||
          !isLiveAt(proposedLease, now)
        ) {
          if (existing !== undefined && !isLiveAt(existing.lease, now)) {
            const leases = new Map(current.leases);
            leases.delete(input.threadId);
            return [false, { ...current, leases }] as const;
          }
          return [false, current] as const;
        }

        const leases = new Map(current.leases);
        leases.set(input.threadId, {
          leaseToken: input.leaseToken,
          lease: {
            ...existing.lease,
            activeTurnId:
              input.activeTurnId === undefined ? existing.lease.activeTurnId : input.activeTurnId,
            phase: input.phase,
            lastHeartbeatAt: input.lastHeartbeatAt,
            expiresAt: input.expiresAt,
          },
        });
        return [true, { ...current, leases }] as const;
      });
    });

  const tryReserveReap: RuntimeLeaseRegistryShape["tryReserveReap"] = (threadId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* Ref.modify(state, (current) => {
        const existing = current.leases.get(threadId);
        if (
          (existing !== undefined && isLiveAt(existing.lease, now)) ||
          current.reapReservations.has(threadId)
        ) {
          return [Option.none<ThreadRuntimeReapReservation>(), current] as const;
        }

        const leases = new Map(current.leases);
        leases.delete(threadId);
        const reservationToken = `runtime-reap:${current.nextToken}`;
        const reapReservations = new Map(current.reapReservations);
        reapReservations.set(threadId, reservationToken);
        return [
          Option.some({ threadId, reservationToken }),
          {
            leases,
            reapReservations,
            nextToken: current.nextToken + 1,
          },
        ] as const;
      });
    });

  const releaseReap: RuntimeLeaseRegistryShape["releaseReap"] = (reservation) =>
    Ref.modify(state, (current) => {
      if (current.reapReservations.get(reservation.threadId) !== reservation.reservationToken) {
        return [false, current] as const;
      }
      const reapReservations = new Map(current.reapReservations);
      reapReservations.delete(reservation.threadId);
      return [true, { ...current, reapReservations }] as const;
    });

  const release: RuntimeLeaseRegistryShape["release"] = (input) =>
    Ref.modify(state, (current) => {
      const existing = current.leases.get(input.threadId);
      if (existing === undefined || existing.leaseToken !== input.leaseToken) {
        return [false, current] as const;
      }

      const leases = new Map(current.leases);
      leases.delete(input.threadId);
      return [true, { ...current, leases }] as const;
    });

  const getLive: RuntimeLeaseRegistryShape["getLive"] = (threadId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* Ref.modify(state, (current) => {
        const existing = current.leases.get(threadId);
        if (existing === undefined) {
          return [Option.none<ThreadRuntimeLeaseHandle>(), current] as const;
        }
        if (isLiveAt(existing.lease, now)) {
          return [Option.some(existing), current] as const;
        }

        const leases = new Map(current.leases);
        leases.delete(threadId);
        return [Option.none<ThreadRuntimeLeaseHandle>(), { ...current, leases }] as const;
      });
    });

  const listLive: RuntimeLeaseRegistryShape["listLive"] = () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* Ref.modify(state, (current) => {
        const leases = new Map<string, ThreadRuntimeLeaseHandle>();
        for (const [threadId, handle] of current.leases) {
          if (isLiveAt(handle.lease, now)) {
            leases.set(threadId, handle);
          }
        }
        return [Array.from(leases.values()), { ...current, leases }] as const;
      });
    });

  return {
    acquire,
    heartbeat,
    release,
    getLive,
    hasLiveWork: (threadId) => getLive(threadId).pipe(Effect.map(Option.isSome)),
    listLive,
    tryReserveReap,
    releaseReap,
  } satisfies RuntimeLeaseRegistryShape;
});

export const RuntimeLeaseRegistryLive = Layer.effect(RuntimeLeaseRegistry, make);

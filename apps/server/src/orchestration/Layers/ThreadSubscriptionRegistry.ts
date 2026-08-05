import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  ThreadSubscriptionRegistry,
  type ThreadSubscriptionLease,
  type ThreadSubscriptionRegistryShape,
} from "../Services/ThreadSubscriptionRegistry.ts";

interface RegistryState {
  readonly leases: ReadonlyMap<string, ThreadSubscriptionLease>;
  readonly nextToken: number;
}

const make = Effect.gen(function* () {
  const state = yield* Ref.make<RegistryState>({ leases: new Map(), nextToken: 1 });

  const acquire = (
    kind: ThreadSubscriptionLease["kind"],
    threadId: ThreadSubscriptionLease["threadId"],
  ) =>
    Ref.modify(state, (current) => {
      const lease: ThreadSubscriptionLease = {
        token: `thread-subscription:${current.nextToken}`,
        kind,
        threadId,
      };
      const leases = new Map(current.leases);
      leases.set(lease.token, lease);
      return [lease, { leases, nextToken: current.nextToken + 1 }] as const;
    });

  const release: ThreadSubscriptionRegistryShape["release"] = (lease) =>
    Ref.modify(state, (current) => {
      const existing = current.leases.get(lease.token);
      if (
        existing === undefined ||
        existing.kind !== lease.kind ||
        existing.threadId !== lease.threadId
      ) {
        return [false, current] as const;
      }
      const leases = new Map(current.leases);
      leases.delete(lease.token);
      return [true, { ...current, leases }] as const;
    });

  return {
    acquireShell: () => acquire("shell", null),
    acquireDetail: (threadId) => acquire("detail", threadId),
    release,
    snapshot: Ref.get(state).pipe(
      Effect.map((current) => {
        let shellSubscriptions = 0;
        let detailSubscriptions = 0;
        const detailedThreadIds = new Set<ThreadId>();
        for (const lease of current.leases.values()) {
          if (lease.kind === "shell") {
            shellSubscriptions += 1;
            continue;
          }
          detailSubscriptions += 1;
          if (lease.threadId !== null) detailedThreadIds.add(lease.threadId);
        }
        return {
          shellSubscriptions,
          detailSubscriptions,
          detailedThreadIds,
        };
      }),
    ),
  } satisfies ThreadSubscriptionRegistryShape;
});

export const ThreadSubscriptionRegistryLive = Layer.effect(ThreadSubscriptionRegistry, make);

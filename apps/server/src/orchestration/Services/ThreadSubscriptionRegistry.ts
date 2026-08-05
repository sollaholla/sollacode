import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type ThreadSubscriptionKind = "shell" | "detail";

export interface ThreadSubscriptionLease {
  readonly token: string;
  readonly kind: ThreadSubscriptionKind;
  readonly threadId: ThreadId | null;
}

export interface ThreadSubscriptionSnapshot {
  readonly shellSubscriptions: number;
  readonly detailSubscriptions: number;
  readonly detailedThreadIds: ReadonlySet<ThreadId>;
}

export interface ThreadSubscriptionRegistryShape {
  readonly acquireShell: () => Effect.Effect<ThreadSubscriptionLease>;
  readonly acquireDetail: (threadId: ThreadId) => Effect.Effect<ThreadSubscriptionLease>;
  readonly release: (lease: ThreadSubscriptionLease) => Effect.Effect<boolean>;
  readonly snapshot: Effect.Effect<ThreadSubscriptionSnapshot>;
}

export class ThreadSubscriptionRegistry extends Context.Service<
  ThreadSubscriptionRegistry,
  ThreadSubscriptionRegistryShape
>()("t3/orchestration/Services/ThreadSubscriptionRegistry") {}

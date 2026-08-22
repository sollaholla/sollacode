/**
 * ThreadPendingWorkSignal — "this thread's queued work changed, re-read it".
 *
 * `projection_threads.pending_work_*` is the only shell column that moves
 * without a domain event behind it: work obligations are scheduler state, and
 * the scheduler completes, cancels, sleeps and claims them silently. Shell
 * subscriptions refetch a thread when one of its events lands, so a transition
 * that lands after the thread's last event reaches nobody — the client keeps
 * whatever it read last, forever. That is how a cancelled startup resume left
 * sidebar rows counting up "Auto-resuming" for hours (2026-08-11).
 *
 * The repository publishes the thread id here on every obligation mutation;
 * `subscribeShell` re-reads that thread and emits a `thread-pending-work` item.
 * Only the id travels, so a signal can never deliver a value staler than the
 * read it triggers.
 *
 * @module ThreadPendingWorkSignal
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface ThreadPendingWorkSignalShape {
  /** Announce that a thread's pending-work columns may have changed. */
  readonly publish: (threadId: ThreadId) => Effect.Effect<void>;
  /** Thread ids whose pending work changed, from the moment of subscription. */
  readonly changes: Stream.Stream<ThreadId>;
}

export class ThreadPendingWorkSignal extends Context.Service<
  ThreadPendingWorkSignal,
  ThreadPendingWorkSignalShape
>()("t3/persistence/Services/ThreadPendingWorkSignal") {}

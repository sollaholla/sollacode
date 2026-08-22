/**
 * ThreadPendingWorkSignal layer.
 *
 * An unbounded PubSub: publishing must never back-pressure a scheduler
 * transition, and a PubSub with no subscribers drops what it is given, so an
 * environment nobody is watching costs nothing. Subscribers hand each id
 * straight to their own bounded buffer, so nothing accumulates here.
 *
 * @module ThreadPendingWorkSignal
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  ThreadPendingWorkSignal,
  type ThreadPendingWorkSignalShape,
} from "../Services/ThreadPendingWorkSignal.ts";

const make = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<ThreadId>();

  return {
    publish: (threadId) => PubSub.publish(pubSub, threadId).pipe(Effect.asVoid),
    get changes() {
      return Stream.fromPubSub(pubSub);
    },
  } satisfies ThreadPendingWorkSignalShape;
});

export const ThreadPendingWorkSignalLive = Layer.effect(ThreadPendingWorkSignal, make);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { MediaSubscriberMessage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Socket from "effect/unstable/socket/Socket";
import { make } from "./MediaRelay.ts";

const encodeMessage = Schema.encodeSync(Schema.fromJsonString(MediaSubscriberMessage));
const relayEffect = make.pipe(Effect.provide(NodeServices.layer));

it.effect(
  "does not redeem tickets after their owning session ends, even if issuance races close",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const relay = yield* relayEffect;
        let active = true;
        const grant = { topic: "session", role: "subscribe" as const, isActive: () => active };
        const before = yield* relay.issueTicket(grant);
        active = false;
        yield* relay.closeTopic("session", "ended");
        const after = yield* relay.issueTicket(grant);
        expect(yield* relay.redeemTicket(before.ticket)).toBeNull();
        expect(yield* relay.redeemTicket(after.ticket)).toBeNull();
      }),
    ),
);

it.effect(
  "cannot resurrect a topic from a redeemed grant whose upgrade finishes after cancellation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const relay = yield* relayEffect;
        let active = true;
        const ticket = yield* relay.issueTicket({
          topic: "session",
          role: "subscribe",
          isActive: () => active,
        });
        const grant = yield* relay.redeemTicket(ticket.ticket);
        expect(grant).not.toBeNull();
        active = false;
        yield* relay.closeTopic("session", "ended");
        const socket = Socket.make({
          writer: Effect.succeed(() => Effect.void),
          runRaw: (_handler, options) =>
            Effect.andThen(options?.onOpen ?? Effect.void, Effect.never),
        });
        yield* relay.serve(grant!, socket);
        expect((yield* relay.stats).topics).toBe(0);
      }),
    ),
);

it.effect("disconnects a socket when its outbound writer fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const relay = yield* relayEffect;
      const socket = Socket.make({
        writer: Effect.succeed(() =>
          Effect.fail(
            new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause: "closed" }) }),
          ),
        ),
        runRaw: (_handler, options) => Effect.andThen(options?.onOpen ?? Effect.void, Effect.never),
      });
      yield* relay.serve({ topic: "session", role: "subscribe", isActive: () => true }, socket);
      expect((yield* relay.stats).subscribers).toBe(0);
    }),
  ),
);

it.effect("bounds outbound notices while a publisher cannot drain its socket", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const relay = yield* relayEffect;
      const opened = yield* Deferred.make<void>();
      const publisher = Socket.make({
        writer: Effect.succeed(() => Effect.never),
        runRaw: (_handler, options) =>
          Effect.gen(function* () {
            yield* options?.onOpen ?? Effect.void;
            yield* Deferred.succeed(opened, undefined);
            return yield* Effect.never;
          }),
      });
      const fiber = yield* Effect.forkScoped(
        relay.serve({ topic: "session", role: "publish", isActive: () => true }, publisher),
      );
      yield* Deferred.await(opened);
      // Every join produces a subscriber notice + keyframe request to publisher.
      const subscriber = Socket.make({
        writer: Effect.succeed(() => Effect.void),
        runRaw: (handler, options) =>
          Effect.gen(function* () {
            yield* options?.onOpen ?? Effect.void;
            const handled = handler(
              encodeMessage({
                type: "hello",
                codecs: ["vp8"],
                view: { width: 640, height: 480, zoom: 1, devicePixelRatio: 1 },
              }),
            );
            if (handled) yield* handled;
          }),
      });
      for (let i = 0; i < 100; i++)
        yield* relay.serve(
          { topic: "session", role: "subscribe", isActive: () => true },
          subscriber,
        );
      yield* Fiber.join(fiber);
      expect((yield* relay.stats).topics).toBe(0);
    }),
  ),
);

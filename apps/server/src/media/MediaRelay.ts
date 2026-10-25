/**
 * The media channel: binary WebSocket relay for live video (`/ws/media`).
 *
 * Access is by ticket only. A feature that owns a topic (remote control
 * today) checks its own authorization on an ordinary authenticated RPC, then
 * calls `issueTicket`; the client opens `/ws/media?ticket=…` and the upgrade
 * redeems it. A ticket is random, single use, short-lived, and names exactly
 * one topic and role, so the socket needs no cookie or bearer of its own and
 * adds no unauthenticated surface. Ending the feature's session calls
 * `closeTopic`, which also voids its unredeemed tickets.
 *
 * Routing and pacing live in `mediaRelayCore`; this layer only adapts
 * sockets to it. Every outbound message goes through a per-connection queue
 * drained by its own fiber, so a slow or dead socket can never block the
 * publisher's fan-out.
 */
import type { MediaChannelTicket } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/unstable/socket/Socket";

import {
  createMediaRelayCore,
  type MediaRelayCoreStats,
  type MediaRelayEndpoint,
} from "./mediaRelayCore.ts";

export type MediaRole = "publish" | "subscribe";

export interface MediaGrant {
  readonly topic: string;
  readonly role: MediaRole;
  /** Rechecked synchronously at issuance, redemption, and connection/message delivery. */
  readonly isActive: () => boolean;
}

export const MEDIA_TICKET_TTL_MS = 30_000;
const MEDIA_RELAY_TICK = "250 millis";

interface StoredTicket {
  readonly grant: MediaGrant;
  readonly expiresAt: number;
}

export class MediaRelay extends Context.Service<
  MediaRelay,
  {
    readonly issueTicket: (grant: MediaGrant) => Effect.Effect<MediaChannelTicket>;
    /** Consumes a ticket. None when it is unknown, used or expired. */
    readonly redeemTicket: (ticket: string) => Effect.Effect<MediaGrant | null>;
    /** Runs one upgraded socket until it closes. */
    readonly serve: (grant: MediaGrant, socket: Socket.Socket) => Effect.Effect<void>;
    readonly closeTopic: (topic: string, reason: string) => Effect.Effect<void>;
    readonly stats: Effect.Effect<MediaRelayCoreStats>;
  }
>()("t3/media/MediaRelay") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Effect.clockWith((current) => Effect.succeed(current));
  const core = createMediaRelayCore({ now: () => clock.currentTimeMillisUnsafe() });
  const tickets = yield* Ref.make(new Map<string, StoredTicket>());
  yield* Effect.forkScoped(
    Effect.repeat(
      Effect.sync(() => core.tick()),
      Schedule.spaced(MEDIA_RELAY_TICK),
    ),
  );

  const pruneTickets = (store: Map<string, StoredTicket>, now: number) => {
    const next = new Map<string, StoredTicket>();
    for (const [key, value] of store) if (value.expiresAt > now) next.set(key, value);
    return next;
  };

  const issueTicket: MediaRelay["Service"]["issueTicket"] = Effect.fn("MediaRelay.issueTicket")(
    function* (grant) {
      const first = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const second = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const ticket = `${first}${second}`.replaceAll("-", "");
      const now = clock.currentTimeMillisUnsafe();
      yield* Ref.update(tickets, (store) => {
        const next = pruneTickets(store, now);
        if (grant.isActive()) next.set(ticket, { grant, expiresAt: now + MEDIA_TICKET_TTL_MS });
        return next;
      });
      return { ticket, expiresInMs: MEDIA_TICKET_TTL_MS };
    },
  );

  const redeemTicket: MediaRelay["Service"]["redeemTicket"] = (ticket) =>
    Ref.modify(tickets, (store) => {
      const now = clock.currentTimeMillisUnsafe();
      const stored = store.get(ticket);
      const next = pruneTickets(store, now);
      next.delete(ticket);
      return [
        stored && stored.expiresAt > now && stored.grant.isActive() ? stored.grant : null,
        next,
      ] as const;
    });

  const serve: MediaRelay["Service"]["serve"] = (grant, socket) =>
    Effect.scoped(
      Effect.gen(function* () {
        const write = yield* socket.writer;
        const outbox = yield* Queue.dropping<string | Uint8Array | Socket.CloseEvent>(128);
        const terminated = yield* Deferred.make<void>();
        let pendingBytes = 0;
        let closed = false;
        const messageSize = (data: string | Uint8Array | Socket.CloseEvent) =>
          typeof data === "string"
            ? data.length * 2
            : data instanceof Uint8Array
              ? data.byteLength
              : 0;
        const enqueue = (data: string | Uint8Array | Socket.CloseEvent) => {
          if (closed) return;
          const size = messageSize(data);
          if (pendingBytes + size > 8 * 1024 * 1024 || !Queue.offerUnsafe(outbox, data)) {
            closed = true;
            Deferred.doneUnsafe(terminated, Effect.void);
            return;
          }
          pendingBytes += size;
        };
        const drain = Effect.forever(
          Effect.flatMap(Queue.take(outbox), (message) => {
            pendingBytes -= messageSize(message);
            return write(message);
          }),
        );
        const id = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8);
        const connection = {
          id,
          send: (data: string | Uint8Array) => {
            if (grant.isActive()) enqueue(data);
            else Deferred.doneUnsafe(terminated, Effect.void);
          },
          close: (code: number, reason: string) => {
            enqueue(new Socket.CloseEvent(code, reason));
          },
        };
        let endpoint: MediaRelayEndpoint | null = null;
        const read = socket.runRaw(
          (data) => {
            // Synchronous on purpose: a handler that returns an effect is
            // forked per message, and packets must be routed in order.
            if (grant.isActive()) endpoint?.onMessage(data);
            else Deferred.doneUnsafe(terminated, Effect.void);
          },
          {
            onOpen: Effect.sync(() => {
              if (!grant.isActive()) {
                Deferred.doneUnsafe(terminated, Effect.void);
                return;
              }
              endpoint =
                grant.role === "publish"
                  ? core.connectPublisher(grant.topic, connection)
                  : core.connectSubscriber(grant.topic, connection);
            }),
          },
        );
        yield* Effect.raceFirst(read, Effect.raceFirst(drain, Deferred.await(terminated))).pipe(
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              endpoint?.disconnect();
              endpoint = null;
            }),
          ),
        );
      }),
    ).pipe(Effect.withSpan("MediaRelay.serve", { attributes: { "media.role": grant.role } }));

  const closeTopic: MediaRelay["Service"]["closeTopic"] = (topic, reason) =>
    Effect.gen(function* () {
      yield* Ref.update(tickets, (store) => {
        const next = new Map<string, StoredTicket>();
        for (const [key, value] of store) if (value.grant.topic !== topic) next.set(key, value);
        return next;
      });
      yield* Effect.sync(() => core.closeTopic(topic, reason));
    });

  return MediaRelay.of({
    issueTicket,
    redeemTicket,
    serve,
    closeTopic,
    stats: Effect.sync(() => core.stats()),
  });
});

export const layer = Layer.effect(MediaRelay, make);

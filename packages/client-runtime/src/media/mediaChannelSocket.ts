/**
 * Browser end of the media channel (`/ws/media`): one WebSocket per role.
 *
 * Subscribers acknowledge every packet the moment it arrives - before
 * decoding - because the relay paces each viewer by the age of its oldest
 * unacknowledged packet, and that should measure the network, not the
 * decoder.
 */
import {
  MEDIA_CHANNEL_PATH,
  MediaPublisherMessage,
  MediaPublisherNotice,
  MediaSubscriberMessage,
  MediaSubscriberNotice,
} from "@t3tools/contracts";
import { decodeMediaPacket, encodeMediaAck, type MediaPacket } from "@t3tools/shared/mediaPacket";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const encodeSubscriberMessage = Schema.encodeSync(Schema.fromJsonString(MediaSubscriberMessage));
const encodePublisherMessage = Schema.encodeSync(Schema.fromJsonString(MediaPublisherMessage));
const decodeSubscriberNotice = Schema.decodeUnknownOption(
  Schema.fromJsonString(MediaSubscriberNotice),
);
const decodePublisherNotice = Schema.decodeUnknownOption(
  Schema.fromJsonString(MediaPublisherNotice),
);

/**
 * The media-channel URL for an environment, from its RPC socket URL: same
 * scheme, host and port, the media path, and the ticket as the only query.
 * Any credential on the RPC URL (a one-shot `wsTicket`) is dropped.
 */
export function mediaChannelUrl(socketUrl: string, ticket: string): string {
  const url = new URL(socketUrl);
  url.pathname = /\/ws\/?$/.test(url.pathname)
    ? url.pathname.replace(/\/ws\/?$/, MEDIA_CHANNEL_PATH)
    : MEDIA_CHANNEL_PATH;
  url.search = "";
  url.hash = "";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export interface MediaSocketCallbacks {
  readonly onOpen?: () => void;
  /** `code` in 4000-4099 means the relay ended the topic; do not retry. */
  readonly onClose: (code: number, reason: string) => void;
}

export interface MediaSubscriberSocket {
  readonly send: (message: MediaSubscriberMessage) => void;
  readonly close: () => void;
}

export function openMediaSubscriber(
  url: string,
  callbacks: MediaSocketCallbacks & {
    readonly onPacket: (packet: MediaPacket, receivedAt: number) => void;
    readonly onNotice: (notice: MediaSubscriberNotice) => void;
  },
): MediaSubscriberSocket {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let closed = false;
  socket.addEventListener("open", () => callbacks.onOpen?.());
  socket.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => {
    if (typeof event.data === "string") {
      const notice = decodeSubscriberNotice(event.data);
      if (Option.isSome(notice)) callbacks.onNotice(notice.value);
      return;
    }
    const receivedAt = performance.now();
    const packet = decodeMediaPacket(new Uint8Array(event.data));
    if (!packet) return;
    if (socket.readyState === WebSocket.OPEN) socket.send(encodeMediaAck(packet.sequence));
    callbacks.onPacket(packet, receivedAt);
  });
  socket.addEventListener("close", (event) => {
    if (closed) return;
    closed = true;
    callbacks.onClose(event.code, event.reason);
  });
  return {
    send: (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encodeSubscriberMessage(message));
    },
    close: () => {
      closed = true;
      socket.close();
    },
  };
}

export interface MediaPublisherSocket {
  readonly sendPacket: (bytes: Uint8Array<ArrayBuffer>) => void;
  readonly send: (message: MediaPublisherMessage) => void;
  /** Bytes accepted by `sendPacket` but not yet handed to the network. */
  readonly bufferedAmount: () => number;
  readonly isOpen: () => boolean;
  readonly close: () => void;
}

export function openMediaPublisher(
  url: string,
  callbacks: MediaSocketCallbacks & {
    readonly onNotice: (notice: MediaPublisherNotice) => void;
  },
): MediaPublisherSocket {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let closed = false;
  socket.addEventListener("open", () => callbacks.onOpen?.());
  socket.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => {
    if (typeof event.data !== "string") return;
    const notice = decodePublisherNotice(event.data);
    if (Option.isSome(notice)) callbacks.onNotice(notice.value);
  });
  socket.addEventListener("close", (event) => {
    if (closed) return;
    closed = true;
    callbacks.onClose(event.code, event.reason);
  });
  return {
    sendPacket: (bytes) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
    },
    send: (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encodePublisherMessage(message));
    },
    bufferedAmount: () => socket.bufferedAmount,
    isOpen: () => socket.readyState === WebSocket.OPEN,
    close: () => {
      closed = true;
      socket.close();
    },
  };
}

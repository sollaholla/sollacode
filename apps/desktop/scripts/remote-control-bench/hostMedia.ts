/**
 * Benchmark host, media-channel pipeline: the production
 * `createVideoStreamPublisher` fed by the synthetic desktop's capture track.
 */
import type { RemoteControlHostStreamEvent, RemoteControlInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { mediaChannelUrl } from "@t3tools/client-runtime/media/media-channel-socket";
import {
  createVideoStreamPublisher,
  type VideoStreamPublisher,
} from "@t3tools/client-runtime/media/video-stream-publisher";
import { connectBenchRpc } from "./benchRpc.ts";

export interface MediaHostHandle {
  readonly stop: () => Promise<void>;
  readonly stats: () => Record<string, unknown>;
}

export async function startMediaHost(options: {
  readonly canvas: HTMLCanvasElement;
  readonly onInput: (input: RemoteControlInput) => void;
}): Promise<MediaHostHandle> {
  const socketUrl = `${location.origin.replace(/^http/, "ws")}/ws?as=host`;
  const connection = await connectBenchRpc(socketUrl);
  const { client } = connection;
  let publisher: VideoStreamPublisher | null = null;
  let markConnected: () => void = () => {};
  const connected = new Promise<void>((done) => {
    markConnected = done;
  });

  const handle = (event: RemoteControlHostStreamEvent) => {
    switch (event.type) {
      case "connected":
        markConnected();
        return;
      case "access-requested":
        void connection
          .run(
            client["remoteControl.hostRespond"]({
              clientId: "bench-host",
              connectionId: event.connectionId,
              requestId: event.requestId,
              decision: "approve",
              grantedCapabilities: event.session.requestedCapabilities,
            }),
          )
          .then((session) => {
            publisher?.stop();
            publisher = createVideoStreamPublisher({
              resolveUrl: async () => {
                const ticket = await connection.run(
                  client["remoteControl.hostMediaTicket"]({
                    clientId: "bench-host",
                    connectionId: event.connectionId,
                    sessionId: session.sessionId,
                  }),
                );
                return mediaChannelUrl(socketUrl, ticket.ticket);
              },
              openSource: async () => {
                const stream = options.canvas.captureStream();
                const track = stream.getVideoTracks()[0]!;
                return { track, close: () => track.stop() };
              },
            });
          });
        return;
      case "input":
        options.onInput(event.input);
        return;
      case "session-ended":
        publisher?.stop();
        publisher = null;
        return;
      default:
        return;
    }
  };

  const fiber = Effect.runFork(
    Stream.runForEach(
      client["remoteControl.hostConnect"]({
        clientId: "bench-host",
        environmentId: "bench-env" as never,
        platform: "macos",
        capabilities: ["screen", "pointer", "keyboard"],
      }),
      (event) => Effect.sync(() => handle(event)),
    ),
  );
  await connected;

  return {
    stop: async () => {
      publisher?.stop();
      publisher = null;
      await Effect.runPromise(Fiber.interrupt(fiber));
      await connection.close();
    },
    stats: () => ({ ...(publisher?.stats() ?? {}) }),
  };
}

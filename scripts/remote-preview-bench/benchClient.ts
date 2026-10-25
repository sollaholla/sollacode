import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Socket from "effect/unstable/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import { BenchRpcGroup } from "./benchRpc.ts";

export interface SocketCounters {
  /** Bytes this side received and sent on the wire: after permessage-deflate, with WebSocket framing. */
  readonly read: () => number;
  readonly written: () => number;
}

/**
 * An RPC client for the bench server over the same JSON-over-WebSocket
 * protocol the app uses, offering permessage-deflate like browsers do. The
 * counters read the TCP socket underneath, so they are what a phone's radio
 * would carry.
 */
export const connectBenchClient = Effect.fn("bench.connectBenchClient")(function* (url: string) {
  const sockets: Array<InstanceType<typeof NodeSocket.NodeWS.WebSocket>> = [];
  const constructor = Layer.succeed(Socket.WebSocketConstructor, (target, protocols) => {
    const socket = new NodeSocket.NodeWS.WebSocket(target, protocols, { perMessageDeflate: true });
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  });
  const protocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(url).pipe(Layer.provide(constructor)),
        RpcSerialization.layerJson,
      ),
    ),
  );
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(protocol, scope);
  const client = yield* RpcClient.make(BenchRpcGroup).pipe(
    Effect.provide(context),
    Scope.provide(scope),
  );
  const raw = () =>
    sockets.map(
      (socket) =>
        (socket as unknown as { _socket?: { bytesRead: number; bytesWritten: number } })._socket,
    );
  const counters: SocketCounters = {
    read: () => raw().reduce((total, socket) => total + (socket?.bytesRead ?? 0), 0),
    written: () => raw().reduce((total, socket) => total + (socket?.bytesWritten ?? 0), 0),
  };
  return { client, counters, close: Scope.close(scope, Exit.void) };
});

export type BenchClient = Effect.Success<ReturnType<typeof connectBenchClient>>["client"];

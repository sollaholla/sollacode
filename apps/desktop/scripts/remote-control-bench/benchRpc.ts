/**
 * The benchmark's RPC client: the production Effect RPC socket protocol and
 * JSON serialization over the remote-control methods only, so the bytes and
 * the stream-ack pacing on the wire are exactly what the app sends.
 */
import {
  WsRemoteControlCancelRpc,
  WsRemoteControlHostAcknowledgeInputRpc,
  WsRemoteControlHostConnectRpc,
  WsRemoteControlHostEndRpc,
  WsRemoteControlHostPublishFrameRpc,
  WsRemoteControlHostPublishVideoChunkRpc,
  WsRemoteControlHostReportStatusRpc,
  WsRemoteControlHostRespondRpc,
  WsRemoteControlRequestAccessRpc,
  WsRemoteControlSendInputRpc,
  WsRemoteControlWatchRpc,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Socket from "effect/unstable/socket/Socket";
import { RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc";

import { BENCH_EXTRA_RPCS } from "./benchRpcExtras.ts";

export const BenchRpcGroup = RpcGroup.make(
  WsRemoteControlHostConnectRpc,
  WsRemoteControlHostRespondRpc,
  WsRemoteControlHostPublishFrameRpc,
  WsRemoteControlHostPublishVideoChunkRpc,
  WsRemoteControlHostReportStatusRpc,
  WsRemoteControlHostAcknowledgeInputRpc,
  WsRemoteControlHostEndRpc,
  WsRemoteControlRequestAccessRpc,
  WsRemoteControlWatchRpc,
  WsRemoteControlSendInputRpc,
  WsRemoteControlCancelRpc,
  ...BENCH_EXTRA_RPCS,
);

const makeClient = RpcClient.make(BenchRpcGroup);
export type BenchRpcClient = typeof makeClient extends Effect.Effect<infer C, any, any> ? C : never;

export interface BenchRpcConnection {
  readonly client: BenchRpcClient;
  readonly close: () => Promise<void>;
  /** Runs an effect with the connection's services, rejecting on failure. */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

export async function connectBenchRpc(url: string): Promise<BenchRpcConnection> {
  const scope = Effect.runSync(Scope.make());
  const socketLayer = Socket.layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
  const client = await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(protocolLayer);
      return yield* makeClient.pipe(Effect.provide(context));
    }).pipe(Scope.provide(scope)),
  );
  return {
    client,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    run: (effect) => Effect.runPromise(effect),
  };
}

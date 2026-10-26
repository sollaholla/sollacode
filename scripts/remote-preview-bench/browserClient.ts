import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Socket from "effect/unstable/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import { BenchRpcGroup } from "./benchRpc.ts";

/** Production RPC framing in the browser; Node socket instrumentation stays outside the page. */
export async function connectBrowserClient(url: string) {
  const scope = Effect.runSync(Scope.make());
  const protocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        RpcSerialization.layerJson,
      ),
    ),
  );
  try {
    const context = await Effect.runPromise(Layer.buildWithScope(protocol, scope));
    const client = await Effect.runPromise(
      RpcClient.make(BenchRpcGroup).pipe(Effect.provide(context), Scope.provide(scope)),
    );
    return { client, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

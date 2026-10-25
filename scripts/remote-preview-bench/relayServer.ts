// @effect-diagnostics nodeBuiltinImport:off - The bench server listens on a raw loopback HTTP server like the app's.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as PreviewAutomationBroker from "../../apps/server/src/mcp/PreviewAutomationBroker.ts";
import { ProjectionSnapshotQuery } from "../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { PreviewManager } from "../../apps/server/src/preview/Manager.ts";
import { captureRemotePreviewSnapshot } from "../../apps/server/src/preview/RemotePreviewCapture.ts";
import { dispatchRemotePreviewInput } from "../../apps/server/src/preview/RemotePreviewInput.ts";
import * as RemoteFrameRelay from "../../apps/server/src/preview/RemoteFrameRelay.ts";
import { BenchRpcGroup } from "./benchRpc.ts";

export const BENCH_ENVIRONMENT_ID = EnvironmentId.make("bench-environment");
const SESSION_ID = AuthSessionId.make("bench-session");

/**
 * The production remote-preview server path on a loopback port: the real
 * broker, snapshot capture, input dispatch, and RPC framing (JSON over a
 * WebSocket with permessage-deflate), minus auth and persistence.
 */
export const startRelayServer = Effect.fn("bench.startRelayServer")(function* () {
  const broker = yield* PreviewAutomationBroker.make.pipe(
    Effect.provideService(
      PreviewManager,
      PreviewManager.of({ reportActivity: () => Effect.void } as never),
    ),
    Effect.provideService(
      ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.of({
        getThreadShellById: () => Effect.succeed(Option.none()),
      } as never),
    ),
    Effect.provide(NodeServices.layer),
  );

  const relay = yield* RemoteFrameRelay.make();
  const handlers = BenchRpcGroup.toLayer({
    [WS_METHODS.previewRemoteFrames]: (input) => relay.watch(input),
    [WS_METHODS.previewRemoteFramePublish]: (input) => relay.publish(input),
    [WS_METHODS.previewAutomationConnect]: (input) => {
      const events = Stream.unwrap(broker.connect(input));
      return input.streamsRemoteFrames
        ? RemoteFrameRelay.withRemoteFrameDemand(events, relay)
        : events;
    },
    [WS_METHODS.previewAutomationRespond]: (input) => broker.respond(input),
    [WS_METHODS.previewRemoteSnapshot]: (input) =>
      Effect.gen(function* () {
        const issuedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        return yield* captureRemotePreviewSnapshot({
          broker,
          environmentId: BENCH_ENVIRONMENT_ID,
          sessionId: SESSION_ID,
          request: input,
          issuedAt,
        });
      }),
    [WS_METHODS.previewRemoteInput]: (input) =>
      Effect.gen(function* () {
        const issuedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        return yield* dispatchRemotePreviewInput({
          broker,
          environmentId: BENCH_ENVIRONMENT_ID,
          sessionId: SESSION_ID,
          request: input,
          issuedAt,
        });
      }),
  });

  const routes = HttpRouter.add(
    "GET",
    "/ws",
    Effect.gen(function* () {
      const rpc = yield* RpcServer.toHttpEffectWebsocket(BenchRpcGroup, {
        disableTracing: true,
      }).pipe(Effect.provide(handlers.pipe(Layer.provideMerge(RpcSerialization.layerJson))));
      return yield* rpc;
    }),
  );

  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(
    HttpRouter.serve(routes, { disableLogger: true }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port: 0 }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
    scope,
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provide(context));
  const address = server.address;
  if (address._tag !== "TcpAddress") return yield* Effect.die("bench server is not on TCP");
  return {
    port: address.port,
    close: Scope.close(scope, Exit.void),
  };
});

// @effect-diagnostics nodeBuiltinImport:off - The bench server listens on a raw loopback HTTP server like the app's.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, EnvironmentId, WS_METHODS, type PreviewEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
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
import * as PreviewMediaBroker from "../../apps/server/src/preview/PreviewMediaBroker.ts";
import * as MediaRelay from "../../apps/server/src/media/MediaRelay.ts";
import { mediaChannelRouteHandler } from "../../apps/server/src/media/mediaChannelRoute.ts";
import { BenchRpcGroup } from "./benchRpc.ts";

export const BENCH_ENVIRONMENT_ID = EnvironmentId.make("bench-environment");
const SESSION_ID = AuthSessionId.make("bench-session");

/**
 * The production remote-preview server path on a loopback port: the real
 * broker, snapshot capture, input dispatch, and RPC framing (JSON over a
 * WebSocket with permessage-deflate), minus auth and persistence.
 */
export const startRelayServer = Effect.fn("bench.startRelayServer")(function* () {
  const scope = yield* Scope.make();
  const previewEvents = yield* PubSub.unbounded<PreviewEvent>();
  const mediaRelay = yield* MediaRelay.make.pipe(
    Scope.provide(scope),
    Effect.provide(NodeServices.layer),
  );
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
  const media = yield* PreviewMediaBroker.make({
    automation: broker,
    manager: {
      hasSession: (target) => target.threadId === "bench-thread" && target.tabId === "bench-tab",
      subscribeEvents: PubSub.subscribe(previewEvents),
    },
    relay: mediaRelay,
    environmentId: BENCH_ENVIRONMENT_ID,
    owningThreadId: (threadId) => Effect.succeed(threadId),
  }).pipe(Scope.provide(scope), Effect.provide(NodeServices.layer));
  const handlers = BenchRpcGroup.toLayer({
    [WS_METHODS.previewReportStatus]: () => Effect.void,
    [WS_METHODS.previewMediaWatch]: (input) => media.watch(input, SESSION_ID),
    [WS_METHODS.previewMediaTicket]: (input) => media.issueTicket(input, SESSION_ID),
    [WS_METHODS.previewHostMediaTicket]: (input) => media.issueHostTicket(input, SESSION_ID),
    [WS_METHODS.previewRemoteFrames]: (input) => relay.watch(input),
    [WS_METHODS.previewRemoteFramePublish]: (input) => relay.publish(input),
    [WS_METHODS.previewAutomationConnect]: (input) => {
      let events = Stream.unwrap(broker.connect(input, SESSION_ID));
      if (input.streamsRemoteFrames) events = RemoteFrameRelay.withRemoteFrameDemand(events, relay);
      if (input.streamsPreviewMedia)
        events = PreviewMediaBroker.withPreviewMediaDemand(events, media);
      return events;
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

  const context = yield* Layer.buildWithScope(
    HttpRouter.serve(
      Layer.merge(routes, HttpRouter.add("GET", "/ws/media", mediaChannelRouteHandler(mediaRelay))),
      { disableLogger: true },
    ).pipe(
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

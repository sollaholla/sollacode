/**
 * Relay server for the remote-control benchmark
 * (apps/desktop/scripts/remote-control-bench/run.ts starts it).
 *
 * It is the production relay with everything else taken away: the real
 * `RemoteControlBroker` behind the real Effect RPC websocket protocol (JSON
 * serialization, stream acks, permessage-deflate from the patched Node
 * server), and the real media relay behind `/ws/media`. Only authentication
 * is replaced: a connection names its role with `?as=host|viewer` and gets a
 * fixed auth session id, so pages need no pairing.
 *
 * Prints `READY <port>` once listening. Serves `BENCH_STATIC_DIR` under
 * `/bench/`.
 */
// @effect-diagnostics nodeBuiltinImport:off - benchmark script runs only under Node
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import {
  AuthSessionId,
  WsRemoteControlCancelRpc,
  WsRemoteControlHostAcknowledgeInputRpc,
  WsRemoteControlHostConnectRpc,
  WsRemoteControlHostEndRpc,
  WsRemoteControlHostMediaTicketRpc,
  WsRemoteControlHostPublishFrameRpc,
  WsRemoteControlHostPublishVideoChunkRpc,
  WsRemoteControlHostReportPointerRpc,
  WsRemoteControlHostReportStatusRpc,
  WsRemoteControlHostRespondRpc,
  WsRemoteControlMediaTicketRpc,
  WsRemoteControlRequestAccessRpc,
  WsRemoteControlSendInputRpc,
  WsRemoteControlWatchRpc,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as MediaRelay from "../src/media/MediaRelay.ts";
import { mediaChannelRouteHandler } from "../src/media/mediaChannelRoute.ts";
import * as RemoteControlBroker from "../src/remoteControl/RemoteControlBroker.ts";

const BenchRpcGroup = RpcGroup.make(
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
  WsRemoteControlMediaTicketRpc,
  WsRemoteControlHostMediaTicketRpc,
  WsRemoteControlHostReportPointerRpc,
);

const benchRpcLayer = (
  sessionId: AuthSessionId,
  broker: RemoteControlBroker.RemoteControlBroker["Service"],
) =>
  BenchRpcGroup.toLayer(
    Effect.succeed({
      [WS_METHODS.remoteControlHostConnect]: (input) =>
        Stream.unwrap(broker.connectHost(input, sessionId)),
      [WS_METHODS.remoteControlHostRespond]: (input) => broker.respondToRequest(input, sessionId),
      [WS_METHODS.remoteControlHostPublishFrame]: (input) => broker.publishFrame(input, sessionId),
      [WS_METHODS.remoteControlHostPublishVideoChunk]: (input) =>
        broker.publishVideoChunk(input, sessionId),
      [WS_METHODS.remoteControlHostReportStatus]: (input) =>
        broker.reportHostStatus(input, sessionId),
      [WS_METHODS.remoteControlHostAcknowledgeInput]: (input) =>
        broker.acknowledgeInput(input, sessionId),
      [WS_METHODS.remoteControlHostEnd]: (input) => broker.endByHost(input, sessionId),
      [WS_METHODS.remoteControlRequestAccess]: (input) =>
        broker.requestAccess(input, {
          sessionId,
          subject: "bench-viewer",
          client: { label: "Bench viewer", deviceType: "unknown" },
        }),
      [WS_METHODS.remoteControlWatch]: (input) => Stream.unwrap(broker.watch(input, sessionId)),
      [WS_METHODS.remoteControlSendInput]: (input) => broker.sendInput(input, sessionId),
      [WS_METHODS.remoteControlCancel]: (input) => broker.cancel(input, sessionId),
      [WS_METHODS.remoteControlMediaTicket]: (input) => broker.issueMediaTicket(input, sessionId),
      [WS_METHODS.remoteControlHostMediaTicket]: (input) =>
        broker.issueHostMediaTicket(input, sessionId),
      [WS_METHODS.remoteControlHostReportPointer]: (input) =>
        broker.reportPointer(input, sessionId),
    }),
  );

const rpcRoute = Layer.unwrap(
  Effect.gen(function* () {
    const broker = yield* RemoteControlBroker.RemoteControlBroker;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        const role = Option.isSome(url) ? (url.value.searchParams.get("as") ?? "viewer") : "viewer";
        const sessionId = AuthSessionId.make(role === "host" ? "bench-host" : `bench-${role}`);
        const httpEffect = yield* RpcServer.toHttpEffectWebsocket(BenchRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            benchRpcLayer(sessionId, broker).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
          ),
        );
        return yield* httpEffect;
      }),
    );
  }),
);

const mediaRoute = Layer.unwrap(
  Effect.gen(function* () {
    const relay = yield* MediaRelay.MediaRelay;
    return HttpRouter.add("GET", "/ws/media", mediaChannelRouteHandler(relay));
  }),
);

const staticRoute = HttpRouter.add(
  "GET",
  "/bench/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const root = process.env.BENCH_STATIC_DIR;
    if (Option.isNone(url) || !root) return HttpServerResponse.text("Not Found", { status: 404 });
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const relative = path.normalize(url.value.pathname.replace(/^\/bench\//, ""));
    if (relative.startsWith("..")) return HttpServerResponse.text("Bad Request", { status: 400 });
    const filePath = path.join(root, relative);
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return HttpServerResponse.text("Not Found", { status: 404 });
    const contentType = filePath.endsWith(".html")
      ? "text/html; charset=utf-8"
      : filePath.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "application/octet-stream";
    return yield* HttpServerResponse.file(filePath, {
      headers: { "content-type": contentType, "cache-control": "no-store" },
    }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Error", { status: 500 })));
  }),
);

const announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (address._tag === "TcpAddress") {
      yield* Effect.sync(() => process.stdout.write(`READY ${address.port}\n`));
    }
  }),
);

const main = Layer.mergeAll(
  HttpRouter.serve(Layer.mergeAll(rpcRoute, mediaRoute, staticRoute), { disableLogger: true }),
  announce,
).pipe(
  Layer.provide(RemoteControlBroker.layer),
  Layer.provide(MediaRelay.layer),
  Layer.provideMerge(
    NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: Number(process.env.BENCH_PORT ?? 0),
    }),
  ),
);

NodeRuntime.runMain(Layer.launch(main));

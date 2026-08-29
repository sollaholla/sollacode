/**
 * Real DevTools for a guest running on another machine.
 *
 * The frontend runs in the viewer's own browser and speaks CDP back through
 * here, rather than the guest's machine rendering DevTools and shipping
 * pixels: DevTools is a window beside the page, never inside it, and a
 * screenshot feed of it would be both blurry and slow.
 *
 * The endpoint it reaches is bound to loopback on the guest's machine, which
 * is this machine — the broker gives preview work to the host that owns the
 * environment, and the server runs there too. Two things stand between a
 * caller and that endpoint: T3's own session auth, and the rule that a caller
 * names a thread and a tab while the *host* names the target. The same
 * endpoint exposes the app's own windows, so choosing the target is not a
 * decision a request gets to make.
 */
import { AuthOrchestrationOperateScope, PreviewTabId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { resolveRemotePreviewDevTools } from "./RemotePreviewCapture.ts";
import { devToolsAssetUrl, devToolsCdpUrl } from "./DevToolsProxy.ts";

export const DEVTOOLS_ROUTE_PREFIX = "/preview/devtools";

/**
 * Neither an iframe nor a WebSocket can carry an Authorization header, so both
 * of these routes accept the same short-lived ticket the RPC socket already
 * uses, falling back to header auth for callers that can send one.
 */
const authenticateDevToolsRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
  return session;
});

const requireTarget = (request: HttpServerRequest.HttpServerRequest) => {
  const url = new URL(request.url, "http://localhost");
  const threadId = url.searchParams.get("threadId");
  const tabId = url.searchParams.get("tabId");
  return threadId === null || tabId === null
    ? null
    : { threadId: ThreadId.make(threadId), tabId: PreviewTabId.make(tabId) };
};

/**
 * Streams CDP between the viewer's DevTools frontend and the guest.
 *
 * Nothing is interpreted on the way through. The protocol is Chromium's and
 * changes with it, so a proxy that understood messages would be a proxy that
 * broke on upgrade; the security boundary is which socket this opens, decided
 * before the first frame, not what travels over it.
 */
export const devtoolsSocketRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    return HttpRouter.add(
      "GET",
      `${DEVTOOLS_ROUTE_PREFIX}/cdp`,
      Effect.gen(function* () {
        const session = yield* authenticateDevToolsRequest;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const target = requireTarget(request);
        if (target === null) {
          return HttpServerResponse.text("A thread and tab are required.", { status: 400 });
        }
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        const environmentId = yield* serverEnvironment.getEnvironmentId;
        const issuedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const endpoint = yield* resolveRemotePreviewDevTools({
          broker,
          environmentId,
          sessionId: session.sessionId,
          request: target,
          issuedAt,
        });
        const cdpUrl = devToolsCdpUrl(endpoint);
        if (cdpUrl === null) {
          return HttpServerResponse.text("This guest reported no usable DevTools target.", {
            status: 502,
          });
        }

        const inbound = yield* request.upgrade;
        const outbound = yield* Socket.makeWebSocket(cdpUrl);
        const toGuest = yield* outbound.writer;
        const toViewer = yield* inbound.writer;
        yield* Effect.all(
          [
            inbound.runRaw((message) => toGuest(message)),
            outbound.runRaw((message) => toViewer(message)),
          ],
          { concurrency: 2 },
        );
        return HttpServerResponse.empty();
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
        Effect.tapError((cause) => Effect.logWarning("devtools socket route failed", { cause })),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("DevTools is unavailable for this guest.", { status: 502 }),
        ),
        // Satisfied at the handler, where the outbound socket is opened. Left
        // to the caller it becomes a requirement of the whole server, whose
        // type would then carry a detail of how one route reaches loopback.
        Effect.provide(Socket.layerWebSocketConstructorGlobal),
      ),
    );
  }),
);

/**
 * Serves Chromium's own DevTools frontend through this server.
 *
 * Fetching it from the browser that owns the guest keeps the frontend and the
 * protocol it speaks on the same version, which a bundled copy would not
 * survive an upgrade of.
 */
export const devtoolsAssetRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    return HttpRouter.add(
      "GET",
      `${DEVTOOLS_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        const session = yield* authenticateDevToolsRequest;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const target = requireTarget(request);
        if (target === null) {
          return HttpServerResponse.text("A thread and tab are required.", { status: 400 });
        }
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        const environmentId = yield* serverEnvironment.getEnvironmentId;
        const issuedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const endpoint = yield* resolveRemotePreviewDevTools({
          broker,
          environmentId,
          sessionId: session.sessionId,
          request: target,
          issuedAt,
        });
        const url = new URL(request.url, "http://localhost");
        const assetPath = url.pathname.slice(DEVTOOLS_ROUTE_PREFIX.length);
        const assetUrl = devToolsAssetUrl(endpoint.port, `/devtools${assetPath}`);
        if (assetUrl === null) {
          return HttpServerResponse.text("Not found.", { status: 404 });
        }
        const httpClient = yield* HttpClient.HttpClient;
        const response = yield* httpClient.get(assetUrl);
        const body = yield* response.arrayBuffer;
        return HttpServerResponse.uint8Array(new Uint8Array(body), {
          status: response.status,
          headers: {
            "content-type": response.headers["content-type"] ?? "application/octet-stream",
          },
        });
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
        Effect.tapError((cause) => Effect.logWarning("devtools asset route failed", { cause })),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("DevTools is unavailable for this guest.", { status: 502 }),
        ),
      ),
    );
  }),
);

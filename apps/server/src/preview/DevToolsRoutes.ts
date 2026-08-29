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
import { DEVTOOLS_ROUTE_PREFIX } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
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

/**
 * Neither a framed document nor a WebSocket can carry an Authorization header,
 * so both halves of DevTools authenticate the way a browser does on its own:
 * with the session cookie it already holds for this origin. Callers that can
 * send a header or a ticket still may — this accepts whichever arrives.
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

/** The one path under this prefix that is a socket rather than a file. */
const CDP_ASSET_PATH = "/cdp";

/**
 * Which guest a request is for, and which file of the frontend it wants.
 *
 * Both ride in the path rather than the query because Chromium's frontend
 * references its own assets relatively: the query string is gone by the time
 * the page asks for its first script, and with it any way to know whose
 * DevTools this is. A path prefix is inherited by every sub-resource, so the
 * rule that a caller names a thread and a tab survives the whole page load.
 */
const parseDevToolsRequest = (request: HttpServerRequest.HttpServerRequest) => {
  const url = new URL(request.url, "http://localhost");
  const [, rawThreadId, rawTabId, ...assetSegments] = url.pathname
    .slice(DEVTOOLS_ROUTE_PREFIX.length)
    .split("/");
  if (!rawThreadId || !rawTabId || assetSegments.length === 0) return null;
  let threadId: string;
  let tabId: string;
  try {
    threadId = decodeURIComponent(rawThreadId);
    tabId = decodeURIComponent(rawTabId);
  } catch {
    return null;
  }
  return {
    target: { threadId: ThreadId.make(threadId), tabId: PreviewTabId.make(tabId) },
    // Left percent-encoded: the traversal guard downstream reads it that way.
    assetPath: `/${assetSegments.join("/")}`,
  };
};

/**
 * How long an asset request may reuse the port a previous one resolved.
 *
 * Loading the frontend is roughly 150 requests in a burst, and asking the host
 * which port its debugger is on once per request saturates the broker's queue
 * for that host — every one of them then times out and the frontend never
 * boots. The port belongs to the machine rather than to the guest, so it is
 * safe to reuse; the socket still resolves fresh, because the target it names
 * changes whenever the guest navigates.
 *
 * Nothing races to fill this: the browser cannot ask for an asset until the
 * document naming it has been served, and that request warms the entry.
 */
const ASSET_PORT_CACHE_MS = 60_000;
/** Bounded so a long-lived server cannot accumulate one entry per guest seen. */
const ASSET_PORT_CACHE_LIMIT = 64;

/**
 * Serves Chromium's own DevTools frontend, and streams CDP to the guest.
 *
 * One route because the frontend's own relative asset paths put both under the
 * same prefix; the socket is simply the one path below it that upgrades.
 *
 * The frontend is fetched from the browser that owns the guest rather than
 * bundled, which keeps it and the protocol it speaks on the same version. What
 * travels over the socket is never interpreted: the protocol is Chromium's and
 * changes with it, so a proxy that understood messages would be a proxy that
 * broke on upgrade. The security boundary is which socket this opens, decided
 * before the first frame.
 */
export const devtoolsRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const assetPorts = yield* Ref.make(
      new Map<string, { readonly port: number; readonly expiresAt: number }>(),
    );
    return HttpRouter.add(
      "GET",
      `${DEVTOOLS_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        const session = yield* authenticateDevToolsRequest;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const parsed = parseDevToolsRequest(request);
        if (parsed === null) {
          return HttpServerResponse.text("A thread and tab are required.", { status: 400 });
        }
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        const environmentId = yield* serverEnvironment.getEnvironmentId;
        const issuedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const cacheKey = `${environmentId}|${parsed.target.threadId}|${parsed.target.tabId}`;
        const resolveEndpoint = resolveRemotePreviewDevTools({
          broker,
          environmentId,
          sessionId: session.sessionId,
          request: parsed.target,
          issuedAt,
        });

        if (parsed.assetPath === CDP_ASSET_PATH) {
          const endpoint = yield* resolveEndpoint;
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
        }

        const cached = yield* Ref.get(assetPorts).pipe(
          Effect.map((ports) => {
            const entry = ports.get(cacheKey);
            return entry !== undefined && entry.expiresAt > issuedAt ? entry.port : null;
          }),
        );
        let port = cached;
        if (port === null) {
          port = (yield* resolveEndpoint).port;
          const resolved = port;
          yield* Ref.update(assetPorts, (ports) => {
            const next = ports.size >= ASSET_PORT_CACHE_LIMIT ? new Map() : new Map(ports);
            return next.set(cacheKey, {
              port: resolved,
              expiresAt: issuedAt + ASSET_PORT_CACHE_MS,
            });
          });
        }

        const assetUrl = devToolsAssetUrl(port, `/devtools${parsed.assetPath}`);
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
        Effect.tapError((cause) => Effect.logWarning("devtools route failed", { cause })),
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

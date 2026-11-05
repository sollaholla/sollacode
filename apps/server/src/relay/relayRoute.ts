import { AuthStandardClientScopes, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { RelayedEnvironments } from "./RelayedEnvironments.ts";

/**
 * `/api/relay/<environment id>/<path>` reaches another machine through this
 * host: a phone connected to a Mac opens the Windows machine the Mac's desktop
 * app added. Each request is checked against the caller's session on this
 * host, then sent on with the host's own credential for that machine, so the
 * caller never holds one. The live connection carries a one-time ticket the
 * other machine issued through this route, which is what authorizes it.
 */
export const RELAY_ROUTE_PREFIX = "/api/relay";

export interface RelayRequestPath {
  readonly environmentId: string;
  /** The path on the other machine, always starting with `/`. */
  readonly path: string;
}

export function parseRelayPath(pathname: string): RelayRequestPath | null {
  const prefix = `${RELAY_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const suffix = pathname.slice(prefix.length);
  const separator = suffix.indexOf("/");
  const environmentId = separator < 0 ? suffix : suffix.slice(0, separator);
  if (environmentId.length === 0) return null;
  const path = separator < 0 ? "/" : suffix.slice(separator);
  if (path.split("/").some((segment) => segment === "..")) return null;
  return { environmentId, path };
}

/**
 * Requests that carry their own authority: the public environment descriptor,
 * and signed asset links, which pages load without the session (an artifact
 * frame's opaque origin sends no cookies). They pass through unsigned.
 */
export function relayPathIsPublic(path: string): boolean {
  return path === "/.well-known/t3/environment" || path.startsWith("/api/assets/");
}

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "range",
  "if-none-match",
  "if-modified-since",
  "if-range",
  "traceparent",
  "b3",
] as const;

/** The caller's request headers worth passing on, signed with the host's credential. */
export function relayRequestHeaders(
  incoming: Readonly<Record<string, string | undefined>>,
  bearerToken: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming[name];
    if (value !== undefined) headers[name] = value;
  }
  if (bearerToken !== null) headers.authorization = `Bearer ${bearerToken}`;
  return headers;
}

const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  // The body arrives decoded, and this host compresses its own responses.
  "content-encoding",
  "set-cookie",
  // This host answers CORS for its own origin.
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-expose-headers",
  "access-control-max-age",
]);

/**
 * An artifact's policy names the address the other machine was reached on, but
 * the browser loads the page from this host, under the relay's path. Left alone
 * the policy refuses the page's own files: a video stays black with "Media load
 * rejected by URL safety check". `assetRoot` is where those files really are.
 */
export function relayedContentSecurityPolicy(policy: string, assetRoot: string): string {
  return policy.replaceAll(/https?:\/\/[^\s/]+\/api\/assets\//gu, assetRoot);
}

export function relayResponseHeaders(
  upstream: Readonly<Record<string, string | undefined>>,
  /** Where this machine's assets appear to the browser, through the relay. */
  assetRoot: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers[name] =
        name.toLowerCase() === "content-security-policy"
          ? relayedContentSecurityPolicy(value, assetRoot)
          : value;
    }
  }
  // Decoded bytes no longer match a compressed length. Otherwise it stays:
  // Safari wants it on the byte ranges a video is read in.
  if (upstream["content-encoding"] !== undefined) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "content-length") delete headers[name];
    }
  }
  return headers;
}

/** The same request on the other machine, as HTTP or as its websocket. */
export function relayUpstreamUrl(
  httpBaseUrl: string,
  path: string,
  search: string,
  protocol: "http" | "ws",
): string {
  const url = new URL(httpBaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${path}`;
  url.search = search;
  url.hash = "";
  if (protocol === "ws") url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Relayed requests act with the host's standard grants on the other machine,
 * so only a caller holding all of them here may use the route; anything less
 * would be an escalation.
 */
const authenticateRelayCaller = Effect.fn("relay.authenticateCaller")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  const missing = AuthStandardClientScopes.find((scope) => !session.scopes.includes(scope));
  if (missing !== undefined) return yield* failEnvironmentScopeRequired(missing);
});

const decodeRenewedCredential = Schema.decodeUnknownEffect(
  Schema.Struct({ credential: Schema.String }),
);

class RelayRenewalRefusedError extends Schema.TaggedErrorClass<RelayRenewalRefusedError>()(
  "RelayRenewalRefusedError",
  { status: Schema.Number },
) {}

/** The host's credential lapsed: trade it in once, the way a client reconnecting would. */
export const renewRelayCredential = Effect.fn("relay.renewCredential")(function* (
  httpBaseUrl: string,
  bearerToken: string,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient.execute(
    HttpClientRequest.post(relayUpstreamUrl(httpBaseUrl, "/api/auth/renew", "", "http"), {
      body: HttpBody.jsonUnsafe({ credential: bearerToken }),
    }),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* new RelayRenewalRefusedError({ status: response.status });
  }
  const renewed = yield* decodeRenewedCredential(yield* response.json);
  return renewed.credential;
});

const relayHttp = Effect.fn("relay.http")(function* (
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  environmentId: EnvironmentId,
  path: string,
) {
  const relays = yield* RelayedEnvironments;
  const httpClient = yield* HttpClient.HttpClient;
  const isPublic = relayPathIsPublic(path);
  if (!isPublic) yield* authenticateRelayCaller(request);
  const source = yield* relays.get(environmentId);
  if (Option.isNone(source)) {
    return HttpServerResponse.text("This machine is not shared here anymore.", { status: 404 });
  }

  const upstreamUrl = relayUpstreamUrl(source.value.httpBaseUrl, path, url.search, "http");
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : new Uint8Array(yield* request.arrayBuffer);
  const send = (bearerToken: string | null) =>
    httpClient.execute(
      HttpClientRequest.make(request.method)(upstreamUrl, {
        headers: relayRequestHeaders(request.headers, bearerToken),
        ...(body === null
          ? {}
          : { body: HttpBody.uint8Array(body, request.headers["content-type"]) }),
      }),
    );

  let response = yield* send(isPublic ? null : source.value.bearerToken);
  if (!isPublic && response.status === 401) {
    const renewed = yield* renewRelayCredential(
      source.value.httpBaseUrl,
      source.value.bearerToken,
    ).pipe(Effect.option);
    if (Option.isSome(renewed)) {
      yield* relays.renewToken(environmentId, source.value.bearerToken, renewed.value);
      response = yield* send(renewed.value);
    }
  }

  const headers = relayResponseHeaders(
    response.headers,
    `${url.origin}/api/relay/${environmentId}/api/assets/`,
  );
  if (request.method === "HEAD" || response.status === 204 || response.status === 304) {
    return HttpServerResponse.empty({ status: response.status, headers });
  }
  return HttpServerResponse.stream(response.stream, { status: response.status, headers });
});

/**
 * Carries frames both ways, in order, until either side closes. Incoming
 * frames are queued synchronously: socket handlers run in their own fibers, so
 * writing from inside them could reorder a burst.
 */
export const pipeSockets = (left: Socket.Socket, right: Socket.Socket) =>
  Effect.scoped(
    Effect.gen(function* () {
      const writeLeft = yield* left.writer;
      const writeRight = yield* right.writer;
      const toLeft = yield* Queue.unbounded<string | Uint8Array>();
      const toRight = yield* Queue.unbounded<string | Uint8Array>();
      yield* Queue.take(toRight).pipe(
        Effect.flatMap(writeRight),
        Effect.forever,
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* Queue.take(toLeft).pipe(
        Effect.flatMap(writeLeft),
        Effect.forever,
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* Effect.raceFirst(
        left.runRaw((data) => {
          Queue.offerUnsafe(toRight, data);
        }),
        right.runRaw((data) => {
          Queue.offerUnsafe(toLeft, data);
        }),
      ).pipe(Effect.ignore);
    }),
  );

const relayWebSocket = Effect.fn("relay.websocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  environmentId: EnvironmentId,
) {
  const relays = yield* RelayedEnvironments;
  if (!url.searchParams.get("wsTicket")) {
    return HttpServerResponse.text("A websocket ticket is required.", { status: 401 });
  }
  const source = yield* relays.get(environmentId);
  if (Option.isNone(source)) {
    return HttpServerResponse.text("This machine is not shared here anymore.", { status: 404 });
  }
  const upstream = yield* Socket.makeWebSocket(
    relayUpstreamUrl(source.value.httpBaseUrl, "/ws", url.search, "ws"),
    { openTimeout: "10 seconds" },
  );
  const client = yield* request.upgrade;
  yield* pipeSockets(client, upstream);
  return HttpServerResponse.empty();
});

export const relayRouteLayer = HttpRouter.add(
  "*",
  `${RELAY_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const parsed = Option.isSome(url) ? parseRelayPath(url.value.pathname) : null;
    if (Option.isNone(url) || parsed === null) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const environmentId = EnvironmentId.make(parsed.environmentId);
    if (
      parsed.path === "/ws" &&
      request.method === "GET" &&
      request.headers.upgrade?.toLowerCase() === "websocket"
    ) {
      return yield* relayWebSocket(request, url.value, environmentId);
    }
    return yield* relayHttp(request, url.value, environmentId, parsed.path);
  }).pipe(
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
    Effect.catch((cause) =>
      Effect.logWarning("Relayed request failed.", { cause }).pipe(
        Effect.as(
          HttpServerResponse.text("The other machine could not be reached.", { status: 502 }),
        ),
      ),
    ),
  ),
);

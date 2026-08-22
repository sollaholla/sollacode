import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeTimersPromises from "node:timers/promises";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";
export const DESKTOP_PRODUCTION_SCHEME = "sollacode";
export const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";
export const DESKTOP_REMOTE_ASSET_PROXY_PATH = "/__solla/remote-asset";
export const DESKTOP_REMOTE_ARTIFACT_PROXY_PATH = "/__solla/remote-artifact";
export const DESKTOP_REMOTE_ASSET_CACHE_CONTROL = "private, max-age=300, immutable";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedErrorClass<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedErrorClass<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

export interface DesktopProtocolRegistrationInput {
  readonly scheme: string;
  readonly targetOrigin: URL;
  readonly backendOrigin: URL;
}

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronProtocol") {}

export function makeDesktopContentSecurityPolicy(input: DesktopProtocolRegistrationInput): string {
  // Chromium does not consistently treat Electron custom schemes as matching
  // `'self'` unless they are registered as privileged before app startup. Keep
  // executable resources constrained to our app-controlled scheme; the
  // protocol handler below additionally rejects every host except `app`.
  const appSchemeSource = `${input.scheme}:`;
  const scriptSources = [
    "'self'",
    appSchemeSource,
    "'unsafe-inline'",
    // Required for locally bundled ONNX Runtime WebAssembly compilation.
    // This does not permit JavaScript string evaluation like `'unsafe-eval'`.
    "'wasm-unsafe-eval'",
  ];

  // The renderer connects directly to user-configured environments in addition to
  // the local backend. Those environment origins are not known when this response
  // policy is created, so restrict connections by supported network schemes.
  const connectSources = ["'self'", "http:", "https:", "ws:", "wss:"];

  return [
    `default-src 'self' ${appSchemeSource}`,
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${appSchemeSource} blob: data: http: https:`,
    `style-src 'self' ${appSchemeSource} 'unsafe-inline'`,
    `font-src 'self' ${appSchemeSource} data:`,
    `worker-src 'self' ${appSchemeSource} blob:`,
    `frame-src 'self' ${appSchemeSource}`,
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withRemoteAssetCachePolicy(response: Response, requestUrl: URL): Response {
  const revision = requestUrl.searchParams.get("solla_revision")?.trim();
  if (!revision) return response;

  const headers = new Headers(response.headers);
  // The host correctly marks workspace files as no-store because a path is
  // mutable. The renderer adds a content revision to remote previews, making
  // that proxy URL immutable for a short window while a new message/revision
  // naturally produces a different cache key.
  headers.set("Cache-Control", DESKTOP_REMOTE_ASSET_CACHE_CONTROL);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function resolveRemoteAssetProxyTarget(requestUrl: URL): URL | null {
  if (requestUrl.pathname !== DESKTOP_REMOTE_ASSET_PROXY_PATH) return null;

  const targetValue = requestUrl.searchParams.get("url");
  if (!targetValue) return null;

  try {
    const target = new URL(targetValue);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username.length > 0 ||
      target.password.length > 0 ||
      !target.pathname.startsWith("/api/assets/")
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.toString("base64url") === value ? bytes.toString("utf8") : null;
  } catch {
    return null;
  }
}

function artifactProxyParts(
  requestUrl: URL,
): { readonly encodedRoot: string; readonly relativePath: string } | null {
  const prefix = `${DESKTOP_REMOTE_ARTIFACT_PROXY_PATH}/`;
  if (!requestUrl.pathname.startsWith(prefix)) return null;
  const suffix = requestUrl.pathname.slice(prefix.length);
  const separatorIndex = suffix.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === suffix.length - 1) return null;
  return {
    encodedRoot: suffix.slice(0, separatorIndex),
    relativePath: suffix.slice(separatorIndex + 1),
  };
}

/** Resolve one relative artifact bundle request without granting general proxy access. */
export function resolveRemoteArtifactProxyTarget(requestUrl: URL): URL | null {
  const parts = artifactProxyParts(requestUrl);
  if (parts === null) return null;
  const rootValue = decodeBase64Url(parts.encodedRoot);
  if (rootValue === null) return null;

  try {
    const root = new URL(rootValue);
    if (
      (root.protocol !== "http:" && root.protocol !== "https:") ||
      root.username.length > 0 ||
      root.password.length > 0 ||
      !/^\/api\/assets\/[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+\/$/u.test(root.pathname) ||
      root.search.length > 0 ||
      root.hash.length > 0
    ) {
      return null;
    }

    const target = new URL(parts.relativePath, root);
    target.search = requestUrl.search;
    if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname)) return null;
    return target;
  } catch {
    return null;
  }
}

function makeDesktopArtifactContentSecurityPolicy(requestUrl: URL): string {
  const parts = artifactProxyParts(requestUrl);
  const revisionSource =
    parts === null
      ? "'none'"
      : `${requestUrl.protocol}//${requestUrl.host}${DESKTOP_REMOTE_ARTIFACT_PROXY_PATH}/${parts.encodedRoot}/`;
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'none'",
    `font-src ${revisionSource} data:`,
    "form-action 'none'",
    "frame-src 'none'",
    `img-src ${revisionSource} data: blob:`,
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src ${revisionSource} 'unsafe-inline'`,
    `style-src ${revisionSource} 'unsafe-inline'`,
    "worker-src 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}

function remoteAssetRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ["accept", "accept-language", "if-modified-since", "if-none-match", "range"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

async function proxyRequest(
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }

  if (requestUrl.pathname === DESKTOP_REMOTE_ASSET_PROXY_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405 });
    }
    const remoteAssetUrl = resolveRemoteAssetProxyTarget(requestUrl);
    if (remoteAssetUrl === null) {
      return new Response(null, { status: 400 });
    }
    const response = await fetchWithTransientRetry(remoteAssetUrl.toString(), {
      method: request.method,
      headers: remoteAssetRequestHeaders(request),
      redirect: "error",
    });
    return withContentSecurityPolicy(
      withRemoteAssetCachePolicy(response, requestUrl),
      contentSecurityPolicy,
    );
  }

  if (requestUrl.pathname.startsWith(`${DESKTOP_REMOTE_ARTIFACT_PROXY_PATH}/`)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405 });
    }
    const remoteArtifactUrl = resolveRemoteArtifactProxyTarget(requestUrl);
    if (remoteArtifactUrl === null) {
      return new Response(null, { status: 400 });
    }
    const response = await fetchWithTransientRetry(remoteArtifactUrl.toString(), {
      method: request.method,
      headers: remoteAssetRequestHeaders(request),
      redirect: "error",
    });
    return withContentSecurityPolicy(
      response,
      makeDesktopArtifactContentSecurityPolicy(requestUrl),
    );
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);
  const headersToRemove: string[] = [];
  for (const name of headers.keys()) {
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headersToRemove.push(name);
    }
  }
  for (const name of headersToRemove) {
    headers.delete(name);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? await fetchWithTransientRetry(targetUrl.toString(), init)
      : await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [0, 50, 150] as const;

async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (const delayMs of TRANSIENT_FETCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await NodeTimersPromises.setTimeout(delayMs);
    }

    try {
      return await Electron.net.fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export const make = Effect.gen(function* () {
  const registered = yield* Ref.make(false);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, (request) =>
              proxyRequest(request, input.targetOrigin, contentSecurityPolicy),
            );
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({
                scheme: input.scheme,
                cause,
              }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);

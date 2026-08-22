import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ORCHESTRATOR_REALTIME_TOKEN_PATH,
  ORCHESTRATOR_RUN_COMMAND_PATH,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as HttpResponseCompression from "./httpCompression/HttpResponseCompression.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as OrchestratorCredentials from "./orchestrator/OrchestratorCredentials.ts";
import * as ReadOnlyCommand from "./orchestrator/readOnlyCommand.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as Duration from "effect/Duration";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ServerSettings from "./serverSettings.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
const GZIP_MIN_BYTES = 1024;
export const MUTABLE_ASSET_CACHE_CONTROL = "private, no-store, max-age=0";
export const REVISIONED_ASSET_CACHE_CONTROL = "private, max-age=300, immutable";
export const STATIC_HTML_CACHE_CONTROL = "no-store, max-age=0";
export const STATIC_BUNDLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const STATIC_FILE_CACHE_CONTROL = "no-cache";

export function assetCacheControlForUrl(url: URL): string {
  return url.searchParams.get("solla_revision")?.trim()
    ? REVISIONED_ASSET_CACHE_CONTROL
    : MUTABLE_ASSET_CACHE_CONTROL;
}

const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
export function artifactResponseHeaders(url: URL): Record<string, string> {
  const suffix = url.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  const token = suffix.slice(0, suffix.indexOf("/"));
  // A sandbox without allow-same-origin has an opaque origin, so `self` is not
  // a reliable source for sibling scripts and styles. Authorize only this
  // signed revision capability instead; relative bundle files still load,
  // while arbitrary same-origin app/API resources remain unreachable.
  const revisionSource = /^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/u.test(token)
    ? `${url.origin}${ASSET_ROUTE_PREFIX}/${token}/`
    : "'none'";
  const contentSecurityPolicy = [
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
  return {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "private, max-age=3600, immutable",
    "Content-Security-Policy": contentSecurityPolicy,
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), bluetooth=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

/**
 * An SVG is a document, not merely an image: it can carry inline script and
 * fetch external references. Serving a user-supplied one from the app's own
 * origin therefore hands an attacker same-origin execution — a stored-XSS
 * vector through anything that can be attached to a thread.
 *
 * Both delivery paths have to be covered. Assets read from disk are recognised
 * by extension; assets already in memory only carry a content type.
 */
function isSvgAsset(path: string | undefined, contentType: string | undefined): boolean {
  if (path !== undefined && path.toLowerCase().endsWith(".svg")) return true;
  return contentType !== undefined && contentType.toLowerCase().includes("image/svg+xml");
}

/**
 * Headers for one workspace asset.
 *
 * Cache-Control stays derived from the URL rather than the file path:
 * unversioned workspace paths must remain no-store, and only a revision-keyed
 * URL may be treated as immutable.
 */
export function assetResponseHeaders(input: {
  readonly url: URL;
  readonly path?: string;
  readonly contentType?: string;
}): Record<string, string> {
  return {
    // Unversioned workspace paths remain no-store. Remote/client previews
    // attach the message/activity revision, producing an immutable cache key
    // that changes when a newer result references the same filename.
    "Cache-Control": assetCacheControlForUrl(input.url),
    "X-Content-Type-Options": "nosniff",
    ...(isSvgAsset(input.path, input.contentType)
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

function staticCacheControlForPath(relativePath: string): string {
  if (relativePath === "index.html" || relativePath.endsWith("/index.html")) {
    return STATIC_HTML_CACHE_CONTROL;
  }
  if (relativePath === "assets" || relativePath.startsWith("assets/")) {
    return STATIC_BUNDLE_CACHE_CONTROL;
  }
  return STATIC_FILE_CACHE_CONTROL;
}

function acceptsGzip(value: string | undefined): boolean {
  if (!value) return false;

  const accepted = new Map(
    value.split(",").map((entry) => {
      const [coding = "", ...parameters] = entry.trim().toLowerCase().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim().match(/^q=(.+)$/)?.[1])
        .find((parameter) => parameter !== undefined);
      return [coding, quality === undefined ? 1 : Number(quality)] as const;
    }),
  );
  return (accepted.get("gzip") ?? accepted.get("*") ?? 0) > 0;
}

function varyByAcceptEncoding(value: string | undefined): string {
  if (!value) return "Accept-Encoding";
  const values = new Set(value.split(",").map((entry) => entry.trim().toLowerCase()));
  return values.has("*") || values.has("accept-encoding") ? value : `${value}, Accept-Encoding`;
}

const compressHttpResponse = Effect.fnUntraced(function* (
  response: HttpServerResponse.HttpServerResponse,
  acceptEncoding: string | undefined,
) {
  const body = response.body;
  if (
    body._tag !== "Uint8Array" ||
    body.contentLength < GZIP_MIN_BYTES ||
    !body.contentType.startsWith("application/json") ||
    response.headers["content-encoding"]
  ) {
    return response;
  }

  const variedResponse = HttpServerResponse.setHeader(
    response,
    "vary",
    varyByAcceptEncoding(response.headers.vary),
  );
  if (!acceptsGzip(acceptEncoding)) return variedResponse;

  const compression = yield* HttpResponseCompression.HttpResponseCompression;
  const headers = Headers.set(
    Headers.remove(variedResponse.headers, "content-length"),
    "content-encoding",
    "gzip",
  );
  return compression.gzip(body.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    cookies: response.cookies,
    contentType: body.contentType,
  });
});

export const httpCompressionLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(
      Effect.all([httpEffect, HttpServerRequest.HttpServerRequest]),
      ([response, request]) => compressHttpResponse(response, request.headers["accept-encoding"]),
    ),
  { global: true },
);

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    //
    // T3CODE_DEV_ALLOWED_ORIGINS covers dev servers reached from a second
    // origin — a tailnet name, a LAN IP, a phone. Browser dev normally proxies
    // through Vite and is same-origin (no preflight at all), so this is a
    // safety net for the desktop renderer and any direct-to-backend caller.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * Mints an ephemeral realtime client secret for the voice orchestrator.
 *
 * The stored API key never crosses this boundary — the response carries only a
 * short-lived token, so a leaked one expires on its own and cannot be used to
 * bill the account indefinitely. The backend is Settings → Orchestrator →
 * Voice provider: OpenAI Realtime or Grok Voice (xAI).
 */
export const orchestratorRealtimeTokenRouteLayer = HttpRouter.add(
  "POST",
  ORCHESTRATOR_REALTIME_TOKEN_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const settings = yield* settingsService.getSettings;

    if (!settings.orchestrator.enabled) {
      return HttpServerResponse.text("The orchestrator is disabled.", { status: 409 });
    }

    const provider = settings.orchestrator.provider;

    return yield* OrchestratorCredentials.mintRealtimeToken({
      provider,
      model: settings.orchestrator.model,
      voice: settings.orchestrator.voice,
    }).pipe(
      // The only positive record of which model a voice session actually ran
      // on. Settings are read here, at mint time, so an edit reaches the next
      // session rather than a running one — this line is what lets that be
      // checked after the fact instead of inferred.
      Effect.tap((token) =>
        Effect.logInfo("orchestrator realtime session minted", {
          provider: token.provider,
          transport: token.transport,
          model: token.model,
          voice: token.voice,
          configuredModel: settings.orchestrator.model,
          authority: settings.orchestrator.authority,
        }),
      ),
      Effect.map((token) =>
        HttpServerResponse.jsonUnsafe({
          value: token.value,
          model: token.model,
          voice: token.voice,
          provider: token.provider,
          transport: token.transport,
          ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
          ...(token.realtimeUrl === undefined ? {} : { realtimeUrl: token.realtimeUrl }),
        }),
      ),
      Effect.catchTag("OrchestratorApiKeyMissingError", () =>
        Effect.succeed(
          HttpServerResponse.text("No orchestrator API key is configured.", { status: 409 }),
        ),
      ),
      Effect.catchTag("OrchestratorTokenMintError", (error) =>
        // The detail comes from the voice backend and may name the account;
        // log it, but return something generic so it does not surface in the
        // renderer. The one exception is a spent balance: that names nothing
        // sensitive, is the only thing the user can actually act on, and
        // reading as a generic failure sent them debugging the app instead of
        // their billing.
        Effect.logWarning("orchestrator realtime token mint failed", {
          provider,
          status: error.status,
          detail: error.detail,
        }).pipe(
          Effect.as(
            OrchestratorCredentials.isQuotaExhausted(error.status, error.detail)
              ? HttpServerResponse.text(
                  OrchestratorCredentials.describeMintFailure(error.detail) ??
                    OrchestratorCredentials.quotaExhaustedMessage(provider),
                  { status: 402 },
                )
              : HttpServerResponse.text("Could not start a voice session.", { status: 502 }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      ServerSettingsError: (error) =>
        Effect.logWarning("orchestrator settings unavailable", { cause: error }).pipe(
          Effect.as(HttpServerResponse.text("Settings unavailable.", { status: 500 })),
        ),
    }),
  ),
);

/**
 * Runs one command on the host and returns its output to the voice orchestrator.
 *
 * Through a shell deliberately: pipes and globs are most of what makes looking
 * around a machine practical, and refusing them pushed the model into
 * contortions that were harder to reason about than the shell itself. Read-only
 * is instructed rather than enforced — `assessCommand` blocks only the handful
 * of irreversible actions that a mis-transcribed sentence could otherwise
 * trigger.
 */
export const orchestratorRunCommandRouteLayer = HttpRouter.add(
  "POST",
  ORCHESTRATOR_RUN_COMMAND_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const settings = yield* settingsService.getSettings;
    if (!settings.orchestrator.enabled) {
      return HttpServerResponse.text("The orchestrator is disabled.", { status: 409 });
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed({})));
    const payload = (body ?? {}) as Record<string, unknown>;
    const command = typeof payload.command === "string" ? payload.command : "";
    const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : undefined;

    const verdict = ReadOnlyCommand.assessCommand(command);
    if (!verdict.ok) {
      // 200 with a refusal rather than an error status: this is an answer the
      // model has to relay, not a transport failure it should retry.
      return HttpServerResponse.jsonUnsafe({ refused: true, reason: verdict.reason });
    }

    // Constructed here rather than taken from context: this is the only route
    // that runs a process, and threading the service through the whole server
    // layer graph for it made every unrelated bootstrap require it too.
    const runner = yield* ProcessRunner.make();
    const platform = yield* HostProcessPlatform;
    const windows = platform === "win32";

    return yield* runner
      .run({
        command: windows ? "cmd" : "/bin/sh",
        args: windows ? ["/c", command] : ["-lc", command],
        ...(cwd === undefined ? {} : { cwd }),
        timeout: Duration.millis(ReadOnlyCommand.COMMAND_TIMEOUT_MS),
        maxOutputBytes: ReadOnlyCommand.COMMAND_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((result) =>
          HttpServerResponse.jsonUnsafe({
            refused: false,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.code,
            timedOut: result.timedOut,
            truncated: result.stdoutTruncated || result.stderrTruncated,
          }),
        ),
        // A command that fails is a normal outcome to report, not a route
        // error: the model needs the message so it can say what went wrong.
        Effect.catch((cause) =>
          Effect.logWarning("orchestrator command failed", { cause }).pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe({
                refused: false,
                stdout: "",
                stderr: "The command could not be run.",
                exitCode: null,
                timedOut: false,
                truncated: false,
              }),
            ),
          ),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      ServerSettingsError: (error) =>
        Effect.logWarning("orchestrator settings unavailable", { cause: error }).pipe(
          Effect.as(HttpServerResponse.text("Settings unavailable.", { status: 500 })),
        ),
    }),
  ),
);

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const responseOptions = {
      status: 200,
      headers:
        asset.kind === "file" && asset.artifact
          ? artifactResponseHeaders(url.value)
          : assetResponseHeaders({
              url: url.value,
              ...(asset.kind === "bytes"
                ? { contentType: asset.contentType }
                : { path: asset.path }),
            }),
    } as const;
    if (asset.kind === "bytes") {
      return HttpServerResponse.uint8Array(asset.bytes, {
        ...responseOptions,
        contentType: asset.contentType,
      });
    }
    return yield* HttpServerResponse.file(asset.path, responseOptions).pipe(
      Effect.map((response) =>
        asset.contentType
          ? HttpServerResponse.setHeader(response, "content-type", asset.contentType)
          : response,
      ),
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const requestedExtension = path.extname(filePath);
    if (!requestedExtension) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      // A missing browser asset must remain a real 404. Falling through to the
      // SPA shell returns text/html for a retired JavaScript URL, so Safari
      // rejects the module and leaves the static boot logo on screen forever.
      if (requestedExtension) {
        return HttpServerResponse.text("Not Found", {
          status: 404,
          headers: {
            "Cache-Control": STATIC_HTML_CACHE_CONTROL,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "Cache-Control": STATIC_HTML_CACHE_CONTROL,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
      headers: {
        "Cache-Control": staticCacheControlForPath(staticRelativePath),
        "X-Content-Type-Options": "nosniff",
      },
    });
  }),
);

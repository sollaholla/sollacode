import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    unhandleMock.mockReset();
  });

  it.effect("proxies the stable renderer origin to the current app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3774/"),
          });
          assert.isDefined(handler);

          const response = yield* Effect.promise(() =>
            handler!(
              new Request("t3code-dev://app/api/health?verbose=1", {
                headers: {
                  accept: "application/json",
                  origin: "t3code-dev://app",
                  referer: "t3code-dev://app/",
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' t3code-dev: 'unsafe-inline' 'wasm-unsafe-eval'",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "connect-src 'self' http: https: ws: wss:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "img-src 'self' t3code-dev: blob: data: http: https:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "font-src 'self' t3code-dev: data:",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["t3code-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      const forwardedHeaders = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("accept"), "application/json");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("referer"));
      assert.isNull(forwardedHeaders.get("sec-fetch-site"));
      assert.deepEqual(unhandleMock.mock.calls, [["t3code-dev"]]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("rejects custom protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
          });
          return yield* Effect.promise(() => handler!(new Request("t3code://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("loads signed remote assets through Electron without renderer network policy", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(
        new Response("image-bytes", {
          headers: { "content-type": "image/png" },
        }),
      );

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "sollacode",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
          });
          const target = encodeURIComponent(
            "http://192.0.2.10:3773/api/assets/signed-token/check_knuckle.png",
          );
          return yield* Effect.promise(() =>
            handler!(
              new Request(
                `sollacode://app${ElectronProtocol.DESKTOP_REMOTE_ASSET_PROXY_PATH}?url=${target}&solla_revision=assistant-message-42`,
                {
                  headers: {
                    accept: "image/avif,image/webp,image/*",
                    authorization: "Bearer must-not-leak",
                    cookie: "session=must-not-leak",
                  },
                },
              ),
            ),
          );
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "image-bytes");
      assert.equal(
        netFetchMock.mock.calls[0]?.[0],
        "http://192.0.2.10:3773/api/assets/signed-token/check_knuckle.png",
      );
      const init = netFetchMock.mock.calls[0]?.[1];
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("accept"), "image/avif,image/webp,image/*");
      assert.isNull(headers.get("authorization"));
      assert.isNull(headers.get("cookie"));
      assert.equal(init?.redirect, "error");
      assert.equal(
        response.headers.get("cache-control"),
        ElectronProtocol.DESKTOP_REMOTE_ASSET_CACHE_CONTROL,
      );
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("keeps artifact bundle CSS on the signed remote revision", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          new Response(
            url.endsWith(".css") ? "body{color:gold}" : "<link rel=stylesheet href=styles.css>",
            {
              headers: {
                "access-control-allow-origin": "*",
                "content-type": url.endsWith(".css") ? "text/css" : "text/html",
              },
            },
          ),
        ),
      );

      const signedRoot = "http://192.0.2.10:3773/api/assets/payload.signature/";
      const encodedRoot = Buffer.from(signedRoot).toString("base64url");
      const entryUrl = new URL(
        `sollacode://app${ElectronProtocol.DESKTOP_REMOTE_ARTIFACT_PROXY_PATH}/${encodedRoot}/site/index.html`,
      );
      const styleUrl = new URL("styles.css", entryUrl);

      const [entryResponse, styleResponse] = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "sollacode",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
          });
          return yield* Effect.promise(() =>
            Promise.all([handler!(new Request(entryUrl)), handler!(new Request(styleUrl))]),
          );
        }),
      );

      assert.equal(
        yield* Effect.promise(() => entryResponse.text()),
        "<link rel=stylesheet href=styles.css>",
      );
      assert.equal(yield* Effect.promise(() => styleResponse.text()), "body{color:gold}");
      assert.deepEqual(
        netFetchMock.mock.calls.map((call) => call[0]),
        [
          "http://192.0.2.10:3773/api/assets/payload.signature/site/index.html",
          "http://192.0.2.10:3773/api/assets/payload.signature/site/styles.css",
        ],
      );
      const policy = entryResponse.headers.get("content-security-policy") ?? "";
      assert.include(policy, "connect-src 'none'");
      assert.include(
        policy,
        `style-src sollacode://app${ElectronProtocol.DESKTOP_REMOTE_ARTIFACT_PROXY_PATH}/${encodedRoot}/ 'unsafe-inline'`,
      );
      assert.notInclude(policy, "style-src sollacode: 'unsafe-inline'");
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it("rejects artifact bundle targets outside one signed asset capability", () => {
    const signedRoot = "https://environment.example/api/assets/payload.signature/";
    const encodedRoot = Buffer.from(signedRoot).toString("base64url");
    const entry = new URL(
      `sollacode://app${ElectronProtocol.DESKTOP_REMOTE_ARTIFACT_PROXY_PATH}/${encodedRoot}/nested/index.html`,
    );
    assert.equal(
      ElectronProtocol.resolveRemoteArtifactProxyTarget(entry)?.toString(),
      "https://environment.example/api/assets/payload.signature/nested/index.html",
    );
    assert.isNull(
      ElectronProtocol.resolveRemoteArtifactProxyTarget(
        new URL(
          `sollacode://app${ElectronProtocol.DESKTOP_REMOTE_ARTIFACT_PROXY_PATH}/${Buffer.from("https://environment.example/api/auth/").toString("base64url")}/session`,
        ),
      ),
    );
  });

  it("rejects malformed and non-asset remote proxy targets", () => {
    assert.isNull(
      ElectronProtocol.resolveRemoteAssetProxyTarget(
        new URL("sollacode://app/__solla/remote-asset?url=not-a-url"),
      ),
    );
    assert.isNull(
      ElectronProtocol.resolveRemoteAssetProxyTarget(
        new URL(
          "sollacode://app/__solla/remote-asset?url=https%3A%2F%2Fexample.com%2Fapi%2Fauth%2Fsession",
        ),
      ),
    );
    assert.isNull(
      ElectronProtocol.resolveRemoteAssetProxyTarget(
        new URL(
          "sollacode://app/__solla/remote-asset?url=https%3A%2F%2Fuser%3Asecret%40example.com%2Fapi%2Fassets%2Ftoken%2Fimage.png",
        ),
      ),
    );
  });

  it.effect("retries transient renderer target failures", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733"))
        .mockResolvedValueOnce(new Response("ready"));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
          });
          return yield* Effect.promise(() => handler!(new Request("t3code-dev://app/")));
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol registration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const error = yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "t3code-dev",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          backendOrigin: new URL("http://127.0.0.1:3774/"),
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "t3code-dev");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to register Electron protocol scheme "t3code-dev".');
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol unregistration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol unregistration failed");
      unhandleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const exit = yield* Effect.exit(
        Effect.scoped(
          protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
          }),
        ),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronProtocol.ElectronProtocolUnregistrationError);
        assert.equal(error.scheme, "t3code");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, 'Failed to unregister Electron protocol scheme "t3code".');
      }
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it("allows app-controlled custom-scheme assets while allowing runtime network resources", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "sollacode",
      targetOrigin: new URL("http://127.0.0.1:3773/"),
      backendOrigin: new URL("http://127.0.0.1:3773/"),
    });
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );

    assert.deepEqual(directives["script-src"], [
      "'self'",
      "sollacode:",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
    ]);
    assert.deepEqual(directives["connect-src"], ["'self'", "http:", "https:", "ws:", "wss:"]);
    assert.deepEqual(directives["img-src"], [
      "'self'",
      "sollacode:",
      "blob:",
      "data:",
      "http:",
      "https:",
    ]);
    assert.deepEqual(directives["style-src"], ["'self'", "sollacode:", "'unsafe-inline'"]);
    assert.deepEqual(directives["font-src"], ["'self'", "sollacode:", "data:"]);
  });
});

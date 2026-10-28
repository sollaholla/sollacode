import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/unstable/http";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RelayedEnvironments from "./RelayedEnvironments.ts";
import {
  parseRelayPath,
  relayPathIsPublic,
  relayRequestHeaders,
  relayResponseHeaders,
  relayRouteLayer,
  relayUpstreamUrl,
} from "./relayRoute.ts";

const windows = EnvironmentId.make("windows-env");

describe("relay paths", () => {
  it("splits the machine from the path it asks for", () => {
    expect(parseRelayPath("/api/relay/windows-env/api/orchestration/shell")).toEqual({
      environmentId: "windows-env",
      path: "/api/orchestration/shell",
    });
    expect(parseRelayPath("/api/relay/windows-env")).toEqual({
      environmentId: "windows-env",
      path: "/",
    });
    expect(parseRelayPath("/api/relay/")).toBeNull();
    expect(parseRelayPath("/api/assets/x")).toBeNull();
  });

  it("lets only the descriptor and signed asset links through unsigned", () => {
    expect(relayPathIsPublic("/.well-known/t3/environment")).toBe(true);
    expect(relayPathIsPublic("/api/assets/token.sig/index.html")).toBe(true);
    expect(relayPathIsPublic("/api/auth/websocket-ticket")).toBe(false);
    expect(relayPathIsPublic("/api/orchestration/shell")).toBe(false);
  });

  it("signs with the host's credential and never forwards the caller's", () => {
    expect(
      relayRequestHeaders(
        { authorization: "Bearer caller", cookie: "session=caller", range: "bytes=0-9" },
        "host-token",
      ),
    ).toEqual({ authorization: "Bearer host-token", range: "bytes=0-9" });
    expect(relayRequestHeaders({ authorization: "Bearer caller" }, null)).toEqual({});
  });

  it("drops cookies and encodings the relay cannot vouch for", () => {
    expect(
      relayResponseHeaders({
        "content-type": "application/json",
        "content-encoding": "gzip",
        "set-cookie": "a=b",
        "content-range": "bytes 0-9/100",
      }),
    ).toEqual({ "content-type": "application/json", "content-range": "bytes 0-9/100" });
  });

  it("addresses the same path on the other machine, as HTTP or websocket", () => {
    expect(relayUpstreamUrl("http://10.0.0.5:3773/", "/api/x", "?a=1", "http")).toBe(
      "http://10.0.0.5:3773/api/x?a=1",
    );
    expect(relayUpstreamUrl("https://win.ts.net/", "/ws", "?wsTicket=t", "ws")).toBe(
      "wss://win.ts.net/ws?wsTicket=t",
    );
  });
});

/** A host whose caller authenticates with `Bearer caller-<scopes>` and a fake other machine. */
function relayFixture(
  answer: (request: HttpClientRequest.HttpClientRequest) => Response,
  options?: { readonly sharing?: boolean },
) {
  const upstream: Array<HttpClientRequest.HttpClientRequest> = [];
  const relays = Layer.effect(
    RelayedEnvironments.RelayedEnvironments,
    Effect.gen(function* () {
      const service = yield* RelayedEnvironments.make;
      yield* service.publish([
        {
          environmentId: windows,
          label: "Windows",
          httpBaseUrl: "http://10.0.0.5:3773/",
          bearerToken: "host-token",
        },
      ]);
      return service;
    }),
  ).pipe(
    Layer.provide(ServerSettings.layerTest({ shareConnectedComputers: options?.sharing ?? true })),
  );
  const dependencies = Layer.mergeAll(
    relays,
    Layer.mock(EnvironmentAuth)({
      authenticateHttpRequest: (request) => {
        const authorization = request.headers.authorization ?? "";
        if (!authorization.startsWith("Bearer caller")) {
          return Effect.fail(new ServerAuthMissingCredentialError());
        }
        return Effect.succeed({
          sessionId: AuthSessionId.make("relay-caller"),
          subject: "phone",
          method: "bearer-access-token",
          scopes: authorization.endsWith("read-only")
            ? [AuthOrchestrationReadScope]
            : [...AuthStandardClientScopes],
        });
      },
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        upstream.push(request);
        return Effect.succeed(HttpClientResponse.fromWeb(request, answer(request)));
      }),
    ),
  );
  const app = HttpRouter.toWebHandler(
    relayRouteLayer.pipe(HttpRouter.provideRequest(dependencies)),
    {
      disableLogger: true,
    },
  );
  const call = (path: string, init?: RequestInit) =>
    app.handler(new Request(`http://mac.test/api/relay/${path}`, init));
  return { app, call, upstream };
}

describe("relay route", () => {
  it("forwards a signed-in caller's request with the host's credential", async () => {
    const { app, call, upstream } = relayFixture(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      const response = await call("windows-env/api/orchestration/shell?after=3", {
        headers: { authorization: "Bearer caller" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(upstream.map((request) => request.url)).toEqual([
        "http://10.0.0.5:3773/api/orchestration/shell?after=3",
      ]);
      expect(upstream[0]?.headers.authorization).toBe("Bearer host-token");
    } finally {
      await app.dispose();
    }
  });

  it("refuses callers without a session, or with less than standard access", async () => {
    const { app, call, upstream } = relayFixture(() => new Response("{}"));
    try {
      expect((await call("windows-env/api/orchestration/shell")).status).toBe(401);
      expect(
        (
          await call("windows-env/api/orchestration/shell", {
            headers: { authorization: "Bearer caller-read-only" },
          })
        ).status,
      ).toBe(403);
      expect(upstream).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  it("passes signed asset links through without a session or the host's credential", async () => {
    const { app, call, upstream } = relayFixture(
      () => new Response("<p>artifact</p>", { headers: { "content-type": "text/html" } }),
    );
    try {
      const response = await call("windows-env/api/assets/payload.sig/index.html");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<p>artifact</p>");
      expect(upstream[0]?.headers.authorization).toBeUndefined();
    } finally {
      await app.dispose();
    }
  });

  it("renews a lapsed host credential once and retries", async () => {
    const { app, call, upstream } = relayFixture((request) => {
      if (request.url.endsWith("/api/auth/renew")) {
        return new Response(JSON.stringify({ credential: "renewed-token" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return request.headers.authorization === "Bearer renewed-token"
        ? new Response("{}", { headers: { "content-type": "application/json" } })
        : new Response("expired", { status: 401 });
    });
    try {
      const response = await call("windows-env/api/auth/websocket-ticket", {
        method: "POST",
        headers: { authorization: "Bearer caller" },
      });
      expect(response.status).toBe(200);
      expect(upstream.map((request) => request.headers.authorization ?? "renew")).toEqual([
        "Bearer host-token",
        "renew",
        "Bearer renewed-token",
      ]);
    } finally {
      await app.dispose();
    }
  });

  it("shares nothing once the host turns sharing off", async () => {
    const { app, call, upstream } = relayFixture(() => new Response("{}"), { sharing: false });
    try {
      expect(
        (await call("windows-env/api/x", { headers: { authorization: "Bearer caller" } })).status,
      ).toBe(404);
      expect((await call("windows-env/api/assets/payload.sig/a.png")).status).toBe(404);
      expect(upstream).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  });

  it("answers 404 for a machine the host does not share", async () => {
    const { app, call } = relayFixture(() => new Response("{}"));
    try {
      expect(
        (await call("someone-else/api/x", { headers: { authorization: "Bearer caller" } })).status,
      ).toBe(404);
    } finally {
      await app.dispose();
    }
  });
});

describe("RelayedEnvironments", () => {
  effectIt.effect("lists names only and keeps a renewal from overwriting a newer publish", () =>
    Effect.gen(function* () {
      const service = yield* RelayedEnvironments.make;
      const source = {
        environmentId: windows,
        label: "Windows",
        httpBaseUrl: "http://10.0.0.5:3773/",
        bearerToken: "first",
      };
      yield* service.publish([source]);
      expect(yield* service.list.pipe(Stream.take(1), Stream.runCollect)).toEqual([
        { environments: [{ environmentId: windows, label: "Windows" }] },
      ]);
      yield* service.publish([{ ...source, bearerToken: "published" }]);
      yield* service.renewToken(windows, "first", "renewed");
      const current = yield* service.get(windows);
      expect(current._tag === "Some" ? current.value.bearerToken : null).toBe("published");
    }).pipe(Effect.provide(ServerSettings.layerTest())),
  );
});

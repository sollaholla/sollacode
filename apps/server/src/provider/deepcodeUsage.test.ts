// @effect-diagnostics preferSchemaOverJson:off
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";
const mockFetch = (
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: () => undefined });
import { readDeepCodeBalance, resolveDeepCodeConnection } from "./deepcodeUsage.ts";

it("matches CLI key and endpoint precedence, including explicitly empty overrides", () => {
  const userSettings = JSON.stringify({
    env: { API_KEY: "user", BASE_URL: "https://custom.example/v1" },
  });
  const resolved = resolveDeepCodeConnection({
    userSettings,
    projectSettings: JSON.stringify({ env: { API_KEY: "project" } }),
    environment: { DEEPCODE_API_KEY: "env", DEEPCODE_BASE_URL: "https://api.deepseek.com/v1" },
  });
  expect(resolved).toMatchObject({ apiKey: "env", supportsBalance: true });
  expect(resolved.identity).not.toContain("env");
  expect(
    resolveDeepCodeConnection({ userSettings, environment: { DEEPCODE_API_KEY: "" } }).apiKey,
  ).toBeNull();
  expect(resolveDeepCodeConnection({ userSettings, environment: {} }).supportsBalance).toBe(false);
  expect(
    resolveDeepCodeConnection({
      userSettings: "",
      plusSettings: JSON.stringify({ env: { PLUS_API_KEY: "plus" } }),
      environment: {},
    }),
  ).toMatchObject({ apiKey: "plus", supportsBalance: false, authType: "Deep Code Plus" });
});

it.effect("fetches only the documented balance endpoint with redirects disabled", () =>
  Effect.gen(function* () {
    const result = yield* readDeepCodeBalance("fixture").pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        mockFetch(async (url, init) => {
          expect(String(url)).toBe("https://api.deepseek.com/user/balance");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture");
          expect(init?.redirect).toBe("error");
          return Response.json({ is_available: false, balance_infos: [] });
        }),
      ),
    );
    expect(result).toEqual({
      status: "success",
      balance: { is_available: false, balance_infos: [] },
    });
  }),
);

it.effect("sanitizes authentication, network, and invalid-body errors", () =>
  Effect.gen(function* () {
    for (const status of [401, 403, 429, 503]) {
      const result = yield* readDeepCodeBalance("secret-key").pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          mockFetch(async () => new Response("secret-key", { status })),
        ),
      );
      expect(result.status).toBe("error");
      expect(JSON.stringify(result)).not.toContain("secret-key");
    }
    const result = yield* readDeepCodeBalance("secret-key").pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        mockFetch(async () => {
          throw new Error("secret-key");
        }),
      ),
    );
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("secret-key");
  }),
);

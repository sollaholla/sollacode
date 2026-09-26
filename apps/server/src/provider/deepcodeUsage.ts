// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { parseDeepCodeBalance } from "@t3tools/shared/deepcodeUsage";

function settingsEnv(raw: string): Record<string, string> {
  try {
    const settings: unknown = JSON.parse(raw);
    if (!Predicate.isObject(settings) || !Predicate.isObject(settings.env)) return {};
    return Object.fromEntries(
      Object.entries(settings.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** Mirrors Deep Code 0.4's environment precedence; never expose this result to clients. */
export function resolveDeepCodeConnection(input: {
  userSettings: string;
  projectSettings?: string;
  plusSettings?: string;
  environment: Readonly<Record<string, string | undefined>>;
}) {
  const systemEnv = Object.fromEntries(
    Object.entries(input.environment)
      .filter(
        (entry): entry is [string, string] =>
          entry[0].startsWith("DEEPCODE_") && typeof entry[1] === "string",
      )
      .map(([key, value]) => [key.slice(9), value]),
  );
  const env = {
    ...settingsEnv(input.userSettings),
    ...settingsEnv(input.projectSettings ?? ""),
    ...systemEnv,
  };
  const directKey = env.API_KEY?.trim() || null;
  const plusKey = settingsEnv(input.plusSettings ?? "").PLUS_API_KEY?.trim() || null;
  const apiKey = directKey ?? plusKey;
  const baseUrl = directKey
    ? env.BASE_URL?.trim() || "https://api.deepseek.com"
    : plusKey
      ? "https://deepcode.vegamo.cn/plugin/openai"
      : env.BASE_URL?.trim() || "https://api.deepseek.com";
  // Only DeepSeek's documented endpoint accepts these credentials. Proxies and
  // Deep Code Plus have separate billing; never send their keys to DeepSeek.
  const supportsBalance = /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(baseUrl);
  const identity = apiKey
    ? NodeCrypto.createHash("sha256").update(`deepcode\0${baseUrl}\0${apiKey}`).digest("hex")
    : null;
  return {
    apiKey,
    baseUrl,
    supportsBalance,
    identity,
    authType: directKey
      ? supportsBalance
        ? "DeepSeek API key"
        : "Custom API key"
      : "Deep Code Plus",
  };
}

/** Sanitized failures cannot include request headers or provider response bodies. */
export const readDeepCodeBalance = Effect.fn("readDeepCodeBalance")(
  function* (apiKey: string) {
    const response = yield* HttpClient.execute(
      HttpClientRequest.get("https://api.deepseek.com/user/balance").pipe(
        HttpClientRequest.bearerToken(apiKey),
      ),
    );
    if (response.status !== 200)
      return {
        status: "error" as const,
        message:
          response.status === 401 || response.status === 403
            ? "DeepSeek rejected this API key. Update Deep Code credentials, then refresh."
            : `DeepSeek balance is temporarily unavailable (HTTP ${response.status}).`,
      };
    const balance = parseDeepCodeBalance(yield* response.json);
    return balance
      ? { status: "success" as const, balance }
      : {
          status: "error" as const,
          message: "DeepSeek returned an unrecognized balance response.",
        };
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("10 seconds"),
      Effect.catch(() =>
        Effect.succeed({
          status: "error" as const,
          message: "DeepSeek balance could not be refreshed. Check the connection and try again.",
        }),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    ),
);

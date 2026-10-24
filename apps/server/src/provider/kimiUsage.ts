// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type KimiAccountUsage, parseKimiUsagesResponse } from "@t3tools/shared/kimiUsage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

const DEFAULT_KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
/** A token this close to expiry may lapse mid-request; wait for Kimi's next refresh. */
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

/** Kimi's own home (`KIMI_CODE_HOME`, else `~/.kimi-code`). */
function kimiHome(environment: NodeJS.ProcessEnv): string {
  return environment.KIMI_CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".kimi-code");
}

/** Where Kimi stores the OAuth token of its managed `kimi-code` provider. */
export function kimiCredentialsPath(environment: NodeJS.ProcessEnv): string {
  return NodePath.join(kimiHome(environment), "credentials", "kimi-code.json");
}

export function kimiUsagesUrl(environment: NodeJS.ProcessEnv): string {
  const base = environment.KIMI_CODE_BASE_URL?.trim() || DEFAULT_KIMI_CODE_BASE_URL;
  return `${base.replace(/\/+$/u, "")}/usages`;
}

/**
 * The stored access token, while it is still valid.
 *
 * Kimi's access tokens live 15 minutes. Kimi refreshes them itself — under a
 * lock, rotating the refresh token — whenever it calls its API, so the token
 * is fresh while Kimi works. Solla only ever reads it: refreshing here would
 * race the CLI for a single-use refresh token and could sign it out. An
 * expired token therefore means "no reading right now", never a refresh.
 */
export function freshKimiAccessToken(credentialsJson: string, nowMs: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentialsJson);
  } catch {
    return null;
  }
  if (!Predicate.isObject(parsed)) return null;
  const token = typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
  const expiresAt = typeof parsed.expires_at === "number" ? parsed.expires_at * 1000 : null;
  if (token.length === 0 || expiresAt === null) return null;
  return expiresAt - nowMs > TOKEN_EXPIRY_MARGIN_MS ? token : null;
}

/**
 * Kimi Code's plan quota, from the endpoint Kimi's own `/usage` reads.
 *
 * Null when there is nothing to read: signed out, an API-key setup with no
 * managed token, a token that has lapsed since Kimi last worked, or a failed
 * request. The token never leaves this function, including in failures.
 */
export const readKimiAccountUsage = Effect.fn("readKimiAccountUsage")(
  function* (environment: NodeJS.ProcessEnv) {
    const credentials = yield* Effect.tryPromise(() =>
      NodeFSP.readFile(kimiCredentialsPath(environment), "utf8"),
    ).pipe(Effect.option);
    if (credentials._tag === "None") return null;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const token = freshKimiAccessToken(credentials.value, nowMs);
    if (token === null) return null;
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(kimiUsagesUrl(environment)).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.acceptJson,
      ),
    );
    if (response.status !== 200) {
      yield* Effect.logDebug("Kimi usage request was refused.", { status: response.status });
      return null;
    }
    return parseKimiUsagesResponse(yield* response.json, nowMs);
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("8 seconds"),
      Effect.orElseSucceed((): KimiAccountUsage | null => null),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    ),
);

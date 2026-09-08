/**
 * Pure URL helpers shared between the preview server, desktop main process,
 * and web renderer. Centralising these guarantees the four call sites agree
 * on what counts as "loopback" and how to normalise a free-form URL string.
 */

import * as Schema from "effect/Schema";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/** Internal — used by `lsof` parsing where the host string is wire-formatted. */
export const LSOF_LOCAL_HOST_TOKENS: ReadonlySet<string> = new Set([
  ...LOOPBACK_HOSTS,
  "*",
  "[::]",
  "[::1]",
]);

const LOOPBACK_PREFIX_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;

const AUTH_TRANSACTION_PATH_PATTERN =
  /(?:^|[/_.-])(?:oauth2?|oidc|saml|authorize|callback)(?:[/_.-]|$)/i;
const AUTH_TRANSACTION_KEYS: ReadonlySet<string> = new Set([
  "access_token",
  "code",
  "id_token",
  "oauth_token",
  "relaystate",
  "samlresponse",
]);
const AUTH_TRANSACTION_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "client_id",
  "nonce",
  "redirect_uri",
  "scope",
  "state",
]);
const AUTH_RESTART_TARGET_KEYS = [
  "redirect_uri",
  "redirect_url",
  "return_to",
  "return_url",
  "callback_url",
  "continue",
] as const;

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host === "[::1]") return true;
  return false;
}

/** True when a raw URL string looks like a loopback dev URL we can preview. */
export function isPreviewableUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export class PreviewUrlNormalizationError extends Schema.TaggedErrorClass<PreviewUrlNormalizationError>()(
  "PreviewUrlNormalizationError",
  {
    inputLength: Schema.Number,
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol"]),
    protocol: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const protocol = this.protocol === undefined ? "" : `: ${this.protocol}`;
    return `Invalid preview URL (${this.reason}${protocol}; input length ${this.inputLength}).`;
  }
}

export const isPreviewUrlNormalizationError = Schema.is(PreviewUrlNormalizationError);

function previewUrlProtocol(rawUrl: string): string | undefined {
  return /^([A-Za-z][A-Za-z\d+.-]*):/.exec(rawUrl)?.[1]?.toLowerCase().concat(":");
}

/**
 * Normalise a free-form URL string into a fully-qualified `http(s)://` URL.
 *
 * - Bare loopback hosts (`localhost`, `localhost:5173`) become `http://...`.
 * - Bare public hosts (`example.com`) become `https://...`.
 * - Already-qualified URLs are validated and returned as `URL.href`.
 *
 * Throws `PreviewUrlNormalizationError` for empty, unparseable, or
 * unsupported-protocol inputs.
 */
export function normalizePreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new PreviewUrlNormalizationError({ inputLength: rawUrl.length, reason: "empty" });
  }
  const useHttp = LOOPBACK_PREFIX_PATTERN.test(trimmed);
  const candidate = trimmed.includes("://")
    ? trimmed
    : `${useHttp ? "http" : "https"}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new PreviewUrlNormalizationError({
      inputLength: rawUrl.length,
      reason: "parse",
      protocol: previewUrlProtocol(candidate),
      cause,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PreviewUrlNormalizationError({
      inputLength: rawUrl.length,
      reason: "unsupported-protocol",
      protocol: parsed.protocol,
    });
  }
  return parsed.href;
}

/**
 * Return a URL that is safe to load after the preview host restarts.
 *
 * OAuth and SAML authorization URLs are short-lived transactions, not useful
 * browser history. Replaying one after an app restart can leave a convincing
 * login page backed by an expired state cookie; its eventual callback is then
 * an intentionally empty document that cannot complete. It also persists
 * authorization codes and state values long after the browser needed them.
 *
 * For an auth transaction, restart at the callback site's origin when the URL
 * names one, or at the current origin otherwise. The ordinary live snapshot
 * still carries the exact URL; callers use this helper only for durable state.
 */
export function restartSafePreviewUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return rawUrl;
  if (!AUTH_TRANSACTION_PATH_PATTERN.test(parsed.pathname)) return rawUrl;

  const query = new Map(
    [...parsed.searchParams.entries()].map(([key, value]) => [key.toLowerCase(), value]),
  );
  const hasDirectTransactionValue = [...AUTH_TRANSACTION_KEYS].some((key) => query.has(key));
  const contextValueCount = [...AUTH_TRANSACTION_CONTEXT_KEYS].filter((key) =>
    query.has(key),
  ).length;
  if (!hasDirectTransactionValue && contextValueCount < 2) return rawUrl;

  for (const key of AUTH_RESTART_TARGET_KEYS) {
    const value = query.get(key);
    if (!value) continue;
    try {
      const target = new URL(value, parsed.origin);
      if (target.protocol === "http:" || target.protocol === "https:") {
        return `${target.origin}/`;
      }
    } catch {
      // Try the next target before falling back to the transaction's origin.
    }
  }

  return `${parsed.origin}/`;
}

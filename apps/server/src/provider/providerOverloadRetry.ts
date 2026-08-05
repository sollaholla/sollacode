const HTTP_PROVIDER_OVERLOADED = 529;
const MAX_STRUCTURED_ERROR_NODES = 32;

/**
 * Upstream statuses the provider retries on its own before surfacing anything.
 *
 * 529 is Anthropic's explicit "overloaded", but the plain gateway failures
 * behave identically: the CLI retries them at transport level and only emits
 * user-visible text once the attempts run out. Treating only 529 as a retry
 * meant a 502 storm retried in complete silence and then arrived as an error
 * message, with no indication the provider had been trying all along.
 *
 * Matched on the structured `error_status` the retry heartbeat carries, never on
 * free text, so a model writing about "502" cannot move turn lifecycle.
 */
const RETRYABLE_UPSTREAM_STATUSES: ReadonlySet<number> = new Set([
  502,
  503,
  504,
  HTTP_PROVIDER_OVERLOADED,
]);

export function isRetryableUpstreamStatus(status: unknown): boolean {
  return typeof status === "number" && RETRYABLE_UPSTREAM_STATUSES.has(status);
}

function hasStructuredStatus(value: unknown, matches: (status: unknown) => boolean): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [value];

  for (let visited = 0; queue.length > 0 && visited < MAX_STRUCTURED_ERROR_NODES; visited += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);

    const record = node as Record<string, unknown>;
    for (const key of ["status", "statusCode", "httpStatusCode", "error_status"] as const) {
      if (matches(record[key])) return true;
    }

    // Native Error fields such as `cause` are commonly non-enumerable, so an
    // Object.values-only walk silently misses structured gateway responses
    // wrapped by `new Error(message, { cause })`.
    for (const key of ["cause", "error", "data", "response"] as const) {
      const nested = record[key];
      if (nested !== null && typeof nested === "object") queue.push(nested);
    }

    for (const nested of Object.values(record)) {
      if (nested !== null && typeof nested === "object") queue.push(nested);
    }
  }

  return false;
}

/**
 * Classifies only structured upstream status fields. This is safe to use for
 * lifecycle decisions because provider/model prose is never inspected.
 */
export function hasRetryableUpstreamStatus(value: unknown): boolean {
  return hasStructuredStatus(value, isRetryableUpstreamStatus);
}

export const PROVIDER_OVERLOAD_RETRY_REASON_PREFIX = "provider_overloaded:retrying";

/**
 * Recognize an HTTP 529 only from structured provider data. Deliberately avoid
 * free-text matching so a model discussing "529" cannot alter turn lifecycle.
 */
export function hasProviderOverloadStatus(value: unknown): boolean {
  return hasStructuredStatus(value, (status) => status === HTTP_PROVIDER_OVERLOADED);
}

export function providerOverloadRetryReason(input?: {
  readonly attempt?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly delayMs?: number | undefined;
}): string {
  const fields: Array<string> = [];
  if (input?.attempt !== undefined && Number.isFinite(input.attempt)) {
    fields.push(`attempt=${Math.max(0, Math.trunc(input.attempt))}`);
  }
  if (input?.maxAttempts !== undefined && Number.isFinite(input.maxAttempts)) {
    fields.push(`max=${Math.max(0, Math.trunc(input.maxAttempts))}`);
  }
  if (input?.delayMs !== undefined && Number.isFinite(input.delayMs)) {
    fields.push(`delay_ms=${Math.max(0, Math.trunc(input.delayMs))}`);
  }
  return fields.length > 0
    ? `${PROVIDER_OVERLOAD_RETRY_REASON_PREFIX};${fields.join(";")}`
    : PROVIDER_OVERLOAD_RETRY_REASON_PREFIX;
}

export function providerOverloadExhaustedMessage(providerMessage?: string): string {
  const detail = providerMessage?.trim();
  const action =
    "The provider remained overloaded after its bounded retries. Try this turn again shortly.";
  return detail && !detail.includes(action) ? `${action} ${detail}` : (detail ?? action);
}

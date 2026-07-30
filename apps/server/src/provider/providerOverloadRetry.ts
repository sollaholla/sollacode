const HTTP_PROVIDER_OVERLOADED = 529;
const MAX_STRUCTURED_ERROR_NODES = 32;

export const PROVIDER_OVERLOAD_RETRY_REASON_PREFIX = "provider_overloaded:retrying";

/**
 * Recognize an HTTP 529 only from structured provider data. Deliberately avoid
 * free-text matching so a model discussing "529" cannot alter turn lifecycle.
 */
export function hasProviderOverloadStatus(value: unknown): boolean {
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
      if (record[key] === HTTP_PROVIDER_OVERLOADED) {
        return true;
      }
    }

    for (const nested of Object.values(record)) {
      if (nested !== null && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return false;
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

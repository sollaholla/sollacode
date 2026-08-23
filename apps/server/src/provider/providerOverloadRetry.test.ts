import { describe, expect, it } from "vite-plus/test";

import {
  hasProviderOverloadStatus,
  hasRetryableUpstreamStatus,
  isRetryableUpstreamStatus,
  providerOverloadExhaustedMessage,
  providerOverloadRetryReason,
} from "./providerOverloadRetry.ts";

describe("provider overload retry normalization", () => {
  it("detects only structured HTTP 529 status fields", () => {
    expect(hasProviderOverloadStatus({ error_status: 529 })).toBe(true);
    expect(
      hasProviderOverloadStatus({
        error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 529 } } },
      }),
    ).toBe(true);
    expect(hasProviderOverloadStatus({ data: { statusCode: 529 } })).toBe(true);

    expect(hasProviderOverloadStatus({ statusCode: 503 })).toBe(false);
    expect(hasProviderOverloadStatus({ message: "HTTP 529 provider overloaded" })).toBe(false);
  });

  it("emits a provider-neutral structured running reason", () => {
    expect(providerOverloadRetryReason({ attempt: 2, maxAttempts: 5, delayMs: 1_750 })).toBe(
      "provider_overloaded:retrying;attempt=2;max=5;delay_ms=1750",
    );
  });

  it("adds an actionable terminal message without losing provider detail", () => {
    expect(providerOverloadExhaustedMessage("upstream request failed")).toContain(
      "Try this turn again shortly.",
    );
    expect(providerOverloadExhaustedMessage("upstream request failed")).toContain(
      "upstream request failed",
    );
  });
});

describe("isRetryableUpstreamStatus", () => {
  it("covers the gateway failures the CLI already retries, not just 529", () => {
    // Treating only 529 as a retry left a 502 storm retrying in silence and then
    // arriving as an error message, with no sign the provider had been trying.
    for (const status of [502, 503, 504, 529]) {
      expect(isRetryableUpstreamStatus(status)).toBe(true);
    }
  });

  it("leaves client errors and successes alone", () => {
    for (const status of [200, 400, 401, 403, 404, 429, 500, 501]) {
      expect(isRetryableUpstreamStatus(status)).toBe(false);
    }
  });

  it("ignores anything that is not a number", () => {
    // The status arrives on a structured retry heartbeat; free text must never
    // reach turn lifecycle.
    for (const status of ["502", null, undefined, {}, Number.NaN]) {
      expect(isRetryableUpstreamStatus(status)).toBe(false);
    }
  });
});

describe("hasRetryableUpstreamStatus", () => {
  it("recognizes only structured 502/503/504/529 fields at bounded depth", () => {
    for (const status of [502, 503, 504, 529]) {
      expect(
        hasRetryableUpstreamStatus({
          error: { cause: { response: { error_status: status } } },
        }),
      ).toBe(true);
    }
  });

  it("follows a native Error's non-enumerable structured cause", () => {
    const error = new Error("gateway request failed", {
      cause: { response: { statusCode: 502 } },
    });

    expect(Object.values(error)).not.toContain(error.cause);
    expect(hasRetryableUpstreamStatus(error)).toBe(true);
  });

  it("never derives lifecycle from free text or stringified status codes", () => {
    expect(hasRetryableUpstreamStatus({ message: "API Error: 502 upstream unreachable" })).toBe(
      false,
    );
    expect(hasRetryableUpstreamStatus({ status: "502" })).toBe(false);
    expect(hasRetryableUpstreamStatus("529 provider overloaded")).toBe(false);
  });
});

describe("transient network failures", () => {
  it("treats DNS and socket codes as retryable upstream", () => {
    // The exact shape Node hands back when MagicDNS drops out; a raw CLI
    // shows this as "Can't reach the API server (ENOTFOUND)".
    expect(
      hasRetryableUpstreamStatus(
        Object.assign(new Error("getaddrinfo"), {
          code: "ENOTFOUND",
        }),
      ),
    ).toBe(true);
    expect(hasRetryableUpstreamStatus({ cause: { code: "EAI_AGAIN" } })).toBe(true);
    expect(hasRetryableUpstreamStatus({ error: { code: "ECONNRESET" } })).toBe(true);
    expect(hasRetryableUpstreamStatus({ code: "undici_err_socket" })).toBe(false);
  });

  it("still ignores codes that only appear as prose", () => {
    // Lifecycle must never move because a model wrote about an error.
    expect(hasRetryableUpstreamStatus({ message: "the build failed with ENOTFOUND" })).toBe(false);
    expect(hasRetryableUpstreamStatus("ENOTFOUND")).toBe(false);
  });

  it("leaves genuine application failures alone", () => {
    expect(hasRetryableUpstreamStatus({ code: "ERR_INVALID_ARG_TYPE" })).toBe(false);
    expect(hasRetryableUpstreamStatus({ status: 401 })).toBe(false);
  });
});

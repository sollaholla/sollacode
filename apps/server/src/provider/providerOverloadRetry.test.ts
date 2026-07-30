import { describe, expect, it } from "vite-plus/test";

import {
  hasProviderOverloadStatus,
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

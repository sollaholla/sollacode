import { assert, describe, it } from "@effect/vitest";

import { providerEventLoggingEnabled } from "./ProviderEventLoggers.ts";

describe("ProviderEventLoggers", () => {
  it("disables provider event logs by default outside development", () => {
    assert.isFalse(providerEventLoggingEnabled({ configured: undefined, devUrl: undefined }));
  });

  it("keeps development diagnostics and explicit overrides", () => {
    assert.isTrue(
      providerEventLoggingEnabled({
        configured: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
      }),
    );
    assert.isTrue(providerEventLoggingEnabled({ configured: true, devUrl: undefined }));
    assert.isFalse(
      providerEventLoggingEnabled({
        configured: false,
        devUrl: new URL("http://127.0.0.1:5173"),
      }),
    );
  });
});

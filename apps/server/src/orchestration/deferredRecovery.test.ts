import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { classifyDeferredRecoveryFailure } from "./deferredRecovery.ts";

describe("classifyDeferredRecoveryFailure", () => {
  it("names the failures a fresh attempt repairs on its own", () => {
    expect(
      classifyDeferredRecoveryFailure({
        driver: ProviderDriverKind.make("muse"),
        message: "[muse-progress-timeout] Muse stopped reporting progress.",
      }),
    ).toBe("progress-timeout-retry");
  });

  it("leaves everything else to pause the thread", () => {
    expect(
      classifyDeferredRecoveryFailure({
        driver: ProviderDriverKind.make("claudeAgent"),
        message: "You've hit your usage limit.",
      }),
    ).toBeNull();
    expect(
      classifyDeferredRecoveryFailure({
        driver: ProviderDriverKind.make("codex"),
        message: "[muse-progress-timeout] quoted in a log",
      }),
    ).toBeNull();
  });
});

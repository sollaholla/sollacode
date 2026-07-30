import type { DesktopServerExposureState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentTailscaleServe } from "./tailscaleServePresentation";

const state = (
  status: DesktopServerExposureState["tailscaleServeStatus"],
): DesktopServerExposureState => ({
  mode: "local-only",
  endpointUrl: null,
  advertisedHost: null,
  tailscaleServeRequested: status !== "disabled",
  tailscaleServeEffective: status === "available",
  tailscaleServeStatus: status,
  tailscaleServeConsentUrl:
    status === "https-consent-required"
      ? "https://login.tailscale.com/admin/feature/example"
      : null,
  tailscaleServePort: 443,
});

describe("presentTailscaleServe", () => {
  it("distinguishes requested consent from effective private access", () => {
    expect(presentTailscaleServe(state("https-consent-required"), null)).toEqual(
      expect.objectContaining({
        label: "Approval required",
        canRetry: true,
      }),
    );
    expect(presentTailscaleServe(state("available"), "https://desktop.tail.ts.net/")).toEqual(
      expect.objectContaining({
        label: "Private",
        description: expect.stringContaining("Create a one-time link under Authorized clients"),
      }),
    );
  });

  it("states that the disabled feature does not enable public Funnel access", () => {
    expect(presentTailscaleServe(state("disabled"), null).description).toContain(
      "does not enable Funnel or public access",
    );
  });
});

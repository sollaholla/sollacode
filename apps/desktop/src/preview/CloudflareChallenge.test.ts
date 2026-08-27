import { describe, expect, it } from "vite-plus/test";

import { classifyPreviewNetworkResponse, isCfMitigatedChallenge } from "./CloudflareChallenge.ts";

describe("isCfMitigatedChallenge", () => {
  it("recognizes a challenge response regardless of header casing", () => {
    expect(isCfMitigatedChallenge({ "Cf-Mitigated": " Challenge " })).toBe(true);
  });

  it("does not treat unrelated response headers as a challenge", () => {
    expect(isCfMitigatedChallenge({ "content-type": "text/html", "cf-ray": "ray-id" })).toBe(false);
    expect(isCfMitigatedChallenge(null)).toBe(false);
  });

  it("records a successful HTTP challenge response without calling it a network failure", () => {
    expect(classifyPreviewNetworkResponse(200, { "cf-mitigated": "challenge" })).toEqual({
      record: true,
      failed: false,
      cfMitigated: true,
    });
    expect(classifyPreviewNetworkResponse(200, {})).toEqual({
      record: false,
      failed: false,
      cfMitigated: false,
    });
  });
});

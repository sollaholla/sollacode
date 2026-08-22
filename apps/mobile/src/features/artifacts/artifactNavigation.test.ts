import { describe, expect, it } from "vite-plus/test";

import { isAllowedArtifactNavigation } from "./artifactNavigation";

describe("isAllowedArtifactNavigation", () => {
  const entry = "https://mac.tailnet.ts.net/api/assets/signed-123/index.html?token=abc";

  it("allows the entry document and its signed asset subtree", () => {
    expect(isAllowedArtifactNavigation(entry, entry)).toBe(true);
    expect(
      isAllowedArtifactNavigation(
        "https://mac.tailnet.ts.net/api/assets/signed-123/detail.html",
        entry,
      ),
    ).toBe(true);
    expect(isAllowedArtifactNavigation("about:blank", entry)).toBe(true);
  });

  it("rejects other host pages and external origins", () => {
    expect(isAllowedArtifactNavigation("https://mac.tailnet.ts.net/settings", entry)).toBe(false);
    expect(isAllowedArtifactNavigation("https://example.com/", entry)).toBe(false);
    expect(isAllowedArtifactNavigation("not a url", entry)).toBe(false);
  });
});

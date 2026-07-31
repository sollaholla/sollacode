import { describe, expect, it } from "vite-plus/test";

import { resolveAssetUrl, resolveDisplayAssetUrl, withAssetRevision } from "./assetUrls";

describe("resolveAssetUrl", () => {
  it("resolves an environment-relative asset URL", () => {
    expect(
      resolveAssetUrl("https://environment.example/base/", "/api/assets/signed-token/favicon.png"),
    ).toBe("https://environment.example/api/assets/signed-token/favicon.png");
  });

  it("rejects an invalid environment base URL", () => {
    expect(resolveAssetUrl("not a URL", "/api/assets/signed-token/favicon.png")).toBeNull();
  });

  it("routes desktop display assets through the privileged renderer protocol", () => {
    expect(
      resolveDisplayAssetUrl(
        "http://10.2.1.249:3773/",
        "/api/assets/signed-token/check_knuckle.png",
        "sollacode://app/chat/environment/thread",
      ),
    ).toBe(
      "sollacode://app/__solla/remote-asset?url=http%3A%2F%2F10.2.1.249%3A3773%2Fapi%2Fassets%2Fsigned-token%2Fcheck_knuckle.png",
    );
  });

  it("leaves browser display assets on their environment origin", () => {
    expect(
      resolveDisplayAssetUrl(
        "http://10.2.1.249:3773/",
        "/api/assets/signed-token/check_knuckle.png",
        "http://10.2.1.243:3773/chat/environment/thread",
      ),
    ).toBe("http://10.2.1.249:3773/api/assets/signed-token/check_knuckle.png");
  });

  it("gives each mutable image revision a distinct fetch URL", () => {
    expect(
      withAssetRevision(
        "https://environment.example/api/assets/signed-token/preview.png",
        "work-entry-2",
      ),
    ).toBe(
      "https://environment.example/api/assets/signed-token/preview.png?solla_revision=work-entry-2",
    );
  });

  it("adds the cache revision to the desktop proxy URL without changing the signed host URL", () => {
    const proxied = resolveDisplayAssetUrl(
      "http://10.2.1.249:3773/",
      "/api/assets/signed-token/check_knuckle.png",
      "sollacode://app/chat/environment/thread",
    );
    expect(proxied).not.toBeNull();
    expect(withAssetRevision(proxied!, "assistant-message-42")).toBe(
      "sollacode://app/__solla/remote-asset?url=http%3A%2F%2F10.2.1.249%3A3773%2Fapi%2Fassets%2Fsigned-token%2Fcheck_knuckle.png&solla_revision=assistant-message-42",
    );
  });

  it("preserves an invalid or unversioned URL", () => {
    expect(withAssetRevision("not a URL", "work-entry-2")).toBe("not a URL");
    expect(withAssetRevision("https://environment.example/preview.png", " ")).toBe(
      "https://environment.example/preview.png",
    );
  });
});

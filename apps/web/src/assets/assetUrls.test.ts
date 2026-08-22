import { describe, expect, it } from "vite-plus/test";

import {
  resolveAssetUrl,
  resolveDisplayArtifactUrl,
  resolveDisplayAssetUrl,
  withAssetRevision,
} from "./assetUrls";

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
        "http://192.0.2.10:3773/",
        "/api/assets/signed-token/check_knuckle.png",
        "sollacode://app/chat/environment/thread",
      ),
    ).toBe(
      "sollacode://app/__solla/remote-asset?url=http%3A%2F%2F192.0.2.10%3A3773%2Fapi%2Fassets%2Fsigned-token%2Fcheck_knuckle.png",
    );
  });

  it("leaves browser display assets on their environment origin", () => {
    expect(
      resolveDisplayAssetUrl(
        "http://192.0.2.10:3773/",
        "/api/assets/signed-token/check_knuckle.png",
        "http://10.2.1.243:3773/chat/environment/thread",
      ),
    ).toBe("http://192.0.2.10:3773/api/assets/signed-token/check_knuckle.png");
  });

  it("gives desktop artifact bundles a path base for relative files", () => {
    const entryUrl = resolveDisplayArtifactUrl(
      "http://192.0.2.10:3773/",
      "/api/assets/payload.signature/site/index.html",
      "sollacode://app/chat/environment/thread",
    );
    expect(entryUrl).not.toBeNull();
    const entry = new URL(entryUrl!);
    expect(entry.protocol).toBe("sollacode:");
    expect(entry.pathname).toMatch(/^\/__solla\/remote-artifact\/[^/]+\/site\/index[.]html$/u);
    expect(new URL("styles.css", entry).pathname).toBe(
      entry.pathname.replace(/index[.]html$/u, "styles.css"),
    );
  });

  it("leaves browser artifact bundles on the environment origin", () => {
    expect(
      resolveDisplayArtifactUrl(
        "https://environment.example/",
        "/api/assets/payload.signature/index.html",
        "https://app.example/thread",
      ),
    ).toBe("https://environment.example/api/assets/payload.signature/index.html");
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
      "http://192.0.2.10:3773/",
      "/api/assets/signed-token/check_knuckle.png",
      "sollacode://app/chat/environment/thread",
    );
    expect(proxied).not.toBeNull();
    expect(withAssetRevision(proxied!, "assistant-message-42")).toBe(
      "sollacode://app/__solla/remote-asset?url=http%3A%2F%2F192.0.2.10%3A3773%2Fapi%2Fassets%2Fsigned-token%2Fcheck_knuckle.png&solla_revision=assistant-message-42",
    );
  });

  it("preserves an invalid or unversioned URL", () => {
    expect(withAssetRevision("not a URL", "work-entry-2")).toBe("not a URL");
    expect(withAssetRevision("https://environment.example/preview.png", " ")).toBe(
      "https://environment.example/preview.png",
    );
  });
});

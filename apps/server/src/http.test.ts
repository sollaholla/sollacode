import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  assetCacheControlForUrl,
  assetResponseHeaders,
  artifactResponseHeaders,
  isLoopbackHostname,
  MUTABLE_ASSET_CACHE_CONTROL,
  REVISIONED_ASSET_CACHE_CONTROL,
  resolveDevRedirectUrl,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });

  it("never caches mutable workspace assets by their stable signed URL", () => {
    expect(MUTABLE_ASSET_CACHE_CONTROL).toBe("private, no-store, max-age=0");
  });

  it("caches revision-keyed workspace assets without pinning later revisions", () => {
    expect(
      assetCacheControlForUrl(
        new URL(
          "http://remote.test/api/assets/token/preview.png?solla_revision=assistant-message-42",
        ),
      ),
    ).toBe(REVISIONED_ASSET_CACHE_CONTROL);
    expect(
      assetCacheControlForUrl(new URL("http://remote.test/api/assets/token/preview.png")),
    ).toBe(MUTABLE_ASSET_CACHE_CONTROL);
  });
});

describe("assetResponseHeaders", () => {
  const assetUrl = new URL("http://remote.test/api/assets/token/user-image.svg");

  it("sandboxes SVG assets served from disk", () => {
    // An SVG runs script and fetches references like any document, so serving a
    // user-supplied one from the app's own origin is a stored-XSS vector.
    expect(
      assetResponseHeaders({ url: assetUrl, path: "/attachments/user-image.svg" }),
    ).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(
      assetResponseHeaders({ url: assetUrl, path: "/attachments/user-image.SVG" }),
    ).toHaveProperty("Content-Security-Policy");
  });

  it("sandboxes SVG assets served from memory", () => {
    // The in-memory path carries no filename, so the content type is the only
    // thing left to recognise it by.
    expect(assetResponseHeaders({ url: assetUrl, contentType: "image/svg+xml" })).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders({ url: assetUrl, path: "/attachments/user-image.png" })).toEqual({
      "Cache-Control": MUTABLE_ASSET_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders({ url: assetUrl, contentType: "image/png" })).not.toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("keeps cache-control derived from the URL, not the file path", () => {
    // The fork's revision-keyed URLs are what make an asset immutable; a
    // path-derived header would wrongly pin unversioned workspace files.
    expect(
      assetResponseHeaders({
        url: new URL("http://remote.test/api/assets/token/p.png?solla_revision=msg-42"),
        path: "/attachments/p.png",
      })["Cache-Control"],
    ).toBe(REVISIONED_ASSET_CACHE_CONTROL);
  });
});

describe("artifactResponseHeaders", () => {
  it("sandboxes executable bundles and disables ambient browser capabilities", () => {
    const headers = artifactResponseHeaders(
      new URL("https://remote.test/api/assets/payload.signature/site/index.html"),
    );
    expect(headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "private, max-age=3600, immutable",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    expect(headers["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    expect(headers["Content-Security-Policy"]).toContain("connect-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain(
      "script-src https://remote.test/api/assets/payload.signature/",
    );
    expect(headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
    expect(headers["Content-Security-Policy"]).not.toContain("'self'");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Permissions-Policy"]).toContain("microphone=()");
    expect(headers["Permissions-Policy"]).toContain("display-capture=()");
  });
});

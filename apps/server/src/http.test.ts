import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  assetCacheControlForUrl,
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

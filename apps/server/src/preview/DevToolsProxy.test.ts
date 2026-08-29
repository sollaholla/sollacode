import { describe, expect, it } from "@effect/vitest";

import { devToolsAssetUrl, devToolsCdpUrl, isDevToolsTargetId } from "./DevToolsProxy.ts";

describe("devToolsCdpUrl", () => {
  it("addresses exactly one target on loopback", () => {
    expect(devToolsCdpUrl({ port: 52134, targetId: "AB12CD34EF56" })).toBe(
      "ws://127.0.0.1:52134/devtools/page/AB12CD34EF56",
    );
  });

  it("refuses a target id that could steer the URL somewhere else", () => {
    for (const targetId of [
      "../browser/abc12345",
      "abc123/../../json",
      "abc12345?x=1",
      "abc12345#f",
      "short",
      "",
    ]) {
      expect(devToolsCdpUrl({ port: 52134, targetId })).toBeNull();
      expect(isDevToolsTargetId(targetId)).toBe(false);
    }
  });

  it("refuses a port that was never bound", () => {
    for (const port of [0, -1, 70_000, 1.5]) {
      expect(devToolsCdpUrl({ port, targetId: "AB12CD34EF56" })).toBeNull();
    }
  });
});

describe("devToolsAssetUrl", () => {
  it("serves the frontend from loopback", () => {
    expect(devToolsAssetUrl(52134, "/devtools/inspector.html")).toBe(
      "http://127.0.0.1:52134/devtools/inspector.html",
    );
    expect(devToolsAssetUrl(52134, "/devtools/inspector.html?ws=x")).toBe(
      "http://127.0.0.1:52134/devtools/inspector.html?ws=x",
    );
  });

  it("never proxies the target list, which names the app's own windows", () => {
    for (const assetPath of ["/json", "/json/list", "/json/version"]) {
      expect(devToolsAssetUrl(52134, assetPath)).toBeNull();
    }
  });

  it("refuses traversal out of the frontend, encoded or not", () => {
    for (const assetPath of [
      "/devtools/../json/list",
      "/devtools/%2e%2e/json/list",
      "/devtools//json",
      "/etc/passwd",
    ]) {
      expect(devToolsAssetUrl(52134, assetPath)).toBeNull();
    }
  });
});

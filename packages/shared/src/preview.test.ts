import { describe, expect, it } from "vite-plus/test";

import {
  isLoopbackHost,
  isPreviewableUrl,
  isPublicWebPreviewUrl,
  normalizePreviewUrl,
  PreviewUrlNormalizationError,
  restartSafePreviewUrl,
} from "./preview.ts";

describe("isPublicWebPreviewUrl", () => {
  it.each([
    "http://localhost:3000/",
    "http://app.localhost/",
    "http://127.1:3000/",
    "http://2130706433/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.4.2/",
    "http://172.31.0.1/",
    "http://192.168.1.4/",
    "http://169.254.1.2/",
    "http://100.100.1.2/",
    "https://host.tail123.ts.net/",
    "http://macbook/",
    "http://macbook.local/",
    "http://router.home.arpa/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd7a:115c:a1e0::1]/",
    "http://[fe80::1]/",
    "file:///tmp/index.html",
    "about:blank",
    "javascript:alert(1)",
    "not a url",
  ])("keeps host-only URL %s inside the preview", (url) => {
    expect(isPublicWebPreviewUrl(url)).toBe(false);
  });

  it.each([
    "https://example.com/a/long/path?query=value",
    "http://8.8.8.8/",
    "http://172.32.0.1/",
    "https://[2606:4700:4700::1111]/",
    "https://localhost.example.com/",
  ])("offers a client link for %s", (url) => {
    expect(isPublicWebPreviewUrl(url)).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  it.each(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["example.com", "192.168.1.10", "10.0.0.1", ""])("%s is not loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("isPreviewableUrl", () => {
  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:3000/path",
    "http://0.0.0.0:8080",
    "http://[::1]:5173",
  ])("%s is previewable", (url) => {
    expect(isPreviewableUrl(url)).toBe(true);
  });

  it.each(["https://example.com", "ws://localhost:5173", "file:///etc/passwd", "not-a-url", ""])(
    "%s is not previewable",
    (url) => {
      expect(isPreviewableUrl(url)).toBe(false);
    },
  );
});

describe("normalizePreviewUrl", () => {
  it("treats bare loopback hosts as http", () => {
    expect(normalizePreviewUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  });

  it("treats bare public hosts as https", () => {
    expect(normalizePreviewUrl("example.com")).toBe("https://example.com/");
  });

  it("respects explicit schemes", () => {
    expect(normalizePreviewUrl("https://localhost:5173")).toBe("https://localhost:5173/");
    expect(normalizePreviewUrl("http://example.com/path?q=1")).toBe("http://example.com/path?q=1");
  });

  it("rejects empty input", () => {
    try {
      normalizePreviewUrl("   ");
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({ inputLength: 3, reason: "empty" });
      expect(error).not.toHaveProperty("rawUrl");
      expect("cause" in (error as object)).toBe(false);
    }
  });

  it("rejects unsupported protocols", () => {
    try {
      normalizePreviewUrl("ftp://example.com");
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: "ftp://example.com".length,
        reason: "unsupported-protocol",
        protocol: "ftp:",
      });
    }
  });

  it("rejects unparseable input without retaining credentials or tokens", () => {
    const rawUrl = "https://user:password@example.com:bad/path?access_token=secret#fragment";
    try {
      normalizePreviewUrl(rawUrl);
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: rawUrl.length,
        reason: "parse",
        protocol: "https:",
      });
      expect(error).not.toHaveProperty("rawUrl");
      expect((error as PreviewUrlNormalizationError).cause).toBeInstanceOf(Error);
      expect((error as PreviewUrlNormalizationError).message).not.toContain(
        ((error as PreviewUrlNormalizationError).cause as Error).message,
      );
      expect((error as PreviewUrlNormalizationError).message).not.toMatch(
        /user|password|access_token|secret|fragment/,
      );
    }
  });
});

describe("restartSafePreviewUrl", () => {
  it("restarts an OAuth authorization at the relying site's stable origin", () => {
    expect(
      restartSafePreviewUrl(
        "https://login.squarespace.com/api/1/login/oauth/provider/authorize" +
          "?client_id=client&state=one-time&redirect_uri=" +
          encodeURIComponent("https://account.squarespace.com/oauth-connect"),
      ),
    ).toBe("https://account.squarespace.com/");
  });

  it.each([
    "https://login.example.com/oauth/callback?code=secret&state=one-time",
    "https://login.example.com/saml/callback?SAMLResponse=secret&RelayState=one-time",
  ])("strips a completed auth transaction instead of replaying %s", (url) => {
    expect(restartSafePreviewUrl(url)).toBe("https://login.example.com/");
  });

  it("does not rewrite ordinary application state", () => {
    const url = "https://example.com/projects?state=active&scope=team";
    expect(restartSafePreviewUrl(url)).toBe(url);
  });

  it("leaves malformed and unsupported URLs unchanged", () => {
    expect(restartSafePreviewUrl("not a URL")).toBe("not a URL");
    expect(restartSafePreviewUrl("file:///tmp/callback?code=secret")).toBe(
      "file:///tmp/callback?code=secret",
    );
  });
});

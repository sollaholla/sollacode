import { describe, expect, it } from "vite-plus/test";

import { freshKimiAccessToken, kimiCredentialsPath, kimiUsagesUrl } from "./kimiUsage.ts";

const NOW_MS = 1_800_000_000_000;
const credentials = (token: string, expiresInMs: number) =>
  JSON.stringify({
    access_token: token,
    refresh_token: "r",
    expires_at: (NOW_MS + expiresInMs) / 1000,
  });

describe("Kimi usage reader", () => {
  it("uses the stored token only while it is comfortably valid", () => {
    expect(freshKimiAccessToken(credentials("token", 10 * 60_000), NOW_MS)).toBe("token");
    expect(freshKimiAccessToken(credentials("token", 10_000), NOW_MS)).toBeNull();
    expect(freshKimiAccessToken(credentials("token", -60_000), NOW_MS)).toBeNull();
  });

  it("reads nothing from a signed-out or unreadable credentials file", () => {
    expect(freshKimiAccessToken(credentials("", 10 * 60_000), NOW_MS)).toBeNull();
    expect(freshKimiAccessToken(JSON.stringify({ access_token: "token" }), NOW_MS)).toBeNull();
    expect(freshKimiAccessToken("{not json", NOW_MS)).toBeNull();
  });

  it("follows Kimi's own home and base URL overrides", () => {
    expect(kimiCredentialsPath({ KIMI_CODE_HOME: "/tmp/kimi" })).toBe(
      "/tmp/kimi/credentials/kimi-code.json",
    );
    expect(kimiUsagesUrl({})).toBe("https://api.kimi.com/coding/v1/usages");
    expect(kimiUsagesUrl({ KIMI_CODE_BASE_URL: "https://example.test/v1/" })).toBe(
      "https://example.test/v1/usages",
    );
  });
});

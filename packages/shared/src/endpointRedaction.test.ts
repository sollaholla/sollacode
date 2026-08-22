import { describe, expect, it } from "vite-plus/test";

import { REDACTED_HOST, redactEndpointHost } from "./endpointRedaction.ts";

describe("redactEndpointHost", () => {
  // The reported shape: a reconnect banner published the LAN address of the
  // user's other machine, and that banner gets screenshotted.
  it("masks the host of a remote environment endpoint but keeps it actionable", () => {
    expect(redactEndpointHost("http://192.0.2.44:3773/.well-known/t3/environment")).toBe(
      `http://${REDACTED_HOST}:3773/.well-known/t3/environment`,
    );
  });

  it("masks named hosts too, not just literal addresses", () => {
    expect(redactEndpointHost("https://workstation.example.ts.net/api")).toBe(
      `https://${REDACTED_HOST}/api`,
    );
  });

  it("keeps the query string, which carries no host information", () => {
    expect(redactEndpointHost("http://192.168.1.7:3773/probe?attempt=2")).toBe(
      `http://${REDACTED_HOST}:3773/probe?attempt=2`,
    );
  });

  it("masks an IPv6 endpoint", () => {
    expect(redactEndpointHost("http://[fe80::1c2d:3e4f]:3773/health")).toBe(
      `http://${REDACTED_HOST}:3773/health`,
    );
  });

  it("falls back to masking literal addresses inside an unparseable value", () => {
    expect(redactEndpointHost("192.0.2.44:3773")).toBe(`${REDACTED_HOST}:3773`);
    expect(redactEndpointHost("[fe80::1c2d:3e4f]:3773")).toBe(`${REDACTED_HOST}:3773`);
  });

  it("leaves an empty value alone", () => {
    expect(redactEndpointHost("")).toBe("");
  });
});

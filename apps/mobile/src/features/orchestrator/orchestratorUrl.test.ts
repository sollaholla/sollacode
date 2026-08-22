import { describe, expect, it } from "vite-plus/test";

import { buildOrchestratorUrl, isSameEnvironmentOrigin } from "./orchestratorUrl";

describe("buildOrchestratorUrl", () => {
  it("points at the web client's full-screen voice route", () => {
    expect(buildOrchestratorUrl("http://192.168.1.10:3773")).toBe(
      "http://192.168.1.10:3773/orchestrator",
    );
  });

  it("does not double the slash on a base that already ends in one", () => {
    expect(buildOrchestratorUrl("https://mac.local:3773/")).toBe(
      "https://mac.local:3773/orchestrator",
    );
  });

  it("keeps a base path the environment is served under", () => {
    expect(buildOrchestratorUrl("https://relay.example.com/solla/")).toBe(
      "https://relay.example.com/solla/orchestrator",
    );
  });

  it("drops any query or fragment on the stored base", () => {
    expect(buildOrchestratorUrl("http://mac.local:3773/?token=x#frag")).toBe(
      "http://mac.local:3773/orchestrator",
    );
  });

  it("returns null when there is nothing connected", () => {
    // A WebView pointed at "undefined/orchestrator" shows a browser error page,
    // which reads as the feature being broken rather than the phone being off.
    expect(buildOrchestratorUrl(null)).toBeNull();
    expect(buildOrchestratorUrl(undefined)).toBeNull();
    expect(buildOrchestratorUrl("   ")).toBeNull();
    expect(buildOrchestratorUrl("not a url")).toBeNull();
  });

  it("refuses a base that is not an http(s) app server", () => {
    // A malformed stored connection must not be able to aim the WebView
    // somewhere unexpected.
    expect(buildOrchestratorUrl("file:///etc/passwd")).toBeNull();
    expect(buildOrchestratorUrl("javascript:alert(1)")).toBeNull();
    expect(buildOrchestratorUrl("sollacode://app/")).toBeNull();
  });
});

describe("isSameEnvironmentOrigin", () => {
  it("accepts the environment's own pages", () => {
    expect(
      isSameEnvironmentOrigin("http://mac.local:3773/orchestrator", "http://mac.local:3773"),
    ).toBe(true);
  });

  it("rejects anywhere else, so links leave for the system browser", () => {
    expect(isSameEnvironmentOrigin("https://github.com/x", "http://mac.local:3773")).toBe(false);
    // Same host, different port is a different origin and a different server.
    expect(isSameEnvironmentOrigin("http://mac.local:9999/", "http://mac.local:3773")).toBe(false);
  });

  it("rejects rather than throwing on junk", () => {
    expect(isSameEnvironmentOrigin("not a url", "http://mac.local:3773")).toBe(false);
    expect(isSameEnvironmentOrigin("http://mac.local:3773/", null)).toBe(false);
  });
});

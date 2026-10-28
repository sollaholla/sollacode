import { describe, expect, it } from "vite-plus/test";

import { resolveAssetUrl } from "../state/assets.ts";
import {
  classifyHostedHttpsCompatibility,
  createAdvertisedEndpoint,
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
  relayedEnvironmentHttpBaseUrl,
  relayedEnvironmentWsUrl,
} from "./endpoint.ts";

const coreProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
} as const;

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("marks HTTP endpoints as blocked from hosted HTTPS apps", () => {
    expect(classifyHostedHttpsCompatibility("http://192.168.1.44:3773")).toBe(
      "mixed-content-blocked",
    );
    expect(classifyHostedHttpsCompatibility("https://desktop.example.com", "compatible")).toBe(
      "compatible",
    );
  });

  it("creates provider-neutral endpoint records", () => {
    expect(
      createAdvertisedEndpoint({
        id: "lan:http://192.168.1.44:3773",
        label: "LAN",
        provider: coreProvider,
        httpBaseUrl: "http://192.168.1.44:3773",
        reachability: "lan",
        source: "desktop-core",
        isDefault: true,
      }),
    ).toEqual({
      id: "lan:http://192.168.1.44:3773",
      label: "LAN",
      provider: coreProvider,
      httpBaseUrl: "http://192.168.1.44:3773/",
      wsBaseUrl: "ws://192.168.1.44:3773/",
      reachability: "lan",
      compatibility: {
        hostedHttpsApp: "mixed-content-blocked",
        desktopApp: "compatible",
      },
      source: "desktop-core",
      status: "available",
      isDefault: true,
    });
  });
});

describe("environment addresses", () => {
  it("keeps an environment at the root where it always was", () => {
    expect(environmentEndpointUrl("http://10.0.0.5:3773/", "/api/auth/session")).toBe(
      "http://10.0.0.5:3773/api/auth/session",
    );
    expect(resolveAssetUrl("http://10.0.0.5:3773/", "/api/assets/t.sig/a.png")).toBe(
      "http://10.0.0.5:3773/api/assets/t.sig/a.png",
    );
  });

  it("keeps a relayed environment under its host's relay path", () => {
    const base = relayedEnvironmentHttpBaseUrl("https://mac.ts.net/", "windows-env");
    expect(base).toBe("https://mac.ts.net/api/relay/windows-env");
    expect(environmentEndpointUrl(base, "/api/auth/websocket-ticket")).toBe(
      "https://mac.ts.net/api/relay/windows-env/api/auth/websocket-ticket",
    );
    expect(resolveAssetUrl(base, "/api/assets/t.sig/index.html?solla_revision=2")).toBe(
      "https://mac.ts.net/api/relay/windows-env/api/assets/t.sig/index.html?solla_revision=2",
    );
    expect(resolveAssetUrl(base, "https://elsewhere.test/x.png")).toBe(
      "https://elsewhere.test/x.png",
    );
    expect(relayedEnvironmentWsUrl("https://mac.ts.net/", "windows-env")).toBe(
      "wss://mac.ts.net/api/relay/windows-env/ws",
    );
  });
});

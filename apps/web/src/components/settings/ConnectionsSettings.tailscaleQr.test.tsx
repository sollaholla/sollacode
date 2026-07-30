import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  preferVerifiedTailscalePairingEndpoint,
  resolveAdvertisedEndpointPairingUrl,
  resolveVerifiedTailscaleWebEndpoint,
  TailscaleHttpsQrPanel,
} from "./ConnectionsSettings";

function makeEndpoint(overrides: Partial<AdvertisedEndpoint> = {}): AdvertisedEndpoint {
  return {
    id: "tailscale-magicdns:https://desktop.example-tailnet.ts.net/",
    label: "Tailscale HTTPS",
    provider: {
      id: "tailscale",
      label: "Tailscale",
      kind: "private-network",
      isAddon: true,
    },
    httpBaseUrl: "https://desktop.example-tailnet.ts.net/",
    wsBaseUrl: "wss://desktop.example-tailnet.ts.net/",
    reachability: "private-network",
    compatibility: {
      hostedHttpsApp: "compatible",
      desktopApp: "compatible",
    },
    source: "desktop-addon",
    status: "available",
    ...overrides,
  };
}

describe("Tailscale HTTPS QR access", () => {
  it("accepts only a verified private compatible HTTPS endpoint", () => {
    expect(resolveVerifiedTailscaleWebEndpoint(makeEndpoint())).toBe(
      "https://desktop.example-tailnet.ts.net/",
    );
    expect(resolveVerifiedTailscaleWebEndpoint(makeEndpoint({ status: "unknown" }))).toBeNull();
    expect(resolveVerifiedTailscaleWebEndpoint(makeEndpoint({ status: "unavailable" }))).toBeNull();
    expect(
      resolveVerifiedTailscaleWebEndpoint(
        makeEndpoint({
          reachability: "public",
        }),
      ),
    ).toBeNull();
    expect(
      resolveVerifiedTailscaleWebEndpoint(
        makeEndpoint({
          compatibility: {
            hostedHttpsApp: "requires-configuration",
            desktopApp: "compatible",
          },
        }),
      ),
    ).toBeNull();
    expect(
      resolveVerifiedTailscaleWebEndpoint(
        makeEndpoint({
          httpBaseUrl: "http://desktop.example-tailnet.ts.net/",
        }),
      ),
    ).toBeNull();
  });

  it("renders the exact browser endpoint with accessible copy/open controls and tailnet warning", () => {
    const endpointUrl = "https://desktop.example-tailnet.ts.net/";
    const markup = renderToStaticMarkup(
      <TailscaleHttpsQrPanel endpointUrl={endpointUrl} onCopy={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="Tailscale HTTPS phone access"');
    expect(markup).toContain("Solla Code private Tailscale HTTPS endpoint");
    expect(markup).toContain(endpointUrl);
    expect(markup).toContain('aria-label="Copy Tailscale HTTPS URL"');
    expect(markup).toContain('aria-label="Open Tailscale HTTPS URL"');
    expect(markup).toContain(`href="${endpointUrl}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("Your phone must be on the same tailnet.");
    expect(markup).toContain("Existing pairing authorization is still required.");
  });

  it("uses verified private HTTPS for one-time pairing links instead of a LAN fallback", () => {
    const tailscale = makeEndpoint();
    const lan = makeEndpoint({
      id: "desktop-lan:http://192.168.1.20:3773/",
      label: "Local network",
      httpBaseUrl: "http://192.168.1.20:3773/",
      wsBaseUrl: "ws://192.168.1.20:3773/",
      reachability: "lan",
      compatibility: {
        hostedHttpsApp: "requires-configuration",
        desktopApp: "compatible",
      },
      provider: {
        id: "desktop-core",
        label: "Solla Code Desktop",
        kind: "core",
        isAddon: false,
      },
    });

    expect(preferVerifiedTailscalePairingEndpoint(tailscale, lan)).toBe(tailscale);
    expect(
      preferVerifiedTailscalePairingEndpoint(makeEndpoint({ status: "unavailable" }), lan),
    ).toBe(lan);
  });

  it("keeps Tailscale pairing on the private endpoint instead of a hosted T3 service", () => {
    const pairingUrl = new URL(
      resolveAdvertisedEndpointPairingUrl(makeEndpoint(), "ONE_TIME_SECRET"),
    );

    expect(pairingUrl.origin).toBe("https://desktop.example-tailnet.ts.net");
    expect(pairingUrl.pathname).toBe("/pair");
    expect(pairingUrl.search).toBe("");
    expect(pairingUrl.hash).toBe("#token=ONE_TIME_SECRET");
    expect(pairingUrl.href).not.toContain("t3.codes");
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  isPrivateLanAddress,
  lanBroadcastAddresses,
  pairingRequestErrorDetail,
} from "./DesktopLanDiscovery.ts";

describe("DesktopLanDiscovery private-network boundary", () => {
  it.each([
    "10.0.0.12",
    "172.16.1.5",
    "172.31.255.254",
    "192.168.50.3",
    "100.64.0.1",
    "::ffff:192.168.1.20",
    "fd00::20",
    "fe80::1",
  ])("accepts private or tailnet address %s", (address) => {
    expect(isPrivateLanAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111"])(
    "rejects public address %s",
    (address) => {
      expect(isPrivateLanAddress(address)).toBe(false);
    },
  );

  it("broadcasts on every private IPv4 subnet instead of one OS-selected adapter", () => {
    expect(
      lanBroadcastAddresses({
        "Local Area Connection* 10": [
          {
            address: "192.168.137.1",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:01",
            internal: false,
            cidr: "192.168.137.1/24",
          },
        ],
        "Wi-Fi": [
          {
            address: "10.2.1.243",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:02",
            internal: false,
            cidr: "10.2.1.243/24",
          },
        ],
        Tailscale: [
          {
            address: "100.90.80.70",
            netmask: "255.255.255.255",
            family: "IPv4",
            mac: "00:00:00:00:00:03",
            internal: false,
            cidr: "100.90.80.70/32",
          },
        ],
      }),
    ).toEqual(["192.168.137.255", "10.2.1.255"]);
  });

  it("turns transport failures into firewall guidance", () => {
    expect(pairingRequestErrorDetail(new TypeError("fetch failed"))).toContain(
      "allow it through the firewall for the current network profile",
    );
  });

  it("keeps an explicit trust rejection intact", () => {
    expect(
      pairingRequestErrorDetail(new Error("The other device declined the trust request.")),
    ).toBe("The other device declined the trust request.");
  });
});

import type { DesktopLanPeer, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { addableNearbyPeers, isNearbyPeerAlreadyAdded } from "./NearbySollaEnvironments.logic";

const peer = {
  id: "peer-1",
  environmentId: "environment-windows" as EnvironmentId,
  label: "SolomansComputer",
  backendUrl: "http://10.2.1.243:3773",
  lastSeenAt: 1,
} satisfies DesktopLanPeer;

describe("nearby Solla environment filtering", () => {
  it("suppresses a peer whose environment identity is already saved", () => {
    expect(
      isNearbyPeerAlreadyAdded(peer, [
        {
          environmentId: "environment-windows" as EnvironmentId,
          displayUrl: "https://solomanscomputer.example.ts.net",
        },
      ]),
    ).toBe(true);
  });

  it("suppresses legacy peers by canonical endpoint origin", () => {
    expect(
      isNearbyPeerAlreadyAdded(
        { ...peer, environmentId: null, backendUrl: "HTTP://10.2.1.243:3773/" },
        [
          {
            environmentId: "other-environment" as EnvironmentId,
            displayUrl: "http://10.2.1.243:3773",
          },
        ],
      ),
    ).toBe(true);
  });

  it("returns only devices that are not already connected", () => {
    const newPeer = {
      ...peer,
      id: "peer-2",
      environmentId: "environment-mac" as EnvironmentId,
      label: "Other Mac",
      backendUrl: "http://10.2.1.250:3773",
    };
    expect(
      addableNearbyPeers(
        [peer, newPeer],
        [
          {
            environmentId: "environment-windows" as EnvironmentId,
            displayUrl: peer.backendUrl,
          },
        ],
      ),
    ).toEqual([newPeer]);
  });
});

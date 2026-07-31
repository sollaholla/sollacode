import type { DesktopLanPeer, EnvironmentId } from "@t3tools/contracts";

export interface ExistingEnvironmentIdentity {
  readonly environmentId: EnvironmentId;
  readonly displayUrl: string | null;
}

function normalizedEndpointOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function isNearbyPeerAlreadyAdded(
  peer: DesktopLanPeer,
  environments: ReadonlyArray<ExistingEnvironmentIdentity>,
): boolean {
  const peerOrigin = normalizedEndpointOrigin(peer.backendUrl);
  return environments.some(
    (environment) =>
      (peer.environmentId !== null && environment.environmentId === peer.environmentId) ||
      (peerOrigin !== null && normalizedEndpointOrigin(environment.displayUrl) === peerOrigin),
  );
}

export function addableNearbyPeers(
  peers: ReadonlyArray<DesktopLanPeer>,
  environments: ReadonlyArray<ExistingEnvironmentIdentity>,
): ReadonlyArray<DesktopLanPeer> {
  return peers.filter((peer) => !isNearbyPeerAlreadyAdded(peer, environments));
}

import {
  AuthStandardClientScopes,
  type DesktopLanDiscoveryState,
  type DesktopLanPeer,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { RadioTowerIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { connectPairing as connectPairingAtom } from "../../connection/onboarding";
import { createServerPairingCredential, revokeServerPairingLink } from "../../environments/primary";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { addableNearbyPeers } from "./NearbySollaEnvironments.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { resolveDesktopPairingUrl } from "./pairingUrls";

const NEARBY_REFRESH_INTERVAL_MS = 2_000;

export function NearbySollaEnvironments() {
  const bridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const [discovery, setDiscovery] = useState<DesktopLanDiscoveryState | null>(null);
  const [connectingPeerId, setConnectingPeerId] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const refresh = () => {
      void bridge
        .getLanDiscoveryState()
        .then((nextState) => {
          if (!disposed) setDiscovery(nextState);
        })
        .catch((cause) => {
          if (!disposed) {
            setDiscovery({
              status: "retrying",
              peers: [],
              issue: {
                kind: "unknown",
                title: "Could not check nearby devices",
                detail:
                  cause instanceof Error
                    ? cause.message
                    : "Solla Code could not read local discovery status.",
              },
            });
          }
        });
    };
    refresh();
    const interval = window.setInterval(refresh, NEARBY_REFRESH_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [bridge]);

  const connectPeer = useCallback(
    async (peer: DesktopLanPeer) => {
      if (!bridge || connectingPeerId !== null) return;
      setConnectingPeerId(peer.id);
      let initiatorCredentialId: string | null = null;
      try {
        const exposure = await bridge.getServerExposureState();
        if (!exposure.endpointUrl) {
          throw new Error("Private-network access is not available on this device.");
        }
        const credential = await createServerPairingCredential({
          label: `Nearby Solla Code: ${peer.label}`,
          scopes: [...AuthStandardClientScopes],
        });
        initiatorCredentialId = credential.id;
        const pairing = await bridge.requestLanPairing({
          peerId: peer.id,
          initiatorPairingUrl: resolveDesktopPairingUrl(
            exposure.endpointUrl,
            credential.credential,
          ),
        });
        initiatorCredentialId = null;

        const responderConnection = await connectPairing({
          pairingUrl: pairing.responderPairingUrl,
        });
        if (responderConnection._tag === "Failure") {
          if (isAtomCommandInterrupted(responderConnection)) {
            throw new Error("Nearby pairing was cancelled.");
          }
          throw squashAtomCommandFailure(responderConnection);
        }
        toastManager.add({
          type: "success",
          title: "Nearby environment added",
          description: `${peer.label} was added on both devices.`,
        });
      } catch (cause) {
        if (initiatorCredentialId) {
          await revokeServerPairingLink(initiatorCredentialId).catch(() => undefined);
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add nearby environment",
            description:
              cause instanceof Error ? cause.message : "The nearby trust request failed.",
          }),
        );
      } finally {
        setConnectingPeerId(null);
      }
    },
    [bridge, connectPairing, connectingPeerId],
  );

  if (!bridge) return null;
  const discoveredPeers = discovery?.peers ?? [];
  const peers = addableNearbyPeers(discoveredPeers, environments);

  return (
    <SettingsSection title="Nearby Solla Code">
      {discovery?.issue ? (
        <SettingsRow
          title={discovery.issue.title}
          description={
            <>{discovery.issue.detail} Tailscale is not required for nearby connections.</>
          }
          status={
            discovery.status === "retrying" ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner className="size-3.5" />
                Retrying automatically
              </span>
            ) : null
          }
        />
      ) : peers.length === 0 && discoveredPeers.length > 0 ? (
        <SettingsRow
          title="Nearby devices are already connected"
          description="Every Solla Code instance found on this network is already in your environments."
        />
      ) : peers.length === 0 ? (
        <SettingsRow
          title="Searching this network"
          description="Keep Solla Code open on both devices and connect them to the same private Wi-Fi or Ethernet. No Tailscale or access code is required."
        >
          <Spinner className="size-4 text-muted-foreground" />
        </SettingsRow>
      ) : (
        peers.map((peer) => (
          <SettingsRow key={peer.id} title={peer.label} description={peer.backendUrl}>
            <Button
              size="sm"
              variant="outline"
              disabled={connectingPeerId !== null}
              onClick={() => void connectPeer(peer)}
            >
              {connectingPeerId === peer.id ? (
                <>
                  <Spinner className="size-3.5" />
                  Waiting for approval…
                </>
              ) : (
                <>
                  <RadioTowerIcon className="size-3.5" />
                  Trust and add
                </>
              )}
            </Button>
          </SettingsRow>
        ))
      )}
    </SettingsSection>
  );
}

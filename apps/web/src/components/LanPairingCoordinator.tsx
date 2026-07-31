import { AuthStandardClientScopes } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { connectPairing as connectPairingAtom } from "../connection/onboarding";
import { createServerPairingCredential, revokeServerPairingLink } from "../environments/primary";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveDesktopPairingUrl } from "./settings/pairingUrls";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * Completes the responder half of nearby pairing after the native trust
 * prompt is approved. This is mounted globally so pairing is independent of
 * the current tab, thread state, or whether Settings is open.
 */
export function LanPairingCoordinator() {
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const activeRequestsRef = useRef(new Set<string>());

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    return bridge.onLanPairingEvent((event) => {
      if (event.type !== "approved-request" || activeRequestsRef.current.has(event.requestId)) {
        return;
      }
      activeRequestsRef.current.add(event.requestId);

      void (async () => {
        let responderCredentialId: string | null = null;
        try {
          const initiatorConnection = await connectPairing({
            pairingUrl: event.initiatorPairingUrl,
          });
          if (initiatorConnection._tag === "Failure") {
            if (isAtomCommandInterrupted(initiatorConnection)) {
              throw new Error("Nearby pairing was cancelled.");
            }
            throw squashAtomCommandFailure(initiatorConnection);
          }

          const exposure = await bridge.getServerExposureState();
          if (!exposure.endpointUrl) {
            throw new Error("This Solla Code instance does not have a private-network endpoint.");
          }
          const credential = await createServerPairingCredential({
            label: `Nearby Solla Code: ${event.initiatorLabel}`,
            scopes: [...AuthStandardClientScopes],
          });
          responderCredentialId = credential.id;
          await bridge.completeLanPairing({
            requestId: event.requestId,
            responderPairingUrl: resolveDesktopPairingUrl(
              exposure.endpointUrl,
              credential.credential,
            ),
          });
          responderCredentialId = null;
          toastManager.add({
            type: "success",
            title: "Nearby Solla Code trusted",
            description: `${event.initiatorLabel} was added and can reconnect automatically.`,
          });
        } catch (cause) {
          const description =
            cause instanceof Error ? cause.message : "Could not finish nearby pairing.";
          if (responderCredentialId) {
            await revokeServerPairingLink(responderCredentialId).catch(() => undefined);
          }
          await bridge
            .completeLanPairing({
              requestId: event.requestId,
              error: description,
            })
            .catch(() => undefined);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Nearby pairing failed",
              description,
            }),
          );
        } finally {
          activeRequestsRef.current.delete(event.requestId);
        }
      })();
    });
  }, [connectPairing]);

  return null;
}

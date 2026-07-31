import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { CheckCircle2Icon, CopyIcon, RefreshCwIcon, ScanLineIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createServerPairingCredential,
  revokeServerPairingLink,
  type ServerClientSessionRecord,
} from "../../environments/primary";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { resolveDesktopPairingUrl } from "./pairingUrls";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

interface QuickPairingLink {
  readonly id: string;
  readonly url: string;
  readonly expiresAt: string;
}

type QuickConnectState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | { readonly status: "ready"; readonly link: QuickPairingLink }
  | { readonly status: "connected"; readonly link: QuickPairingLink; readonly label: string }
  | { readonly status: "error"; readonly message: string };

export function QuickConnectQrPanel({
  pairingUrl,
  onCopy,
}: {
  pairingUrl: string;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="mx-auto w-fit max-w-full rounded-2xl border border-border/70 bg-white p-3 shadow-sm">
        <QRCodeSvg
          value={pairingUrl}
          size={272}
          level="Q"
          marginSize={4}
          className="h-auto w-full max-w-[17rem]"
          title="Scan to connect this device to Solla Code"
        />
      </div>
      <div className="space-y-2">
        <Textarea
          readOnly
          value={pairingUrl}
          rows={3}
          aria-label="Device connection link"
          className="resize-none break-all text-xs leading-relaxed"
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
        />
        <Button className="w-full" variant="outline" onClick={onCopy}>
          <CopyIcon aria-hidden className="size-4" />
          Copy connection link
        </Button>
      </div>
    </div>
  );
}

export function QuickConnectDevice({
  pairingBaseUrl,
  clientSessions,
}: {
  pairingBaseUrl: string | null;
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<QuickConnectState>({ status: "idle" });
  const initialSessionIdsRef = useRef(new Set<string>());
  const activeLinkRef = useRef<QuickPairingLink | null>(null);

  const { copyToClipboard } = useCopyToClipboard<"link">({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Connection link copied",
        description: "Open it on the device you want to connect.",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy connection link",
          description: error.message,
        }),
      );
    },
  });

  const createLink = useCallback(async () => {
    if (!pairingBaseUrl) {
      setState({
        status: "error",
        message:
          "Turn on Network access below, then reopen this window. Tailscale is not required on a private Wi-Fi or Ethernet network.",
      });
      return;
    }
    setState({ status: "creating" });
    try {
      const credential = await createServerPairingCredential({
        label: "Quick device connection",
        scopes: [...AuthStandardClientScopes],
      });
      const link = {
        id: credential.id,
        url: resolveDesktopPairingUrl(pairingBaseUrl, credential.credential),
        expiresAt: DateTime.formatIso(credential.expiresAt),
      } satisfies QuickPairingLink;
      activeLinkRef.current = link;
      setState({ status: "ready", link });
    } catch (cause) {
      setState({
        status: "error",
        message:
          cause instanceof Error ? cause.message : "Solla Code could not create a connection link.",
      });
    }
  }, [pairingBaseUrl]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        initialSessionIdsRef.current = new Set(
          clientSessions.map((clientSession) => clientSession.sessionId),
        );
        activeLinkRef.current = null;
        void createLink();
        return;
      }
      const activeLink = activeLinkRef.current;
      activeLinkRef.current = null;
      setState({ status: "idle" });
      if (activeLink) {
        void revokeServerPairingLink(activeLink.id).catch(() => undefined);
      }
    },
    [clientSessions, createLink],
  );

  useEffect(() => {
    if (!open || state.status !== "ready") return;
    const connectedSession = clientSessions.find(
      (clientSession) =>
        !clientSession.current && !initialSessionIdsRef.current.has(clientSession.sessionId),
    );
    if (!connectedSession) return;
    setState({
      status: "connected",
      link: state.link,
      label:
        connectedSession.client.label ??
        connectedSession.client.os ??
        connectedSession.client.deviceType,
    });
  }, [clientSessions, open, state]);

  const retry = useCallback(() => {
    const activeLink = activeLinkRef.current;
    activeLinkRef.current = null;
    if (activeLink) {
      void revokeServerPairingLink(activeLink.id).catch(() => undefined);
    }
    void createLink();
  }, [createLink]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button size="sm" />}>
        <ScanLineIcon aria-hidden className="size-4" />
        Show QR code
      </DialogTrigger>
      <DialogPopup className="max-h-[92dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect another device</DialogTitle>
          <DialogDescription>
            Scan with the other device. Solla Code opens and connects automatically—there is no code
            to type.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {state.status === "idle" || state.status === "creating" ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center">
              <Spinner className="size-6" />
              <div>
                <p className="text-sm font-medium text-foreground">Preparing a secure link…</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  This normally takes only a moment.
                </p>
              </div>
            </div>
          ) : state.status === "error" ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
              <div>
                <p className="text-sm font-medium text-foreground">Could not prepare the link</p>
                <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  {state.message}
                </p>
              </div>
              <Button variant="outline" onClick={retry}>
                <RefreshCwIcon aria-hidden className="size-4" />
                Try again
              </Button>
            </div>
          ) : state.status === "connected" ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-4 text-center">
              <CheckCircle2Icon className="size-12 text-success" />
              <div>
                <p className="text-base font-medium text-foreground">Device connected</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {state.label} can now reconnect automatically.
                </p>
              </div>
            </div>
          ) : (
            <>
              <QuickConnectQrPanel
                pairingUrl={state.link.url}
                onCopy={() => copyToClipboard(state.link.url, "link")}
              />
              <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3.5" />
                Waiting for the other device…
              </div>
              <p className="mt-2 text-center text-[11px] text-muted-foreground/75">
                Both devices must be able to reach the same network. Tailscale is optional.
              </p>
            </>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {state.status === "connected" ? "Done" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

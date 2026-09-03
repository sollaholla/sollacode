"use client";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { LoaderCircleIcon, MonitorSmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RemoteControlViewerDialog } from "./RemoteControlViewerDialog";

export function remoteConnectionHeaderAction(input: {
  readonly activeEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly connectionPhase: string | null;
  /** True when this client IS the desktop app — i.e. the machine itself. */
  readonly isDesktopApp: boolean;
}): "hidden" | "connect-control" | "open-control" {
  if (input.primaryEnvironmentId === null) return "hidden";
  // The one case remote control makes no sense is controlling the machine you
  // are sitting at: the desktop app viewing its own environment. A phone or
  // browser viewing its *primary* environment is still a remote device — that
  // environment's desktop is somewhere else — so the button must show there.
  // (This is what previously buried remote control in Settings → Connections
  // for anyone connected to a single machine.)
  if (input.activeEnvironmentId === input.primaryEnvironmentId && input.isDesktopApp) {
    return "hidden";
  }
  return input.connectionPhase === "connected" ? "open-control" : "connect-control";
}

export function RemoteConnectionControl(props: {
  readonly activeEnvironmentId: EnvironmentId;
  /** Extra classes for the trigger, so a header can size it to its neighbours. */
  readonly className?: string | undefined;
}) {
  const { activeEnvironmentId } = props;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(activeEnvironmentId);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, {
    label: "connect remote-control host",
    reportFailure: false,
  });
  const [viewerOpen, setViewerOpen] = useState(false);
  const [pendingEnvironmentId, setPendingEnvironmentId] = useState<EnvironmentId | null>(null);
  const action = remoteConnectionHeaderAction({
    activeEnvironmentId,
    primaryEnvironmentId,
    connectionPhase: environment?.connection.phase ?? null,
    isDesktopApp: window.desktopBridge !== undefined,
  });
  const isConnecting = pendingEnvironmentId === activeEnvironmentId;
  const label = action === "open-control" ? "Remote control" : "Connect and control";

  useEffect(() => {
    setViewerOpen(false);
    setPendingEnvironmentId(null);
  }, [activeEnvironmentId]);

  useEffect(() => {
    if (
      pendingEnvironmentId === activeEnvironmentId &&
      environment?.connection.phase === "connected"
    ) {
      setPendingEnvironmentId(null);
      setViewerOpen(true);
    }
  }, [activeEnvironmentId, environment?.connection.phase, pendingEnvironmentId]);

  if (action === "hidden" || !environment) return null;

  const connectAndOpen = async () => {
    if (action === "open-control") {
      setViewerOpen(true);
      return;
    }

    setPendingEnvironmentId(activeEnvironmentId);
    if (
      environment.connection.phase === "connecting" ||
      environment.connection.phase === "reconnecting"
    ) {
      return;
    }

    const result = await retryEnvironment(activeEnvironmentId);
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;

    setPendingEnvironmentId(null);
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not connect to ${environment.label}`,
        description:
          failure instanceof Error && failure.message.trim()
            ? failure.message
            : "The remote host could not be reached.",
      }),
    );
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              className={props.className}
              aria-label={label}
              disabled={isConnecting}
              onClick={() => void connectAndOpen()}
            />
          }
        >
          {isConnecting ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <MonitorSmartphoneIcon className="size-3.5" />
          )}
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            {isConnecting ? `Connecting to ${environment.label}` : label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {isConnecting ? `Connecting to ${environment.label}…` : label}
        </TooltipPopup>
      </Tooltip>

      {viewerOpen ? (
        <RemoteControlViewerDialog
          environmentId={activeEnvironmentId}
          environmentLabel={environment.label}
          open
          onOpenChange={setViewerOpen}
        />
      ) : null}
    </>
  );
}

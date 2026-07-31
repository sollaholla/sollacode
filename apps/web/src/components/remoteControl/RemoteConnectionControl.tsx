"use client";

import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MonitorSmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RemoteControlViewerDialog } from "./RemoteControlViewerDialog";

export function remoteConnectionHeaderAction(input: {
  readonly activeEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly connectionPhase: string | null;
}): "open-control" | "open-connections" {
  return input.primaryEnvironmentId !== null &&
    input.activeEnvironmentId !== input.primaryEnvironmentId &&
    input.connectionPhase === "connected"
    ? "open-control"
    : "open-connections";
}

export function RemoteConnectionControl(props: { readonly activeEnvironmentId: EnvironmentId }) {
  const { activeEnvironmentId } = props;
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(activeEnvironmentId);
  const [viewerOpen, setViewerOpen] = useState(false);
  const action = remoteConnectionHeaderAction({
    activeEnvironmentId,
    primaryEnvironmentId,
    connectionPhase: environment?.connection.phase ?? null,
  });
  const label = action === "open-control" ? "Remote control" : "Remote connection";

  useEffect(() => {
    setViewerOpen(false);
  }, [activeEnvironmentId]);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-label={label}
              onClick={() => {
                if (action === "open-control") {
                  setViewerOpen(true);
                  return;
                }
                void navigate({ to: "/settings/connections" });
              }}
            />
          }
        >
          <MonitorSmartphoneIcon className="size-3.5" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>

      {viewerOpen && environment ? (
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

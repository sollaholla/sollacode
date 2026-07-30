import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { LoaderCircle } from "lucide-react";
import { memo } from "react";

import { useActiveEnvironmentId } from "../state/entities";
import { useEnvironment, usePrimaryEnvironment } from "../state/environments";

export function isReconnectingOverlayActive(phase: EnvironmentConnectionPhase | null): boolean {
  return phase === "reconnecting";
}

export function ReconnectingOverlayView({
  active,
  label,
}: {
  readonly active: boolean;
  readonly label?: string | undefined;
}) {
  if (!active) return null;

  return (
    <div
      aria-live="assertive"
      className="absolute inset-0 z-[9999] flex flex-col items-center justify-center gap-4 bg-background/92 px-6 text-foreground backdrop-blur-sm pt-safe pb-safe"
      data-reconnecting-overlay
      role="status"
    >
      <LoaderCircle aria-hidden className="size-7 animate-spin text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-medium">Reconnecting</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {label ? `Restoring the connection to ${label}…` : "Restoring the connection…"}
        </p>
      </div>
    </div>
  );
}

export const ReconnectingOverlay = memo(function ReconnectingOverlay() {
  const activeEnvironment = useEnvironment(useActiveEnvironmentId());
  const primaryEnvironment = usePrimaryEnvironment();
  const environment = activeEnvironment ?? primaryEnvironment;

  return (
    <ReconnectingOverlayView
      active={isReconnectingOverlayActive(environment?.connection.phase ?? null)}
      label={environment?.label}
    />
  );
});

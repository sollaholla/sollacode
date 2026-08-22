import type { ProviderDriverKind } from "@t3tools/contracts";
import { TerminalSquare } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export const TERMINAL_WORKING_DOT_CLASS =
  "absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-sky-500 ring-1 ring-background";

export const TerminalSessionIcon = memo(function TerminalSessionIcon({
  working,
  driverKind,
  displayName,
  className = "size-3.5",
  workingLabel = "Terminal working",
}: {
  readonly working: boolean;
  readonly driverKind?: ProviderDriverKind | null;
  readonly displayName?: string | null;
  readonly className?: string;
  readonly workingLabel?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      data-terminal-working={working ? "true" : undefined}
    >
      {driverKind ? (
        <ProviderInstanceIcon
          driverKind={driverKind}
          displayName={displayName ?? driverKind}
          className="size-full"
          iconClassName="size-full"
        />
      ) : (
        <TerminalSquare className="size-full shrink-0" aria-hidden />
      )}
      {working ? (
        <span aria-label={workingLabel} className={TERMINAL_WORKING_DOT_CLASS} role="status" />
      ) : null}
    </span>
  );
});

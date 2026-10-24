import { StorageCleanupPopover } from "./StorageCleanupPopover";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  BatteryChargingIcon,
  BatteryFullIcon,
  BatteryLowIcon,
  BatteryMediumIcon,
} from "lucide-react";
import { memo } from "react";

import { isRemoteDeviceEnvironment } from "~/lib/remoteDevice";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  batterySeverity,
  describeBattery,
  storageSeverity,
  type VitalSeverity,
} from "./HostVitalsChip.logic";

const SEVERITY_CLASS: Record<VitalSeverity, string> = {
  normal: "text-muted-foreground",
  warning: "text-amber-600 dark:text-amber-400",
  critical: "font-medium text-destructive",
};

/**
 * Battery and free disk of the machine a thread runs on, for a client that is
 * not that machine. Retains the last reading through connection interruptions.
 * A machine without a battery simply has no battery half.
 */
export const HostVitalsChip = memo(function HostVitalsChip(props: {
  readonly environmentId: EnvironmentId;
  /** Extra classes for the chip, so a header can hide or size it. */
  readonly className?: string | undefined;
}) {
  const { environmentId, className } = props;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const visible = isRemoteDeviceEnvironment({
    activeEnvironmentId: environmentId,
    primaryEnvironmentId,
    isDesktopApp: window.desktopBridge !== undefined,
  });
  // A null atom means no subscription, so the server samples only for a
  // header that is actually showing the chip.
  const { data } = useEnvironmentQuery(
    visible ? serverEnvironment.hostVitals({ environmentId, input: {} }) : null,
  );
  if (!visible || data === null) return null;

  const { battery, storage } = data;
  if (battery === null && storage === null) return null;

  const BatteryIcon = battery
    ? battery.pluggedIn
      ? BatteryChargingIcon
      : battery.percent < 20
        ? BatteryLowIcon
        : battery.percent < 60
          ? BatteryMediumIcon
          : BatteryFullIcon
    : null;

  return (
    <div
      role="group"
      aria-label="Host status"
      className={cn("inline-flex shrink-0 items-center gap-2 text-xs tabular-nums", className)}
    >
      {battery && BatteryIcon ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="status"
                aria-label={`Battery: ${describeBattery(battery)}`}
                className={cn(
                  "inline-flex items-center gap-1",
                  SEVERITY_CLASS[batterySeverity(battery)],
                )}
              />
            }
          >
            <BatteryIcon className="size-3.5" aria-hidden />
            {battery.percent}%
          </TooltipTrigger>
          <TooltipPopup side="bottom">Battery: {describeBattery(battery)}</TooltipPopup>
        </Tooltip>
      ) : null}
      {storage ? (
        <StorageCleanupPopover
          key={environmentId}
          environmentId={environmentId}
          storage={storage}
          className={SEVERITY_CLASS[storageSeverity(storage)]}
        />
      ) : null}
    </div>
  );
});

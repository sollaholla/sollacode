import type { DeviceSummary, EnvironmentId } from "@t3tools/contracts";
import {
  describeDevice,
  deviceStateLabel,
  orderDevicesForOpening,
} from "@t3tools/client-runtime/devices/device-logic";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, SmartphoneIcon, TabletIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { deviceEnvironment } from "~/state/devices";
import { useAtomCommand } from "~/state/use-atom-command";

import { deviceFailureMessage, deviceKey, useDeviceList } from "../devices/useDevices";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

const COLLAPSED_COUNT = 5;

interface Props {
  environmentId: EnvironmentId;
  /** Loads the device's live view in this tab, exactly as given. */
  onOpenUrl: (url: string) => void;
}

/**
 * Simulators and emulators on this environment's machine, offered on a blank
 * browser tab. Their live views are served on that machine's loopback
 * interface, which only the browser panel rendered there can load, so the
 * list appears for the primary environment only.
 */
export function PreviewDevicesSection({ environmentId, onOpenUrl }: Props) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimary = primaryEnvironmentId === environmentId;
  const { result, refresh, patchDevice } = useDeviceList(isPrimary ? environmentId : null);
  const view = useAtomCommand(deviceEnvironment.view, { reportFailure: false });
  const viewRef = useRef(view);
  viewRef.current = view;
  const navigate = useNavigate();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Set on every mount: React's development double-mount runs the cleanup once.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!isPrimary || result === null || !result.platforms.some((platform) => platform.available)) {
    return null;
  }

  const devices = orderDevicesForOpening(result.devices);
  const shown = showAll ? devices : devices.slice(0, COLLAPSED_COUNT);
  const manage = () => void navigate({ to: "/settings/devices" });

  const open = async (device: DeviceSummary) => {
    if (opening !== null) return;
    const key = deviceKey(device);
    setOpening(key);
    setError(null);
    if (device.state === "off") patchDevice(key, { state: "starting" });
    const outcome = await viewRef.current({
      environmentId,
      input: { platform: device.platform, id: device.id },
    });
    if (!mounted.current) return;
    setOpening(null);
    void refresh();
    const failure = deviceFailureMessage(outcome, `Couldn't open ${device.name}.`);
    if (failure !== null) {
      setError({ key, message: failure });
      return;
    }
    if (outcome._tag === "Success") onOpenUrl(outcome.value.url);
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="preview-devices-heading">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <SmartphoneIcon className="size-4 shrink-0" />
        <h2 id="preview-devices-heading" className="flex-1 font-medium">
          Simulators
        </h2>
        <Button size="xs" variant="ghost" onClick={manage}>
          Manage
        </Button>
      </div>
      <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
        {shown.length === 0 ? (
          <button
            type="button"
            onClick={manage}
            className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <PlusIcon className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">Add a simulator or emulator</span>
              <span className="truncate text-xs text-muted-foreground">
                Choose any iPhone, iPad, or Android model in Settings → Devices.
              </span>
            </span>
          </button>
        ) : (
          shown.map((device) => {
            const key = deviceKey(device);
            const isOpening = opening === key;
            const Glyph = device.kind === "tablet" ? TabletIcon : SmartphoneIcon;
            return (
              <button
                key={key}
                type="button"
                disabled={opening !== null && !isOpening}
                aria-busy={isOpening}
                onClick={() => void open(device)}
                className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Glyph className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {device.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {isOpening
                      ? device.state === "on"
                        ? "Opening…"
                        : "Starting… the first start can take a minute."
                      : describeDevice(device) || deviceStateLabel(device.state)}
                  </span>
                </span>
                <DeviceStateIndicator state={isOpening ? "starting" : device.state} />
              </button>
            );
          })
        )}
      </div>
      {error ? (
        <p className="px-1 text-xs text-destructive" role="alert">
          {error.message}
        </p>
      ) : null}
      {devices.length > COLLAPSED_COUNT ? (
        <button
          type="button"
          className="self-start px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll ? "Show fewer" : `Show all ${devices.length} devices`}
        </button>
      ) : null}
      <p className="px-1 text-xs text-muted-foreground">
        Select a device to use it live in this tab: click, drag, and type.
      </p>
    </section>
  );
}

function DeviceStateIndicator({ state }: { state: DeviceSummary["state"] }) {
  if (state === "starting" || state === "stopping") {
    return <Spinner className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return (
    <span
      aria-label={deviceStateLabel(state)}
      className={
        state === "on"
          ? "size-2 shrink-0 rounded-full bg-success"
          : "size-2 shrink-0 rounded-full bg-muted-foreground/40"
      }
    />
  );
}

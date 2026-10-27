import type { DevicePlatform, DeviceSummary, EnvironmentId } from "@t3tools/contracts";
import {
  DEVICE_PLATFORM_COLLECTIONS,
  describeDevice,
  deviceStateLabel,
} from "@t3tools/client-runtime/devices/device-logic";
import {
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  TabletIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { deviceEnvironment } from "~/state/devices";
import { useAtomCommand } from "~/state/use-atom-command";

import { AddDeviceDialog } from "../devices/AddDeviceDialog";
import { deviceFailureMessage, deviceKey, useDeviceList } from "../devices/useDevices";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { confirmInApp } from "../ui/appConfirm";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const PLATFORM_ORDER: ReadonlyArray<DevicePlatform> = ["ios", "android"];

/**
 * Settings → Devices: the iOS simulators and Android emulators on the
 * computer running Solla Code. Add any model the installed tools offer,
 * start or shut one down, or remove it. Devices are opened from the browser
 * panel in a chat.
 */
export function DevicesSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <div className="py-10 text-center text-sm text-muted-foreground">Connecting…</div>
      </SettingsPageContainer>
    );
  }
  return <DevicesSettingsView key={environmentId} environmentId={environmentId} />;
}

function DevicesSettingsView({ environmentId }: { environmentId: EnvironmentId }) {
  const { result, error, refreshing, refresh, patchDevice } = useDeviceList(environmentId);
  const setPower = useAtomCommand(deviceEnvironment.setPower, { reportFailure: false });
  const remove = useAtomCommand(deviceEnvironment.remove, { reportFailure: false });
  const commands = useRef({ setPower, remove });
  commands.current = { setPower, remove };
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const markBusy = (key: string, value: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });

  const togglePower = async (device: DeviceSummary) => {
    const key = deviceKey(device);
    const on = device.state === "off";
    markBusy(key, true);
    setActionError(null);
    patchDevice(key, { state: on ? "starting" : "stopping" });
    const outcome = await commands.current.setPower({
      environmentId,
      input: { platform: device.platform, id: device.id, on },
    });
    markBusy(key, false);
    const failure = deviceFailureMessage(
      outcome,
      on ? `Couldn't start ${device.name}.` : `Couldn't shut down ${device.name}.`,
    );
    if (failure !== null) setActionError(failure);
    void refresh();
  };

  const removeDevice = async (device: DeviceSummary) => {
    const kind = device.platform === "ios" ? "simulator" : "emulator";
    const confirmed = await confirmInApp(
      `Remove ${device.name}? This deletes the ${kind} and every app and file on it.`,
      { confirmLabel: "Remove" },
    );
    if (!confirmed) return;
    const key = deviceKey(device);
    markBusy(key, true);
    setActionError(null);
    const outcome = await commands.current.remove({
      environmentId,
      input: { platform: device.platform, id: device.id },
    });
    markBusy(key, false);
    const failure = deviceFailureMessage(outcome, `Couldn't remove ${device.name}.`);
    if (failure !== null) setActionError(failure);
    else patchDevice(key, null);
    void refresh();
  };

  const availablePlatforms = PLATFORM_ORDER.filter(
    (platform) =>
      result?.platforms.find((status) => status.platform === platform)?.available === true,
  );

  let content;
  if (result === null && error !== null) {
    content = (
      <Alert variant="error">
        <SmartphoneIcon />
        <AlertTitle>Couldn't load devices</AlertTitle>
        <AlertDescription>
          <p>{error}</p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => void refresh()}>
            <RefreshCwIcon />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (result === null) {
    content = (
      <div className="py-10 text-center text-sm text-muted-foreground">Loading devices…</div>
    );
  } else {
    content = (
      <div className="space-y-6">
        {PLATFORM_ORDER.map((platform) => {
          const status = result.platforms.find((entry) => entry.platform === platform);
          const devices = result.devices.filter((device) => device.platform === platform);
          return (
            <div key={platform} className="space-y-2">
              <h3 className="px-3 text-sm font-medium text-muted-foreground sm:px-4">
                {DEVICE_PLATFORM_COLLECTIONS[platform]}
              </h3>
              {status?.available !== true ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                  {status?.detail ?? "Not available on this computer."}
                </p>
              ) : devices.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                  No {platform === "ios" ? "simulators" : "emulators"} yet.{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                    onClick={() => setAdding(true)}
                  >
                    Add one
                  </button>
                </p>
              ) : (
                <ul className="space-y-2" aria-label={DEVICE_PLATFORM_COLLECTIONS[platform]}>
                  {devices.map((device) => (
                    <DeviceRow
                      key={deviceKey(device)}
                      device={device}
                      busy={busy.has(deviceKey(device))}
                      onTogglePower={() => void togglePower(device)}
                      onRemove={() => void removeDevice(device)}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="setting-devices"
        title="Devices"
        icon={<SmartphoneIcon className="size-5" />}
        headerAction={
          availablePlatforms.length > 0 ? (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add device
            </Button>
          ) : null
        }
      >
        <p className="mb-4 max-w-2xl px-3 text-sm leading-relaxed text-muted-foreground sm:px-4">
          iPhone, iPad, and Android devices that run on the computer running Solla Code. Open one
          from the browser panel in any chat to see it live and use it with your mouse and keyboard,
          from this computer or a connected phone.
        </p>
        {actionError ? (
          <Alert variant="error" className="mb-3">
            <SmartphoneIcon />
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}
        {result !== null && error !== null ? (
          <p className="mb-3 px-3 text-xs text-muted-foreground sm:px-4">
            Couldn't refresh: {error}
            {refreshing ? null : (
              <button
                type="button"
                className="ms-2 font-medium text-foreground hover:underline"
                onClick={() => void refresh()}
              >
                Try again
              </button>
            )}
          </p>
        ) : null}
        {content}
      </SettingsSection>
      {adding ? (
        <AddDeviceDialog
          open
          onOpenChange={(open) => {
            if (!open) setAdding(false);
          }}
          environmentId={environmentId}
          platforms={availablePlatforms}
          onAdded={() => void refresh()}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function DeviceRow(props: {
  readonly device: DeviceSummary;
  readonly busy: boolean;
  readonly onTogglePower: () => void;
  readonly onRemove: () => void;
}) {
  const { device } = props;
  const Glyph = device.kind === "tablet" ? TabletIcon : SmartphoneIcon;
  const changing = device.state === "starting" || device.state === "stopping";
  const detail = describeDevice(device);
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <Glyph className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{device.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {detail ? `${detail} · ` : ""}
          <span className={device.state === "on" ? "text-success" : undefined}>
            {deviceStateLabel(device.state)}
          </span>
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.busy || changing}
        onClick={props.onTogglePower}
      >
        {props.busy || changing ? <Spinner className="size-3.5" /> : <PowerIcon />}
        {device.state === "off" ? "Start" : "Shut down"}
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove ${device.name}`}
        disabled={props.busy || changing}
        onClick={props.onRemove}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

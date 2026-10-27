import type {
  DeviceKind,
  DeviceModelOption,
  DevicePlatformCatalog,
  DeviceState,
  DeviceSummary,
  DeviceSystemOption,
} from "@t3tools/contracts";

/** The parts of `xcrun simctl list -j` the device manager reads. */
export interface SimctlList {
  readonly devicetypes?: ReadonlyArray<{
    readonly identifier: string;
    readonly name: string;
    readonly productFamily?: string;
  }>;
  readonly runtimes?: ReadonlyArray<{
    readonly identifier: string;
    readonly name: string;
    readonly version?: string;
    readonly platform?: string;
    readonly isAvailable?: boolean;
    readonly supportedDeviceTypes?: ReadonlyArray<{
      readonly identifier: string;
      readonly name: string;
      readonly productFamily?: string;
    }>;
  }>;
  readonly devices?: Readonly<
    Record<
      string,
      ReadonlyArray<{
        readonly udid: string;
        readonly name: string;
        readonly state: string;
        readonly isAvailable?: boolean;
        readonly deviceTypeIdentifier?: string;
      }>
    >
  >;
}

const SUPPORTED_FAMILIES = new Map<string, DeviceKind>([
  ["iPhone", "phone"],
  ["iPad", "tablet"],
]);

/** Only iPhone and iPad runtimes; watchOS, tvOS, and visionOS are not offered. */
function iosRuntimes(list: SimctlList) {
  return (list.runtimes ?? []).filter(
    (runtime) =>
      runtime.isAvailable !== false &&
      (runtime.platform === "iOS" || runtime.identifier.includes(".SimRuntime.iOS-")),
  );
}

function compareVersionsDescending(left: string | undefined, right: string | undefined): number {
  const a = (left ?? "0").split(".").map(Number);
  const b = (right ?? "0").split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function simctlDeviceState(state: string): DeviceState {
  switch (state) {
    case "Booted":
      return "on";
    case "Booting":
    case "Creating":
      return "starting";
    case "Shutting Down":
      return "stopping";
    default:
      return "off";
  }
}

/** Every available iPhone and iPad simulator, newest system first. */
export function parseSimulators(list: SimctlList): DeviceSummary[] {
  const runtimes = iosRuntimes(list).toSorted((left, right) =>
    compareVersionsDescending(left.version, right.version),
  );
  const deviceTypes = new Map<string, { name: string; productFamily?: string | undefined }>();
  for (const type of list.devicetypes ?? []) deviceTypes.set(type.identifier, type);
  for (const runtime of runtimes) {
    for (const type of runtime.supportedDeviceTypes ?? []) {
      if (!deviceTypes.has(type.identifier)) deviceTypes.set(type.identifier, type);
    }
  }

  const devices: DeviceSummary[] = [];
  for (const runtime of runtimes) {
    for (const device of list.devices?.[runtime.identifier] ?? []) {
      if (device.isAvailable === false) continue;
      const type = device.deviceTypeIdentifier
        ? deviceTypes.get(device.deviceTypeIdentifier)
        : undefined;
      const kind = SUPPORTED_FAMILIES.get(type?.productFamily ?? "") ?? null;
      if (kind === null) continue;
      devices.push({
        platform: "ios",
        id: device.udid,
        name: device.name,
        model: type?.name ?? null,
        system: runtime.name,
        kind,
        state: simctlDeviceState(device.state),
      });
    }
  }
  return devices;
}

/**
 * Models and iOS versions a new simulator can be created with. Models follow
 * Xcode's own newest-first order; each version lists the models it runs on.
 */
export function simulatorCatalog(list: SimctlList): DevicePlatformCatalog {
  const runtimes = iosRuntimes(list).toSorted((left, right) =>
    compareVersionsDescending(left.version, right.version),
  );
  const models = new Map<string, DeviceModelOption>();
  const systems: DeviceSystemOption[] = [];
  for (const runtime of runtimes) {
    const modelIds: string[] = [];
    for (const type of runtime.supportedDeviceTypes ?? []) {
      const kind = SUPPORTED_FAMILIES.get(type.productFamily ?? "");
      if (kind === undefined) continue;
      modelIds.push(type.identifier);
      if (!models.has(type.identifier)) {
        models.set(type.identifier, { id: type.identifier, name: type.name, kind });
      }
    }
    if (modelIds.length > 0) {
      systems.push({ id: runtime.identifier, name: runtime.name, modelIds });
    }
  }
  const ordered = [...models.values()];
  return {
    platform: "ios",
    models: [
      ...ordered.filter((model) => model.kind === "phone"),
      ...ordered.filter((model) => model.kind === "tablet"),
    ],
    systems,
    detail:
      systems.length === 0
        ? "Install an iOS simulator runtime from Xcode → Settings → Components first."
        : null,
  };
}

/** The state file serve-sim writes to `$TMPDIR/serve-sim/server-<udid>.json`. */
export interface ServeSimServerState {
  readonly pid: number;
  readonly port: number;
  readonly device: string;
}

export function parseServeSimServerState(text: string): ServeSimServerState | null {
  try {
    const value = JSON.parse(text) as Partial<Record<keyof ServeSimServerState, unknown>>;
    if (
      typeof value.pid === "number" &&
      typeof value.port === "number" &&
      typeof value.device === "string"
    ) {
      return { pid: value.pid, port: value.port, device: value.device };
    }
  } catch {
    // A file caught mid-write reads as missing; the next poll sees it whole.
  }
  return null;
}

/** The viewer URL for one simulator on a running serve-sim preview server. */
export function serveSimViewerUrl(state: ServeSimServerState): string {
  return `http://127.0.0.1:${state.port}/?device=${encodeURIComponent(state.device)}`;
}

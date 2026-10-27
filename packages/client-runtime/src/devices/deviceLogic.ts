import type {
  DeviceCatalog,
  DeviceModelOption,
  DevicePlatform,
  DevicePlatformCatalog,
  DeviceState,
  DeviceSummary,
  DeviceSystemOption,
} from "@t3tools/contracts";

export const DEVICE_PLATFORM_LABELS: Record<DevicePlatform, string> = {
  ios: "iOS",
  android: "Android",
};

export const DEVICE_PLATFORM_COLLECTIONS: Record<DevicePlatform, string> = {
  ios: "iOS simulators",
  android: "Android emulators",
};

/** "iPhone 17 Pro · iOS 26.5", skipping whatever the tools didn't report. */
export function describeDevice(device: DeviceSummary): string {
  const parts = [device.model !== device.name ? device.model : null, device.system];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

export function deviceStateLabel(state: DeviceState): string {
  switch (state) {
    case "on":
      return "Running";
    case "starting":
      return "Starting…";
    case "stopping":
      return "Shutting down…";
    case "off":
      return "Off";
  }
}

/** A device in the middle of starting or stopping, so its list should refresh soon. */
export function isDeviceChanging(device: DeviceSummary): boolean {
  return device.state === "starting" || device.state === "stopping";
}

/**
 * Running devices first, then phones before tablets; otherwise the server's
 * order, which is newest system first.
 */
export function orderDevicesForOpening(devices: ReadonlyArray<DeviceSummary>): DeviceSummary[] {
  const rank = (device: DeviceSummary) =>
    (device.state === "off" ? 2 : 0) + (device.kind === "tablet" ? 1 : 0);
  return devices
    .map((device, index) => ({ device, index }))
    .toSorted((left, right) => rank(left.device) - rank(right.device) || left.index - right.index)
    .map(({ device }) => device);
}

export interface DeviceDraft {
  readonly platform: DevicePlatform;
  readonly modelId: string;
  readonly systemId: string;
  readonly name: string;
  /** False until the person types a name; until then it follows the model. */
  readonly nameEdited: boolean;
}

/** Systems that run a model, newest first. */
export function systemsForModel(
  catalog: DevicePlatformCatalog,
  modelId: string,
): DeviceSystemOption[] {
  return catalog.systems.filter(
    (system) => system.modelIds.length === 0 || system.modelIds.includes(modelId),
  );
}

export function findCatalog(
  catalog: DeviceCatalog | null,
  platform: DevicePlatform,
): DevicePlatformCatalog | null {
  return catalog?.platforms.find((entry) => entry.platform === platform) ?? null;
}

function modelName(catalog: DevicePlatformCatalog, modelId: string): string {
  return catalog.models.find((model) => model.id === modelId)?.name ?? "";
}

/** The newest model on the newest system: what most people want to test on. */
export function initialDeviceDraft(catalog: DevicePlatformCatalog): DeviceDraft {
  const model: DeviceModelOption | undefined = catalog.models[0];
  const system = model ? systemsForModel(catalog, model.id)[0] : undefined;
  return {
    platform: catalog.platform,
    modelId: model?.id ?? "",
    systemId: system?.id ?? "",
    name: model?.name ?? "",
    nameEdited: false,
  };
}

/** Picks a model, keeping the chosen system when it still runs that model. */
export function selectDeviceModel(
  catalog: DevicePlatformCatalog,
  draft: DeviceDraft,
  modelId: string,
): DeviceDraft {
  const systems = systemsForModel(catalog, modelId);
  const systemId = systems.some((system) => system.id === draft.systemId)
    ? draft.systemId
    : (systems[0]?.id ?? "");
  return {
    ...draft,
    modelId,
    systemId,
    name: draft.nameEdited ? draft.name : modelName(catalog, modelId),
  };
}

/** Why a draft can't be added yet, or null when it can. */
export function deviceDraftProblem(
  catalog: DevicePlatformCatalog,
  draft: DeviceDraft,
): string | null {
  if (catalog.detail) return catalog.detail;
  if (!catalog.models.some((model) => model.id === draft.modelId)) return "Choose a model.";
  if (!systemsForModel(catalog, draft.modelId).some((system) => system.id === draft.systemId)) {
    return "Choose a system version.";
  }
  if (draft.name.trim().length === 0) return "Give it a name.";
  return null;
}

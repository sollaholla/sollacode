import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import {
  buildProviderInstanceUpdatePatch,
  resolveDefaultProviderInstance,
} from "../settings/SettingsPanels.logic";
import {
  PROVIDER_CLIENT_DEFINITIONS,
  type ProviderClientDefinition,
} from "../settings/providerDriverMeta";

/** One built-in provider offered during first-run setup. */
export interface ProviderSetupOption {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly definition: ProviderClientDefinition;
  readonly enabled: boolean;
  readonly provider: ServerProvider | null;
}

/** What a selected provider still needs before it can run a thread. */
export type ProviderSetupNeed =
  | { readonly kind: "checking" }
  | { readonly kind: "ready"; readonly account: string | null }
  | { readonly kind: "installing" }
  | {
      readonly kind: "install";
      readonly canInstall: boolean;
      readonly command: string | null;
      readonly error: string | null;
    }
  | { readonly kind: "sign-in-in-app" }
  | { readonly kind: "sign-in-terminal"; readonly command: string }
  | { readonly kind: "sign-in-settings" }
  | { readonly kind: "attention"; readonly detail: string };

type ProviderSettingsSlice = Pick<ServerSettings, "providers" | "providerInstances">;

const CURSOR = ProviderDriverKind.make("cursor");
const MCP_BRIDGE = ProviderDriverKind.make("mcpBridge");

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

function effectiveInstance(settings: ProviderSettingsSlice, driver: ProviderDriverKind) {
  const legacy = settings.providers as Record<string, LegacyProviderSettings | undefined>;
  const defaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  return resolveDefaultProviderInstance({
    driver,
    explicitInstance: settings.providerInstances?.[defaultInstanceIdForDriver(driver)],
    legacyConfig: legacy[driver],
    defaultLegacyConfig: defaults[driver],
  }).instance;
}

/**
 * Built-in providers in their canonical order. The MCP bridge is an advanced
 * integration, and Cursor stays hidden unless this server ships it, matching
 * Settings → Providers.
 */
export function deriveProviderSetupOptions(input: {
  readonly settings: ProviderSettingsSlice;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ProviderSetupOption[] {
  return PROVIDER_CLIENT_DEFINITIONS.flatMap((definition) => {
    const driver = definition.value;
    if (driver === MCP_BRIDGE) return [];
    const instanceId = defaultInstanceIdForDriver(driver);
    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    if (driver === CURSOR && provider === undefined) return [];
    return [
      {
        driver,
        instanceId,
        definition,
        enabled: effectiveInstance(input.settings, driver).enabled ?? true,
        provider: provider ?? null,
      },
    ];
  });
}

/** True while the server has not finished its first check of an enabled provider. */
export function isProviderSetupChecking(option: ProviderSetupOption): boolean {
  const provider = option.provider;
  if (provider === null) return true;
  // A provider that was just switched on still reports its disabled snapshot.
  if (!provider.enabled) return option.enabled;
  return !provider.installed && provider.status === "warning" && provider.auth.status === "unknown";
}

/** Detected on this computer: installed, whether or not it is signed in yet. */
export function isProviderDetected(option: ProviderSetupOption): boolean {
  return option.provider?.enabled === true && option.provider.installed;
}

/**
 * Providers selected before the person touches anything: whatever is already
 * installed. Nothing is selected when no CLI was found, so setup never turns
 * on a provider the person did not choose.
 */
export function defaultProviderSetupSelection(
  options: ReadonlyArray<ProviderSetupOption>,
): ReadonlySet<ProviderDriverKind> {
  return new Set(options.filter(isProviderDetected).map((option) => option.driver));
}

/** Short status shown beside a provider while choosing. */
export function describeProviderSetupDetection(option: ProviderSetupOption): string {
  const provider = option.provider;
  if (provider !== null && provider.enabled && provider.installed) {
    if (provider.auth.status === "authenticated") {
      const account = provider.auth.email ?? provider.auth.label;
      return account ? `Signed in as ${account}` : "Installed and signed in";
    }
    return "Installed on this computer";
  }
  if (!option.enabled) return "Not checked while off";
  if (isProviderSetupChecking(option)) return "Checking this computer…";
  return "Not installed";
}

/**
 * The settings change that leaves exactly the selected built-in providers on.
 * Providers already in the requested state are left untouched.
 */
export function buildProviderSetupEnablementPatch(input: {
  readonly settings: ProviderSettingsSlice;
  readonly options: ReadonlyArray<ProviderSetupOption>;
  readonly selection: ReadonlySet<ProviderDriverKind>;
}): Partial<UnifiedSettings> | null {
  let current: ProviderSettingsSlice = input.settings;
  let changed = false;
  for (const option of input.options) {
    const instance = effectiveInstance(current, option.driver);
    const enabled = input.selection.has(option.driver);
    if ((instance.enabled ?? true) === enabled) continue;
    const patch = buildProviderInstanceUpdatePatch({
      settings: current,
      instanceId: option.instanceId,
      instance: { ...instance, enabled },
      driver: option.driver,
      isDefault: true,
    });
    current = {
      providers: patch.providers ?? current.providers,
      providerInstances: patch.providerInstances ?? current.providerInstances,
    };
    changed = true;
  }
  return changed
    ? { providers: current.providers, providerInstances: current.providerInstances }
    : null;
}

/** What a selected provider still needs, in the order a person resolves it. */
export function deriveProviderSetupNeed(option: ProviderSetupOption): ProviderSetupNeed {
  const provider = option.provider;
  const installStatus = provider?.installState?.status;
  if (installStatus === "queued" || installStatus === "running") return { kind: "installing" };
  if (provider === null || isProviderSetupChecking(option)) return { kind: "checking" };
  if (!provider.installed) {
    const advisory = provider.versionAdvisory;
    return {
      kind: "install",
      canInstall: advisory?.canInstall === true && provider.availability !== "unavailable",
      command: advisory?.installCommand ?? null,
      error:
        installStatus === "failed"
          ? (provider.installState?.message ?? "The install did not finish.")
          : null,
    };
  }
  if (provider.auth.status === "authenticated") {
    return { kind: "ready", account: provider.auth.email ?? provider.auth.label ?? null };
  }
  if (provider.auth.status === "unauthenticated") {
    if (provider.supportsAccountSwitch === true) return { kind: "sign-in-in-app" };
    if (provider.auth.signInCommand) {
      return { kind: "sign-in-terminal", command: provider.auth.signInCommand };
    }
    return { kind: "sign-in-settings" };
  }
  if (provider.status === "error") {
    return {
      kind: "attention",
      detail: provider.message ?? "This provider did not pass its startup check.",
    };
  }
  // Installed, with no way to confirm the account (API-key providers, or a
  // CLI that does not report it). It can still run threads.
  return { kind: "ready", account: null };
}

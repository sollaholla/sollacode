import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import { providerUsageAccountKey } from "./providerUsageStore";

export interface ProviderAccountProfile {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly accountLabel: string;
  readonly email: string | null;
  readonly accountKey: string;
  readonly isActive: boolean;
}

export interface ProviderNativeLoginTarget {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
}

export interface ProviderAccountProfileState {
  readonly activeProfile: ProviderAccountProfile | null;
  readonly profiles: ReadonlyArray<ProviderAccountProfile>;
  readonly nativeLoginTargets: ReadonlyArray<ProviderNativeLoginTarget>;
  readonly supportsNativeLogin: boolean;
}

function providerDisplayName(provider: ServerProvider): string {
  return provider.displayName?.trim() || String(provider.instanceId);
}

function providerAccountLabel(provider: ServerProvider): string {
  return (
    provider.auth.email?.trim() ||
    provider.auth.label?.trim() ||
    provider.auth.type?.trim() ||
    providerDisplayName(provider)
  );
}

function isConfiguredProvider(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.status !== "disabled"
  );
}

function exposesNativeLogin(provider: ServerProvider): boolean {
  return provider.slashCommands.some(
    (command) => command.name.trim().toLocaleLowerCase() === "login",
  );
}

/**
 * Projects configured provider instances into account profiles without
 * creating a second authentication system. A profile is selectable only when
 * that exact provider instance reports an authenticated provider account.
 */
export function deriveProviderAccountProfileState(
  providers: ReadonlyArray<ServerProvider>,
  activeInstanceId: ProviderInstanceId,
): ProviderAccountProfileState {
  const activeProvider = providers.find((provider) => provider.instanceId === activeInstanceId);
  if (!activeProvider) {
    return {
      activeProfile: null,
      profiles: [],
      nativeLoginTargets: [],
      supportsNativeLogin: false,
    };
  }

  const matchingProviders = providers.filter(
    (provider) => provider.driver === activeProvider.driver && isConfiguredProvider(provider),
  );
  const supportsNativeLogin = matchingProviders.some(exposesNativeLogin);
  const profiles = matchingProviders.flatMap((provider): ProviderAccountProfile[] => {
    const accountKey = providerUsageAccountKey(provider);
    if (provider.auth.status !== "authenticated" || accountKey === null) return [];
    return [
      {
        instanceId: provider.instanceId,
        driver: provider.driver,
        displayName: providerDisplayName(provider),
        accountLabel: providerAccountLabel(provider),
        email: provider.auth.email?.trim() || null,
        accountKey,
        isActive: provider.instanceId === activeInstanceId,
      },
    ];
  });

  return {
    activeProfile: profiles.find((profile) => profile.instanceId === activeInstanceId) ?? null,
    profiles,
    nativeLoginTargets: supportsNativeLogin
      ? matchingProviders.flatMap((provider): ProviderNativeLoginTarget[] =>
          provider.auth.status === "unauthenticated"
            ? [
                {
                  instanceId: provider.instanceId,
                  displayName: providerDisplayName(provider),
                },
              ]
            : [],
        )
      : [],
    supportsNativeLogin,
  };
}

export function providerAccountSwitchDisabledReason(input: {
  readonly isRunning: boolean;
  readonly isBusy: boolean;
  readonly isConnecting: boolean;
  readonly hasPendingInteraction: boolean;
  readonly hasVoiceOperation: boolean;
}): string | null {
  if (input.isRunning) return "Finish or stop the active turn before switching accounts.";
  if (input.hasPendingInteraction) {
    return "Resolve the current provider question or approval before switching accounts.";
  }
  if (input.hasVoiceOperation) return "Finish the voice message before switching accounts.";
  if (input.isConnecting || input.isBusy) {
    return "Wait for the current chat operation before switching accounts.";
  }
  return null;
}

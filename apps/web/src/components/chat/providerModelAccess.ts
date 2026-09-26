import type { ServerProvider } from "@t3tools/contracts";

/**
 * What to tell someone whose provider pane has no models in it.
 *
 * An empty list is the same shape whether the provider is still probing, needs
 * a sign-in, or is signed in on an account with nothing to sell you — so the
 * picker used to draw an empty pane and leave the person to work out which.
 * Each case here carries the one thing that resolves it.
 */
export type ProviderModelAccessNotice = {
  readonly title: string;
  readonly detail: string;
  readonly action:
    | { readonly kind: "switch-account"; readonly label: string }
    | { readonly kind: "link"; readonly label: string; readonly href: string }
    | null;
};

/**
 * Whether this provider signs in through something the app can start.
 *
 * API-key providers have an in-app account screen. A CLI that owns its own
 * browser login has no such screen, but the app can still *run* its login
 * command in a terminal pane instead of printing it and asking the person to
 * type it somewhere else - so those count too, and the notice offers the same
 * Switch account action for both.
 */
function hasInAppAccountSwitch(driver: string, signInCommand: string | undefined): boolean {
  return driver === "deepcode" || (signInCommand?.trim().length ?? 0) > 0;
}

export function describeProviderModelAccess(
  provider: ServerProvider | undefined,
  options: { readonly canSwitchAccount: boolean },
): ProviderModelAccessNotice | null {
  if (!provider) return null;
  if (!provider.enabled) {
    return {
      title: "Provider disabled",
      detail: "Enable it in Settings to use its models.",
      action: null,
    };
  }
  if (!provider.installed) {
    return {
      title: "Not installed",
      detail: `Install ${provider.displayName} from Settings, then sign in.`,
      action: null,
    };
  }

  const access = provider.modelAccess;
  if (access?.state === "no-plan") {
    return {
      title: "No plan on this account",
      detail: access.detail,
      action: access.url ? { kind: "link", label: "View plans", href: access.url } : null,
    };
  }
  if (access?.state === "signed-out" || provider.auth.status === "unauthenticated") {
    const detail = access?.detail ?? `Sign in to ${provider.displayName} to load its models.`;
    if (
      options.canSwitchAccount &&
      hasInAppAccountSwitch(provider.driver, provider.auth.signInCommand)
    ) {
      return {
        title: "Not signed in",
        detail,
        action: { kind: "switch-account", label: "Sign in" },
      };
    }
    // No command to run and no account screen: say what is true and stop.
    // This used to append "Run `<command>` on the host", which made the app's
    // own sign-in the person's errand.
    return { title: "Not signed in", detail, action: null };
  }
  return null;
}

import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { CheckIcon, LogInIcon, UserRoundIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { deriveProviderAccountProfileState } from "../../providerAccountProfiles";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export interface ProviderAccountSwitcherProps {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activeInstanceId: ProviderInstanceId;
  readonly disabledReason: string | null;
  readonly hasDraftContent: boolean;
  readonly onSelectProfile: (instanceId: ProviderInstanceId) => void;
  readonly onPrepareNativeLogin: (instanceId: ProviderInstanceId) => void;
}

export const ProviderAccountSwitcher = memo(function ProviderAccountSwitcher(
  props: ProviderAccountSwitcherProps,
) {
  const [open, setOpen] = useState(false);
  const state = useMemo(
    () => deriveProviderAccountProfileState(props.providers, props.activeInstanceId),
    [props.activeInstanceId, props.providers],
  );
  const activeProvider = props.providers.find(
    (provider) => provider.instanceId === props.activeInstanceId,
  );
  if (!activeProvider) return null;

  const activeLabel =
    state.activeProfile?.accountLabel ??
    (activeProvider.auth.status === "unauthenticated" ? "Not signed in" : "Account unavailable");
  const triggerLabel = `Provider account: ${activeLabel}`;
  const loginDisabledReason =
    props.disabledReason ??
    (props.hasDraftContent ? "Send or stash the current draft before starting /login." : null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-chat-provider-account-switcher="true"
            className={cn(
              "flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-2 text-muted-foreground shadow-xs transition-colors hover:bg-muted/70 hover:text-foreground sm:h-8 sm:min-w-8",
              open && "bg-muted/70 text-foreground",
            )}
            aria-label={triggerLabel}
            title={triggerLabel}
          />
        }
      >
        <ProviderInstanceIcon
          driverKind={activeProvider.driver}
          displayName={activeProvider.displayName ?? String(activeProvider.instanceId)}
          accentColor={activeProvider.accentColor}
          className="size-4"
          iconClassName="size-4"
          indicatorBackground="var(--background)"
        />
        <UserRoundIcon className="size-3" aria-hidden="true" />
      </PopoverTrigger>

      <PopoverPopup
        align="end"
        side="top"
        className="w-[min(22rem,calc(100vw-1rem))]"
        viewportClassName="space-y-3 p-3"
        aria-label="Provider account profiles"
      >
        <div>
          <p className="text-sm font-medium">Provider account</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The selected account applies to the next turn in this conversation. Solla Code continues
            the same thread with a context handoff and never shares a provider-native session
            between accounts.
          </p>
        </div>

        <div className="space-y-1" aria-label="Authenticated provider profiles">
          {state.profiles.length > 0 ? (
            state.profiles.map((profile) => {
              const disabled = props.disabledReason !== null || profile.isActive;
              return (
                <button
                  key={profile.instanceId}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors",
                    profile.isActive
                      ? "bg-primary/8 text-foreground"
                      : "hover:bg-muted/70 focus-visible:bg-muted/70",
                    disabled && !profile.isActive && "cursor-not-allowed opacity-50",
                  )}
                  disabled={disabled}
                  aria-current={profile.isActive ? "true" : undefined}
                  onClick={() => {
                    props.onSelectProfile(profile.instanceId);
                    setOpen(false);
                  }}
                >
                  <ProviderInstanceIcon
                    driverKind={profile.driver}
                    displayName={profile.displayName}
                    className="size-5"
                    iconClassName="size-5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {profile.accountLabel}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {profile.displayName}
                    </span>
                  </span>
                  {profile.isActive ? <CheckIcon className="size-4" aria-hidden="true" /> : null}
                </button>
              );
            })
          ) : (
            <p className="rounded-md bg-muted/50 px-2 py-2 text-xs text-muted-foreground">
              No authenticated profiles are reported for this provider.
            </p>
          )}
        </div>

        {props.disabledReason ? (
          <p className="text-xs text-warning" role="status">
            {props.disabledReason}
          </p>
        ) : null}

        {state.nativeLoginTargets.length > 0 ? (
          <div className="border-t border-border/60 pt-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Sign-in stays inside the provider&apos;s existing /login flow. Solla Code does not
              collect or store a provider password.
            </p>
            {state.nativeLoginTargets.map((target) => (
              <Button
                key={target.instanceId}
                type="button"
                size="sm"
                variant="outline"
                className="w-full justify-start"
                disabled={loginDisabledReason !== null}
                title={loginDisabledReason ?? `Sign in to ${target.displayName} with /login`}
                onClick={() => {
                  props.onPrepareNativeLogin(target.instanceId);
                  setOpen(false);
                }}
              >
                <LogInIcon className="size-4" aria-hidden="true" />
                Sign in to {target.displayName} with /login
              </Button>
            ))}
            {loginDisabledReason ? (
              <p className="mt-2 text-xs text-muted-foreground">{loginDisabledReason}</p>
            ) : null}
          </div>
        ) : (
          <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
            {state.supportsNativeLogin
              ? "Add another isolated provider profile in Settings before using /login here."
              : "This provider does not expose a safe in-app /login profile flow. Account creation is unavailable here."}
          </p>
        )}
      </PopoverPopup>
    </Popover>
  );
});

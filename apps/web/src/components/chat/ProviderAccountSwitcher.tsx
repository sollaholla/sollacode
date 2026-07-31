import type {
  ProviderAccountSwitchState,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { LogInIcon, UserRoundIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export interface ProviderAccountSwitcherProps {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeSwitch: ProviderAccountSwitchState | null;
  readonly onSwitchUser: (instanceId: ProviderInstanceId) => void;
}

function providerAccountLabel(provider: ServerProvider): string {
  return (
    provider.auth.email?.trim() ||
    provider.auth.label?.trim() ||
    provider.auth.type?.trim() ||
    (provider.auth.status === "unauthenticated" ? "Not signed in" : "Account unavailable")
  );
}

const activeSwitchStatuses = new Set<ProviderAccountSwitchState["status"]>([
  "logging_out",
  "starting_login",
  "waiting_for_authentication",
  "waiting_for_code",
  "refreshing_account",
]);

export const ProviderAccountSwitcher = memo(function ProviderAccountSwitcher(
  props: ProviderAccountSwitcherProps,
) {
  const [open, setOpen] = useState(false);
  const activeProvider = props.providers.find(
    (provider) => provider.instanceId === props.activeInstanceId,
  );
  if (!activeProvider) return null;

  const accountLabel = providerAccountLabel(activeProvider);
  const triggerLabel = `Provider account: ${accountLabel}`;
  const isSwitching =
    props.activeSwitch?.instanceId === props.activeInstanceId &&
    activeSwitchStatuses.has(props.activeSwitch.status);

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
        className="w-[min(21rem,calc(100vw-1rem))]"
        viewportClassName="p-3"
        aria-label="Provider account"
      >
        <div className="flex flex-col gap-3" data-provider-account-layout>
          <div className="flex items-center gap-3 rounded-lg bg-muted/45 px-3 py-3">
            <ProviderInstanceIcon
              driverKind={activeProvider.driver}
              displayName={activeProvider.displayName ?? String(activeProvider.instanceId)}
              accentColor={activeProvider.accentColor}
              className="size-8"
              iconClassName="size-7"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{accountLabel}</p>
              <p className="truncate text-xs text-muted-foreground">
                {activeProvider.displayName ?? String(activeProvider.driver)}
              </p>
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full justify-start"
            disabled={isSwitching}
            onClick={() => {
              props.onSwitchUser(activeProvider.instanceId);
              setOpen(false);
            }}
          >
            <LogInIcon className="size-4" aria-hidden="true" />
            {isSwitching ? "Switching user…" : "Switch user"}
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Solla Code signs out of this provider, starts its secure login flow, and keeps the
            current conversation running.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
});

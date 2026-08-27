import { LoaderIcon, RefreshCwIcon } from "lucide-react";
import type {
  ProviderDriverKind,
  ProviderUsageResetOutcome,
  ServerProvider,
} from "@t3tools/contracts";

import {
  ProviderUsageDetails,
  providerUsageExternalLink,
  type ProviderUsageResetCredit,
  type ProviderUsageSummary,
} from "../chat/ProviderUsageBar";
import { useProviderUsageStore } from "../../providerUsageStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isProviderUsageRefreshEligible } from "./providerUsageRefresh";

export type ProviderUsageRefreshState =
  | { readonly status: "idle"; readonly error: null }
  | { readonly status: "loading"; readonly error: null }
  | { readonly status: "error"; readonly error: string };

export const IDLE_PROVIDER_USAGE_REFRESH_STATE: ProviderUsageRefreshState = {
  status: "idle",
  error: null,
};

export function shouldShowProviderSettingsUsage(
  driverKind: ProviderDriverKind,
  summary: ProviderUsageSummary | undefined,
): boolean {
  const supportedDriver =
    driverKind === "codex" || driverKind === "claudeAgent" || driverKind === "grok";
  return supportedDriver && summary?.state !== "unsupported";
}

export function ProviderSettingsUsage(props: {
  readonly displayName: string;
  readonly driverKind: ProviderDriverKind;
  readonly provider: ServerProvider | undefined;
  readonly summary: ProviderUsageSummary | undefined;
  readonly refreshState: ProviderUsageRefreshState;
  readonly onRefresh: (() => void) | undefined;
  readonly onUseReset?: (
    creditId: string | undefined,
    idempotencyKey: string,
  ) => Promise<ProviderUsageResetOutcome>;
}) {
  const { displayName, driverKind, provider, summary, refreshState, onRefresh, onUseReset } = props;
  const dismissResetCredit = useProviderUsageStore((state) => state.dismissResetCredit);
  const canRefresh =
    provider !== undefined && isProviderUsageRefreshEligible(provider) && onRefresh !== undefined;
  const refreshing = refreshState.status === "loading";

  if (!shouldShowProviderSettingsUsage(driverKind, summary)) return null;

  if (!provider || !summary) {
    return (
      <section
        aria-label={`${displayName} account usage`}
        className="rounded-lg border border-border/60 bg-muted/20 p-3"
      >
        <h4 className="text-sm font-semibold text-foreground">{displayName} usage</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Waiting for provider status before account usage can be requested.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label={`${displayName} account usage`}
      className="relative rounded-lg border border-border/60 bg-muted/20 p-3"
    >
      <ProviderUsageDetails
        name={displayName}
        state={summary.state}
        windows={summary.windows}
        reportedAt={summary.reportedAt}
        resetCredits={summary.resetCredits ?? null}
        externalUsageLink={providerUsageExternalLink(driverKind)}
        {...(onUseReset ? { onUseReset } : {})}
        {...(summary.accountKey
          ? {
              onDismissResetCredit: (credit: ProviderUsageResetCredit) => {
                if (summary.accountKey) dismissResetCredit(summary.accountKey, credit);
              },
            }
          : {})}
      />
      <div className="absolute right-2.5 top-2.5 flex items-center gap-1.5">
        {refreshing ? (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <LoaderIcon className="size-3 animate-spin" aria-hidden />
            Refreshing
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-6 rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={`Refresh ${displayName} usage`}
                disabled={!canRefresh || refreshing}
                onClick={onRefresh}
              >
                {refreshing ? (
                  <LoaderIcon className="size-3 animate-spin" aria-hidden />
                ) : (
                  <RefreshCwIcon className="size-3" aria-hidden />
                )}
              </Button>
            }
          />
          <TooltipPopup side="top">
            {canRefresh
              ? summary.state === "stale"
                ? `Refresh stale ${displayName} usage`
                : `Refresh ${displayName} usage`
              : provider.auth.status === "unauthenticated"
                ? `Sign in to ${displayName} to refresh usage`
                : `${displayName} does not expose refreshable account usage`}
          </TooltipPopup>
        </Tooltip>
      </div>
      {refreshState.status === "error" ? (
        <div
          role="alert"
          className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
        >
          <span>{refreshState.error}</span>
          {canRefresh ? (
            <Button type="button" size="xs" variant="outline" onClick={onRefresh}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

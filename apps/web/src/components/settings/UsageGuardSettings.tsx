import { usageGuardPaceAllowance } from "@t3tools/shared/usageGuardCurve";
import { Button } from "../ui/button";
import {
  DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageGuardState,
  type UsageGuardProviderSettings,
  type UsageGuardProviderSettingsPatch,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatTokens } from "../../orchestrator/usageTracking";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

/** Drivers whose account usage the server can read. */
export const USAGE_GUARD_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex", "grok"]);

function tierBadge(
  state: ServerProviderUsageGuardState | undefined,
  disabled: boolean,
): {
  readonly label: string;
  readonly className: string;
} {
  if (disabled || !state || !state.enabled) {
    return { label: "Off", className: "text-muted-foreground" };
  }
  switch (state.tier) {
    case "pause":
      return { label: "Holding new work", className: "text-destructive" };
    case "extra-usage":
      return { label: "On extra usage", className: "text-warning" };
    case "optimize":
      return { label: "Optimizing", className: "text-warning" };
    default:
      return { label: "Under budget", className: "text-ok" };
  }
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim().replaceAll(",", "").replaceAll("_", "");
  if (trimmed.length === 0) return null;
  const multiplier = /m$/i.test(trimmed) ? 1_000_000 : /k$/i.test(trimmed) ? 1_000 : 1;
  const parsed = Number(trimmed.replace(/[km]$/i, ""));
  return Number.isFinite(parsed) ? parsed * multiplier : null;
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function AdvancedRow({
  label,
  hint,
  control,
}: {
  readonly label: string;
  readonly hint: string;
  readonly control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-foreground text-xs font-medium">{label}</div>
        <div className="text-muted-foreground text-[11px] leading-4">{hint}</div>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/**
 * The usage guard's controls for one provider, shown inside that provider's
 * card next to its usage windows. One switch and one sentence is all most
 * people need: the guard works out when to slow down and when to hold from
 * the window's pace, its reset, and what a turn on the chosen model costs.
 * The few knobs that exist sit behind "Advanced".
 */
export function ProviderUsageGuardControls({
  provider,
  displayName,
}: {
  readonly provider: ServerProvider;
  readonly displayName: string;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  if (!USAGE_GUARD_DRIVERS.has(String(provider.driver))) return null;

  const guard = settings.usageGuard;
  const config: UsageGuardProviderSettings = {
    ...DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS,
    ...guard.providers[provider.instanceId],
  };
  const patch = (next: UsageGuardProviderSettingsPatch) =>
    updateSettings({ usageGuard: { providers: { [provider.instanceId]: next } } });
  const state = provider.usageGuard;
  const disabled = !guard.enabled;
  const badge = tierBadge(state, disabled);
  const controlsDisabled = disabled || !config.enabled;
  const ratioPlaceholder = state ? `default (${formatTokens(state.tokensPerPercent)})` : "default";
  const summary = disabled
    ? "Turned off for every provider in Provider preferences."
    : !config.enabled
      ? `Off for ${displayName}.`
      : (state?.summary ??
        "No usage report yet. The guard starts once the provider reports its quota.");

  return (
    <div
      className="mt-3 rounded-lg border border-[var(--line)] bg-surface-row px-3 py-2.5"
      data-testid={`usage-guard-${provider.instanceId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            Usage guard
            <span
              className={cn("text-[11px] font-normal", badge.className)}
              data-testid={`usage-guard-tier-${provider.instanceId}`}
            >
              {badge.label}
            </span>
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs leading-4">{summary}</p>
        </div>
        <Switch
          checked={config.enabled}
          disabled={disabled}
          onCheckedChange={(checked) => patch({ enabled: Boolean(checked) })}
          aria-label={`Guard ${displayName} usage`}
        />
      </div>
      <div className="mt-3 rounded-lg border border-border p-3">
        <div className="text-xs font-medium">Cooldown curve</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Allow a faster pace after reset, then tighten gradually as usage fills.
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {(
            [
              ["linear", "Linear"],
              ["bump", "Smooth bump"],
              ["late", "Late ramp"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="xs"
              variant={config.cooldownCurve === value ? "secondary" : "outline"}
              disabled={controlsDisabled}
              aria-pressed={config.cooldownCurve === value}
              onClick={() => patch({ cooldownCurve: value, curveStrength: 1 })}
            >
              {label}
            </Button>
          ))}
        </div>
        <svg
          viewBox="0 0 300 85"
          className="mt-2 h-24 w-full"
          role="img"
          aria-label={`Pace allowance falls from ${config.earlyOvershootPercent}% at reset to zero at full usage`}
        >
          <path d="M 10 5 V 65 H 290" fill="none" stroke="currentColor" opacity="0.2" />
          <path
            d={Array.from(
              { length: 51 },
              (_, index) =>
                `${index === 0 ? "M" : "L"} ${10 + index * 5.6} ${65 - (usageGuardPaceAllowance(index * 2, config) / Math.max(1, config.earlyOvershootPercent)) * 55}`,
            ).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-primary"
          />
          <text x="10" y="81" fontSize="9" fill="currentColor">
            0% used
          </text>
          <text x="243" y="81" fontSize="9" fill="currentColor">
            100% used
          </text>
        </svg>
        <AdvancedRow
          label="Extra pace after reset"
          hint="10% permits a pace 10% above budget at zero usage. This allowance fades to zero."
          control={
            <DraftInput
              type="number"
              min={0}
              max={50}
              className="w-16"
              disabled={controlsDisabled}
              value={String(config.earlyOvershootPercent)}
              aria-label={`${displayName} early pace allowance percent`}
              onCommit={(value) => {
                const number = parseNumber(value);
                if (number !== null) patch({ earlyOvershootPercent: clampInt(number, 0, 50) });
              }}
            />
          }
        />
        <AdvancedRow
          label="Tightening strength"
          hint="Higher values remove the extra allowance sooner. Presets reset this to 1."
          control={
            <DraftInput
              type="number"
              min={0.25}
              max={4}
              step={0.25}
              className="w-16"
              disabled={controlsDisabled}
              value={String(config.curveStrength)}
              aria-label={`${displayName} curve strength`}
              onCommit={(value) => {
                const number = parseNumber(value);
                if (number !== null) patch({ curveStrength: Math.max(0.25, Math.min(4, number)) });
              }}
            />
          }
        />
      </div>
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger
          className="text-muted-foreground hover:text-foreground mt-1.5 inline-flex items-center gap-1 text-[11px]"
          aria-label={`${advancedOpen ? "Hide" : "Show"} advanced usage guard settings for ${displayName}`}
        >
          Advanced
          <ChevronDownIcon
            className={cn("size-3 transition-transform", advancedOpen && "rotate-180")}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="divide-y divide-[var(--line)] pt-1">
            <AdvancedRow
              label="Your own cap"
              hint="An extra ceiling of your choosing: at most this many tokens in any rolling window. Leave empty for none, which changes nothing else."
              control={
                <div className="flex items-center gap-1.5">
                  <DraftInput
                    type="number"
                    min={1000}
                    className="w-24"
                    disabled={controlsDisabled}
                    value={config.tokenCapTokens === null ? "" : String(config.tokenCapTokens)}
                    onCommit={(value) => {
                      const parsed = parseNumber(value);
                      patch({
                        tokenCapTokens:
                          value.trim() === "" || parsed === null || parsed <= 0
                            ? null
                            : Math.max(1000, Math.round(parsed)),
                      });
                    }}
                    aria-label={`${displayName} usage guard token cap`}
                  />
                  <span className="text-muted-foreground text-xs">tokens every</span>
                  <DraftInput
                    type="number"
                    min={0.25}
                    max={168}
                    className="w-16"
                    disabled={controlsDisabled || config.tokenCapTokens === null}
                    value={String(config.tokenCapHours)}
                    onCommit={(value) => {
                      const parsed = parseNumber(value);
                      if (parsed !== null) {
                        patch({ tokenCapHours: Math.max(0.25, Math.min(168, parsed)) });
                      }
                    }}
                    aria-label={`${displayName} usage guard token cap window hours`}
                  />
                  <span className="text-muted-foreground text-xs">h</span>
                </div>
              }
            />
            <AdvancedRow
              label="Headroom"
              hint="Points of every window kept free so a turn already running can finish."
              control={
                <div className="flex items-center gap-1.5">
                  <DraftInput
                    type="number"
                    min={1}
                    max={25}
                    className="w-16"
                    disabled={controlsDisabled}
                    value={String(config.headroomPercent)}
                    onCommit={(value) => {
                      const parsed = parseNumber(value);
                      if (parsed !== null) patch({ headroomPercent: clampInt(parsed, 1, 25) });
                    }}
                    aria-label={`${displayName} usage guard headroom percent`}
                  />
                  <span className="text-muted-foreground text-xs">%</span>
                </div>
              }
            />
            <AdvancedRow
              label="Lower effort when the pace overruns"
              hint="Reasoning effort drops by as much as the overrun needs. Never raises effort."
              control={
                <Switch
                  checked={config.reduceEffort}
                  disabled={controlsDisabled}
                  onCheckedChange={(checked) => patch({ reduceEffort: Boolean(checked) })}
                  aria-label={`${displayName} lower effort`}
                />
              }
            />
            <AdvancedRow
              label="Automatically pace work"
              hint="Threads share the account budget. Work waits and resumes automatically; long turns yield between tools when they spend their allowance."
              control={
                <Switch
                  checked={config.holdBackgroundWork}
                  disabled={controlsDisabled}
                  onCheckedChange={(checked) => patch({ holdBackgroundWork: Boolean(checked) })}
                  aria-label={`${displayName} meter background work`}
                />
              }
            />
            <AdvancedRow
              label="Hold when a turn no longer fits"
              hint="Reserve room for the next model call. Work resumes automatically when quota or credits are available."
              control={
                <Switch
                  checked={config.pauseWhenExhausted}
                  disabled={controlsDisabled}
                  onCheckedChange={(checked) => patch({ pauseWhenExhausted: Boolean(checked) })}
                  aria-label={`${displayName} hold when a turn no longer fits`}
                />
              }
            />
            <AdvancedRow
              label="Paid balance scale ($)"
              hint="Balance-based optimization: $0 is exhausted, this amount is full. No daily reset."
              control={
                <DraftInput
                  type="number"
                  min={0}
                  max={50}
                  className="w-20"
                  disabled={controlsDisabled}
                  value={String(config.creditBalanceScaleUsd)}
                  onCommit={(value) => {
                    const parsed = parseNumber(value);
                    if (parsed !== null)
                      patch({ creditBalanceScaleUsd: Math.min(50, Math.max(0, parsed)) });
                  }}
                  aria-label={`${displayName} paid balance scale dollars`}
                />
              }
            />
            <AdvancedRow
              label="Credits per US dollar"
              hint="Estimated conversion. Default: 25 credits per $1 ($40 per 1,000). Adjust to your purchase price."
              control={
                <DraftInput
                  type="number"
                  min={0.01}
                  max={10000}
                  className="w-20"
                  disabled={controlsDisabled}
                  value={String(config.creditsPerUsd)}
                  onCommit={(value) => {
                    const parsed = parseNumber(value);
                    if (parsed !== null)
                      patch({ creditsPerUsd: Math.min(10000, Math.max(0.01, parsed)) });
                  }}
                  aria-label={`${displayName} credits per dollar`}
                />
              }
            />
            <AdvancedRow
              label="Extra usage"
              hint="Once the included quota is spent, keep going on paid extra usage or hold instead."
              control={
                <Select
                  value={config.extraUsage}
                  disabled={controlsDisabled}
                  onValueChange={(value) => {
                    if (value === "allow" || value === "avoid") patch({ extraUsage: value });
                  }}
                >
                  <SelectTrigger className="w-28" aria-label={`${displayName} extra usage policy`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="allow">Allow</SelectItem>
                    <SelectItem value="avoid">Avoid</SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
            <AdvancedRow
              label="Tokens per 1%"
              hint="Weighted tokens that consume one point of the tightest window. Blank learns it from this account's own reports. Accepts k and M."
              control={
                <DraftInput
                  type="text"
                  inputMode="numeric"
                  className="w-36"
                  disabled={controlsDisabled}
                  placeholder={ratioPlaceholder}
                  value={config.tokensPerPercent === null ? "" : String(config.tokensPerPercent)}
                  onCommit={(value) => {
                    const parsed = parseNumber(value);
                    patch({
                      tokensPerPercent:
                        parsed === null ? null : clampInt(parsed, 1_000, 1_000_000_000),
                    });
                  }}
                  aria-label={`${displayName} tokens per percent`}
                />
              }
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/** The one global switch, for the Provider preferences section. */
export function UsageGuardMasterRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      title="Usage guard"
      description="Keeps every provider inside its usage windows from the pace it is filling at: lowers reasoning effort when the current pace would overrun a reset, meters background work to what the window can carry, and holds new work only once one more turn no longer fits. Each provider's card has its own switch and advanced options."
      control={
        <Switch
          checked={settings.usageGuard.enabled}
          onCheckedChange={(checked) =>
            updateSettings({ usageGuard: { enabled: Boolean(checked) } })
          }
          aria-label="Enable the usage guard"
        />
      }
    />
  );
}

export type { ProviderInstanceId };

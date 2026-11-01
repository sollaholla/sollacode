import { ArrowRightIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

const THEME_OPTIONS = [
  { value: "system", label: "Auto", Icon: MonitorIcon },
  { value: "solla-light", label: "Light", Icon: SunIcon },
  { value: "solla-dark", label: "Dark", Icon: MoonIcon },
] as const;

function PreferenceRow({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <li>
      <label htmlFor={id} className="flex min-h-14 cursor-pointer items-center gap-4 px-4 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          <span className="mt-0.5 block text-[13px] leading-5 text-muted-foreground">
            {description}
          </span>
        </span>
        <Switch id={id} checked={checked} onCheckedChange={(next) => onCheckedChange(next)} />
      </label>
    </li>
  );
}

/**
 * What someone wants in the app, on one screen. Each control writes the real
 * setting the moment it changes, so there is nothing to save and nothing lost by
 * skipping. Everything here also lives in Settings.
 */
export function StartupPreferences({
  onContinue,
  onSkip,
}: {
  readonly onContinue: () => void;
  readonly onSkip: () => void;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { choice, setChoice } = useTheme();
  const showUsageBar = useUiStateStore((state) => state.showProviderUsageBar);
  const setShowUsageBar = useUiStateStore((state) => state.setShowProviderUsageBar);
  // The browser asks first. A refusal leaves the switch off, as Settings does.
  const setAgentAlerts = async (enabled: boolean) => {
    if (!enabled) {
      updateSettings({ agentDesktopNotificationsEnabled: false });
      return;
    }
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    if (permission === "granted") updateSettings({ agentDesktopNotificationsEnabled: true });
  };

  return (
    <div
      className="mx-auto flex min-h-full w-full max-w-lg flex-1 flex-col px-5 pt-2 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:justify-center sm:pb-12"
      data-testid="startup-preferences"
    >
      {/* Up here as in the tour, never under the spot where the tour's Back sits:
          a double tap there must not end setup. */}
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Make it yours
        </h1>
        <Button variant="ghost" size="sm" onClick={onSkip}>
          Skip
        </Button>
      </div>
      <p className="mt-2 text-[15px] leading-6 text-muted-foreground">
        Choose what you want. You can change this anytime in Settings.
      </p>

      <div role="radiogroup" aria-label="Theme" className="mt-5 grid grid-cols-3 gap-2">
        {THEME_OPTIONS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={choice === value}
            onClick={() => setChoice(value)}
            className={cn(
              "flex h-14 flex-col items-center justify-center gap-0.5 rounded-xl border text-sm transition-colors",
              choice === value
                ? "border-gold-500 bg-gold-500/10 text-foreground"
                : "border-[var(--line)] text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </button>
        ))}
      </div>

      <ul className="mt-4 divide-y divide-[var(--line)] overflow-hidden rounded-xl border border-[var(--line)]">
        <PreferenceRow
          title="Agents"
          description="AI helpers for repeat jobs."
          checked={settings.agentStackEnabled}
          onCheckedChange={(checked) => updateSettings({ agentStackEnabled: checked })}
        />
        <PreferenceRow
          title="Voice assistant"
          description="Talk to the app. Finish setup in Settings."
          checked={settings.orchestrator.enabled}
          onCheckedChange={(checked) => updateSettings({ orchestrator: { enabled: checked } })}
        />
        <PreferenceRow
          title="Usage bar"
          description="See how much of your AI plan is left."
          checked={showUsageBar}
          onCheckedChange={setShowUsageBar}
        />
        {typeof Notification === "undefined" ? null : (
          <PreferenceRow
            title="Agent alerts"
            description="Get notified when an agent needs you."
            checked={settings.agentDesktopNotificationsEnabled}
            onCheckedChange={(checked) => void setAgentAlerts(checked)}
          />
        )}
        <PreferenceRow
          title="Sounds"
          description="Short tones for voice and calls."
          checked={settings.soundCues}
          onCheckedChange={(checked) => updateSettings({ soundCues: checked })}
        />
      </ul>

      <div className="mt-auto flex items-center gap-2 pt-5 sm:mt-6">
        <Button size="lg" className="ms-auto min-w-32 max-sm:flex-1" onClick={onContinue}>
          Continue
          <ArrowRightIcon aria-hidden className="size-4" />
        </Button>
      </div>
    </div>
  );
}

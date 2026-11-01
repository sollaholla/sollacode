import { ChevronRightIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { SettingsMobileSearch } from "./SettingsMobileSearch";
import { visibleSettingsNavGroups } from "./SettingsSidebarNav";

/**
 * Settings on a phone held upright: search, then every section by category.
 * Each row says what lives behind it, so nobody has to open a page to find out.
 */
export function SettingsPhoneHome(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <div
      data-testid="settings-phone-home"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-y-contain px-4 pt-3 pb-safe"
    >
      <SettingsMobileSearch />
      {visibleSettingsNavGroups().map((group) => (
        <section key={group.label} aria-label={group.label} className="flex flex-col gap-1.5">
          <h2 className="px-1 text-xs font-medium text-muted-foreground">{group.label}</h2>
          <div className="flex flex-col divide-y divide-[var(--line)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--card)]">
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.to}
                  type="button"
                  data-settings-phone-section={item.to}
                  onClick={() => void navigate({ to: item.to, replace: true })}
                  className="flex min-h-14 w-full items-center gap-3 px-3.5 py-2 text-left transition-colors active:bg-surface-hover"
                >
                  <Icon className="size-[18px] shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px] text-foreground">{item.label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/70" />
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <div className="h-4 shrink-0" />
    </div>
  );
}

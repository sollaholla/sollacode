import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { visibleSettingsNavItems, type SettingsSectionPath } from "./SettingsSidebarNav";

/**
 * Phone-held-upright only.
 *
 * Landscape keeps the sidebar: there is width for it there, and a tab strip
 * would eat the little vertical room that orientation is short of. The width
 * half matches `useIsMobile` (max-md), so a narrow desktop window does not
 * pick up a phone affordance.
 */
export const SETTINGS_MOBILE_TABS_QUERY = "(max-width: 767px) and (orientation: portrait)";

export function useSettingsMobileTabs(): boolean {
  return useMediaQuery(SETTINGS_MOBILE_TABS_QUERY);
}

/**
 * Settings sections as a horizontally scrollable strip.
 *
 * In portrait the sidebar is a drawer, so every section change cost a tap to
 * open it, a tap to choose, and a dismiss. These are route links rather than
 * ARIA tabs on purpose: `role="tab"` promises a tabpanel relationship and
 * arrow-key roving that navigation does not have, so it would describe the
 * widget wrongly to a screen reader.
 */
export function SettingsMobileTabs({ pathname }: { pathname: string }): React.JSX.Element {
  const navigate = useNavigate();
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Arriving deep (a search hit, a restored route) must not leave the current
  // section off-screen with no sign the strip scrolls.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);

  return (
    <nav
      aria-label="Settings sections"
      data-testid="settings-mobile-tabs"
      className={cn(
        "flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-[var(--line)]",
        "bg-[var(--card)] px-2 py-1.5",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      {visibleSettingsNavItems().map((item) => {
        const Icon = item.icon;
        const isActive = pathname === item.to;
        return (
          <button
            key={item.to}
            ref={isActive ? activeRef : undefined}
            type="button"
            aria-current={isActive ? "page" : undefined}
            data-settings-mobile-tab={item.to}
            onClick={() => {
              if (isActive) return;
              void navigate({ to: item.to as SettingsSectionPath, replace: true });
            }}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] px-2.5",
              "border text-xs font-medium whitespace-nowrap transition-colors",
              isActive
                ? "border-[var(--gold-line)] bg-surface-tile text-foreground"
                : "border-[var(--line)] bg-surface-row text-muted-foreground active:bg-surface-hover",
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

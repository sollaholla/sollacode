import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  FolderIcon,
  MessageSquareIcon,
  SearchIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { cn } from "../../lib/utils";
import { useSidebar } from "../ui/sidebar";
import {
  MOBILE_TABS,
  type MobileTab,
  resolveActiveMobileTab,
  resolveMobileTabSidebarAnchor,
} from "./mobileTabBarLogic";

const TAB_ICONS: Record<MobileTab, LucideIcon> = {
  projects: FolderIcon,
  agents: BotIcon,
  threads: MessageSquareIcon,
  search: SearchIcon,
  settings: SettingsIcon,
};

/**
 * Presentational bar: five equal tabs, the active one in gold. Kept free of
 * hooks so it renders in a markup test; {@link MobileTabBar} wires it up.
 */
export function MobileTabBarView({
  activeTab,
  onSelect,
  className,
}: {
  readonly activeTab: MobileTab | null;
  readonly onSelect: (tab: MobileTab) => void;
  readonly className?: string | undefined;
}) {
  return (
    <nav
      aria-label="Primary"
      data-mobile-tab-bar=""
      className={cn(
        "flex shrink-0 items-stretch border-t border-[var(--line)] bg-[var(--surface-page)] pb-[env(safe-area-inset-bottom)]",
        className,
      )}
    >
      {MOBILE_TABS.map((tab) => {
        const Icon = TAB_ICONS[tab.id];
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={active ? "page" : undefined}
            data-mobile-tab={tab.id}
            onClick={() => onSelect(tab.id)}
            className={cn(
              "flex h-14 flex-1 cursor-pointer flex-col items-center justify-center gap-1 text-[11px] font-medium leading-none outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              active
                ? "text-gold-600 dark:text-gold-400"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-5" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Scrolls the sheet to a section once it is open. The sheet mounts on open, so
 * the anchor is looked up on the next frames rather than synchronously.
 */
function revealSidebarAnchor(testId: string): void {
  let attempts = 0;
  const tick = () => {
    const anchor = document.querySelector<HTMLElement>(
      `[data-mobile="true"] [data-testid="${testId}"]`,
    );
    if (anchor) {
      anchor.scrollIntoView({ block: "start" });
      return;
    }
    attempts += 1;
    if (attempts < 12) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export const MobileTabBar = memo(function MobileTabBar() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { setOpenMobile } = useSidebar();
  const activeTab = resolveActiveMobileTab(pathname);

  const handleSelect = useCallback(
    (tab: MobileTab) => {
      switch (tab) {
        case "search":
          openCommandPalette();
          return;
        case "settings":
          void navigate({ to: "/settings" });
          return;
        default: {
          setOpenMobile(true);
          const anchor = resolveMobileTabSidebarAnchor(tab);
          if (anchor) revealSidebarAnchor(anchor);
        }
      }
    },
    [navigate, setOpenMobile],
  );

  return <MobileTabBarView activeTab={activeTab} onSelect={handleSelect} className="md:hidden" />;
});

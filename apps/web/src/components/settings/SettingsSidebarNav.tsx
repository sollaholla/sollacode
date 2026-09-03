import { useCallback, useMemo, useState, type ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  SearchIcon,
  XIcon,
  AudioLinesIcon,
  BotIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
  MonitorSmartphoneIcon,
  PaletteIcon,
  ShieldCheckIcon,
  Settings2Icon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { searchSettings, type SettingsSearchResult } from "./settingsSearchIndex";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/permissions"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/orchestrator"
  | "/settings/agents"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/beta"
  | "/settings/archived";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Appearance", to: "/settings/appearance", icon: PaletteIcon },
  { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
  { label: "Providers", to: "/settings/providers", icon: BotIcon },
  { label: "Orchestrator", to: "/settings/orchestrator", icon: AudioLinesIcon },
  { label: "Agents", to: "/settings/agents", icon: MonitorSmartphoneIcon },
  { label: "Source Control", to: "/settings/source-control", icon: GitBranchIcon },
  { label: "Connections", to: "/settings/connections", icon: Link2Icon },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
];

function visibleSettingsNavItems(): ReadonlyArray<(typeof SETTINGS_NAV_ITEMS)[number]> {
  if (window.desktopBridge?.permissions === undefined) return SETTINGS_NAV_ITEMS;
  return [
    SETTINGS_NAV_ITEMS[0]!,
    { label: "Permissions", to: "/settings/permissions", icon: ShieldCheckIcon },
    ...SETTINGS_NAV_ITEMS.slice(1),
  ];
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const [query, setQuery] = useState("");
  const results = useMemo(
    () =>
      searchSettings(query, undefined, {
        includeDesktopOnly: window.desktopBridge?.permissions !== undefined,
      }),
    [query],
  );
  const handleResultClick = useCallback(
    (result: SettingsSearchResult) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      // The layout scrolls to and flashes the row named by the hash.
      void navigate({ to: result.tab, hash: result.anchorId, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="p-2 pb-0">
          <label className="flex h-8 items-center gap-2 rounded-md border border-[var(--line)] bg-surface-row px-2 text-[13px] text-foreground focus-within:border-[var(--gold-line)]">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query.length > 0) {
                  // Clear the query instead of letting the page's Escape leave settings.
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              data-testid="settings-search-input"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
            />
            {query.length > 0 ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </label>
        </SidebarGroup>
        {query.trim().length > 0 ? (
          <SidebarGroup className="p-2" data-testid="settings-search-results">
            {results.length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-muted-foreground">
                No settings match “{query.trim()}”.
              </p>
            ) : (
              <SidebarMenu>
                {results.map((result) => (
                  <SidebarMenuItem key={`${result.tab}#${result.anchorId}`}>
                    <SidebarMenuButton
                      className="h-auto flex-col items-start gap-0 py-1.5"
                      onClick={() => handleResultClick(result)}
                    >
                      <span className="truncate text-[13px] text-foreground">{result.title}</span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {result.tabLabel} · {result.section}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroup>
        ) : null}
        <SidebarGroup className={query.trim().length > 0 ? "hidden" : "p-2"}>
          <SidebarMenu>
            {visibleSettingsNavItems().map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.to;
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => handleSectionClick(item.to)}
                  >
                    <Icon />
                    <span className="truncate">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-2">
        <div className="flex items-center gap-1">
          <SidebarMenu className="min-w-0 flex-1">
            <SidebarMenuItem>
              <SidebarMenuButton onClick={handleBackClick}>
                <ArrowLeftIcon />
                <span>Back</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarFooter>
    </>
  );
}

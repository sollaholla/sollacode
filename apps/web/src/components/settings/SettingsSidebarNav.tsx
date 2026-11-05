import { useCallback, useMemo, useState, type ComponentType } from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  HardDriveIcon,
  Volume2Icon,
  SearchIcon,
  XIcon,
  AudioLinesIcon,
  BotIcon,
  FoldersIcon,
  GitBranchIcon,
  KeyboardIcon,
  KeyRoundIcon,
  Link2Icon,
  MonitorSmartphoneIcon,
  PaletteIcon,
  ShieldCheckIcon,
  Settings2Icon,
  SmartphoneIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { useCloseSettings } from "./closeSettings";
import { searchSettings, type SettingsSearchResult } from "./settingsSearchIndex";
import { useSettingsSearchNavigation } from "./useSettingsSearchNavigation";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/permissions"
  | "/settings/projects"
  | "/settings/credentials"
  | "/settings/devices"
  | "/settings/appearance"
  | "/settings/sound"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/orchestrator"
  | "/settings/agents"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/storage"
  | "/settings/diagnostics"
  | "/settings/beta"
  | "/settings/archived";

export interface SettingsNavItem {
  readonly label: string;
  readonly to: SettingsSectionPath;
  readonly icon: ComponentType<{ className?: string }>;
  /** What lives here, in the words someone would look for it by. */
  readonly description: string;
}

export interface SettingsNavGroup {
  readonly label: string;
  readonly items: ReadonlyArray<SettingsNavItem>;
}

const PERMISSIONS_NAV_ITEM: SettingsNavItem = {
  label: "Permissions",
  to: "/settings/permissions",
  icon: ShieldCheckIcon,
  description: "Microphone, screen and system access",
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<SettingsNavGroup> = [
  {
    label: "App",
    items: [
      {
        label: "General",
        to: "/settings/general",
        icon: Settings2Icon,
        description: "New threads, confirmations, updates",
      },
      {
        label: "Appearance",
        to: "/settings/appearance",
        icon: PaletteIcon,
        description: "Theme, text and the thread list",
      },
      {
        label: "Sound & voice",
        to: "/settings/sound",
        icon: Volume2Icon,
        description: "Sound cues, calls and dictation",
      },
      {
        label: "Keybindings",
        to: "/settings/keybindings",
        icon: KeyboardIcon,
        description: "Keyboard shortcuts",
      },
    ],
  },
  {
    label: "AI",
    items: [
      {
        label: "Providers",
        to: "/settings/providers",
        icon: BotIcon,
        description: "Accounts, models and usage",
      },
      {
        label: "Agents",
        to: "/settings/agents",
        icon: MonitorSmartphoneIcon,
        description: "Your always-on agents",
      },
      {
        label: "Orchestrator",
        to: "/settings/orchestrator",
        icon: AudioLinesIcon,
        description: "Voice mode and what it can do",
      },
    ],
  },
  {
    label: "Workspace",
    items: [
      {
        label: "Projects",
        to: "/settings/projects",
        icon: FoldersIcon,
        description: "Folders, scripts and statistics",
      },
      {
        label: "Source Control",
        to: "/settings/source-control",
        icon: GitBranchIcon,
        description: "Git, commits and pull requests",
      },
      {
        label: "Simulators",
        to: "/settings/devices",
        icon: SmartphoneIcon,
        description: "iOS simulators and Android emulators",
      },
      {
        label: "Archive",
        to: "/settings/archived",
        icon: ArchiveIcon,
        description: "Archived chats",
      },
    ],
  },
  {
    label: "Access",
    items: [
      {
        label: "Connections",
        to: "/settings/connections",
        icon: Link2Icon,
        description: "Other computers and remote access",
      },
      {
        label: "Accounts",
        to: "/settings/credentials",
        icon: KeyRoundIcon,
        description: "Sign-ins and saved logins",
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        label: "Storage",
        to: "/settings/storage",
        icon: HardDriveIcon,
        description: "Background work and cleanup",
      },
      {
        label: "Diagnostics",
        to: "/settings/diagnostics",
        icon: ActivityIcon,
        description: "Resource use and traces",
      },
    ],
  },
];

export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = SETTINGS_NAV_GROUPS.flatMap(
  (group) => group.items,
);

/**
 * The sections this build actually has, by category.
 *
 * Permissions only exists when the desktop bridge does, so it is added here
 * rather than living in the constant. Read during render by the sidebar and the
 * phone home screen, so it also has to survive a server or static render.
 */
export function visibleSettingsNavGroups(): ReadonlyArray<SettingsNavGroup> {
  if (typeof window === "undefined" || window.desktopBridge?.permissions === undefined) {
    return SETTINGS_NAV_GROUPS;
  }
  return SETTINGS_NAV_GROUPS.map((group) =>
    group.label === "Access" ? { ...group, items: [...group.items, PERMISSIONS_NAV_ITEM] } : group,
  );
}

/** A section stays selected on the pages beneath it, such as one project's details. */
export function isSettingsSectionActive(pathname: string, to: SettingsSectionPath): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
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
      setQuery("");
      if (isMobile) {
        setOpenMobile(false);
      }
      // The layout scrolls to and flashes the row named by the hash.
      void navigate({ to: result.tab, hash: result.anchorId, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const searchNavigation = useSettingsSearchNavigation({
    query,
    results,
    onClear: () => setQuery(""),
    onSelect: handleResultClick,
  });
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const closeSettings = useCloseSettings();
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    closeSettings();
  }, [closeSettings, isMobile, setOpenMobile]);

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
              {...searchNavigation.inputProps}
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
          <SidebarGroup
            className="p-2"
            data-testid="settings-search-results"
            id={searchNavigation.listId}
            role="listbox"
            aria-label="Settings search results"
          >
            {results.length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-muted-foreground">
                No settings match “{query.trim()}”.
              </p>
            ) : (
              <SidebarMenu role="presentation">
                {results.map((result, index) => (
                  <SidebarMenuItem key={`${result.tab}#${result.anchorId}`} role="presentation">
                    <SidebarMenuButton
                      id={searchNavigation.optionId(index)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === searchNavigation.activeIndex}
                      isActive={index === searchNavigation.activeIndex}
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
        {visibleSettingsNavGroups().map((group) => (
          <SidebarGroup
            key={group.label}
            className={query.trim().length > 0 ? "hidden" : "px-2 py-1.5"}
          >
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      isActive={isSettingsSectionActive(pathname, item.to)}
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
        ))}
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

import { useMemo, useState } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { searchSettings, type SettingsSearchResult } from "./settingsSearchIndex";
import { useSettingsSearchNavigation } from "./useSettingsSearchNavigation";

/**
 * Settings search for the portrait phone layout.
 *
 * It used to live in the navigation drawer, which on this layout no longer has
 * a way in: sections moved to the tab strip and the drawer trigger became Back.
 * Without this the feature would still exist and simply be unreachable, so it
 * moves to the one header that is always on screen.
 */
export function SettingsMobileSearch(): React.JSX.Element {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const results = useMemo(
    () =>
      searchSettings(query, undefined, {
        includeDesktopOnly:
          typeof window !== "undefined" && window.desktopBridge?.permissions !== undefined,
      }),
    [query],
  );
  const selectResult = (result: SettingsSearchResult) => {
    setQuery("");
    void navigate({ to: result.tab, hash: result.anchorId, replace: true });
  };
  const searchNavigation = useSettingsSearchNavigation({
    query,
    results,
    onClear: () => setQuery(""),
    onSelect: selectResult,
  });

  return (
    <div className="relative min-w-0 flex-1">
      <label className="flex h-8 items-center gap-2 rounded-md border border-[var(--line)] bg-surface-row px-2 text-[13px] text-foreground focus-within:border-[var(--gold-line)]">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          {...searchNavigation.inputProps}
          placeholder="Search settings"
          aria-label="Search settings"
          data-testid="settings-mobile-search-input"
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
      {trimmed.length > 0 ? (
        // Overlaid rather than in flow: results must not push the tab strip and
        // the panel down the screen while someone is typing.
        <div
          id={searchNavigation.listId}
          role="listbox"
          aria-label="Settings search results"
          data-testid="settings-mobile-search-results"
          className={cn(
            "absolute inset-x-0 top-full z-50 mt-1 max-h-[60vh] overflow-y-auto",
            "rounded-md border border-[var(--line)] bg-[var(--card)] p-1 shadow-lg",
          )}
        >
          {results.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-muted-foreground">
              No settings match “{trimmed}”.
            </p>
          ) : (
            results.map((result: SettingsSearchResult, index) => (
              <button
                key={`${result.tab}#${result.anchorId}`}
                id={searchNavigation.optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={index === searchNavigation.activeIndex}
                type="button"
                onClick={() => selectResult(result)}
                className={cn(
                  "flex w-full flex-col items-start gap-0 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover active:bg-surface-hover",
                  index === searchNavigation.activeIndex && "bg-surface-hover",
                )}
              >
                <span className="truncate text-[13px] text-foreground">{result.title}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {result.tabLabel} · {result.section}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

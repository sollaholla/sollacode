import { useEffect, useId, useState, type KeyboardEvent } from "react";

import type { SettingsSearchResult } from "./settingsSearchIndex";

/** Keyboard selection stays on the search input while the selected row scrolls into view. */
export function useSettingsSearchNavigation({
  query,
  results,
  onClear,
  onSelect,
}: {
  query: string;
  results: readonly SettingsSearchResult[];
  onClear: () => void;
  onSelect: (result: SettingsSearchResult) => void;
}) {
  const listId = useId();
  const [selection, setSelection] = useState({ query, index: -1 });
  const activeIndex =
    selection.query === query ? Math.min(selection.index, results.length - 1) : -1;
  const optionId = (index: number) => `${listId}-result-${index}`;
  const activeId = activeIndex >= 0 ? optionId(activeIndex) : undefined;
  const expanded = query.trim().length > 0;

  useEffect(() => {
    if (activeId) {
      document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && query.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      onClear();
      return;
    }
    if (!expanded || results.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index =
        event.key === "ArrowDown"
          ? (activeIndex + 1) % results.length
          : activeIndex <= 0
            ? results.length - 1
            : activeIndex - 1;
      setSelection({ query, index });
    } else if (event.key === "Enter") {
      const result = results[Math.max(0, activeIndex)];
      if (result) {
        event.preventDefault();
        onSelect(result);
      }
    }
  };

  return {
    activeIndex,
    listId,
    optionId,
    inputProps: {
      role: "combobox" as const,
      "aria-autocomplete": "list" as const,
      "aria-expanded": expanded,
      "aria-controls": expanded ? listId : undefined,
      "aria-activedescendant": activeId,
      onKeyDown,
    },
  };
}

/** Follow a search result through lazy panel loading without polling every frame. */
export function highlightSettingsSearchResult(root: HTMLElement, targetRowId: string): () => void {
  let observer: MutationObserver | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let highlightedRow: HTMLElement | undefined;
  const stopWaiting = () => {
    observer?.disconnect();
    clearTimeout(timeout);
  };
  const highlight = () => {
    const row = root.ownerDocument.getElementById(targetRowId);
    if (!row || !root.contains(row)) return false;
    stopWaiting();
    highlightedRow = row;
    row.scrollIntoView({ block: "center" });
    row.setAttribute("data-settings-highlight", "");
    timeout = setTimeout(() => row.removeAttribute("data-settings-highlight"), 2400);
    return true;
  };
  if (!highlight()) {
    observer = new MutationObserver(highlight);
    observer.observe(root, { childList: true, subtree: true });
    // A missing/obsolete result must not keep observing the settings tree.
    timeout = setTimeout(stopWaiting, 30_000);
  }
  return () => {
    stopWaiting();
    highlightedRow?.removeAttribute("data-settings-highlight");
  };
}

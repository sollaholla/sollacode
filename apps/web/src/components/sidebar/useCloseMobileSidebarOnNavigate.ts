import { useEffect, useRef } from "react";

import { useSidebar } from "~/components/ui/sidebar";

/**
 * Closes the mobile sidebar whenever navigation lands somewhere new.
 *
 * On a phone the sidebar is a sheet covering the app, so anything that opens a
 * surface behind it has to dismiss it or the user picks a thing and appears to
 * get nothing. That used to be each entry's own job — roughly ten call sites
 * hand-rolling `setOpenMobile(false)` — which works right up until someone
 * adds an entry and does not know the convention exists. Agent entries were
 * exactly that: they navigated, and the sheet stayed up over the workspace
 * they had just opened.
 *
 * Making it a consequence of navigating rather than a thing each button
 * remembers means new entries inherit it. An entry that genuinely should leave
 * the sidebar up simply must not navigate — in-place affordances like renaming
 * or expanding a section do not change the location and so are unaffected.
 *
 * Keyed on the full href, not the pathname: moving between two agents, or
 * opening an artifact via a search param, is still arriving somewhere new.
 */
export function useCloseMobileSidebarOnNavigate(href: string): void {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  // Seeded on mount so that a first render — which has "changed" from nothing
  // — does not close a sheet the user just deliberately opened.
  const previousHrefRef = useRef(href);

  useEffect(() => {
    const previous = previousHrefRef.current;
    previousHrefRef.current = href;
    if (previous === href) return;
    if (!isMobile || !openMobile) return;
    setOpenMobile(false);
  }, [href, isMobile, openMobile, setOpenMobile]);
}

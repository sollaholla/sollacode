import { useEffect, useRef } from "react";

import { shouldAutoCollapseOnEmptyPanel } from "./SidebarAutoCollapseOnEmptyPanel.logic";
import { useSidebar } from "./ui/sidebar";

/**
 * Session-scoped, deliberately outside React: the mount is keyed by thread so
 * that switching threads cannot look like a close, and a per-mount latch would
 * then fire once for every thread visited rather than once, ever.
 */
let autoCollapsedOnceThisSession = false;

/**
 * Folds the sidebar away the first time the right panel runs out of tabs.
 *
 * Closing the last tab is the moment the window goes back to being just a
 * conversation, and the thread list beside it is the next thing in the way.
 * See {@link shouldAutoCollapseOnEmptyPanel} for why this happens exactly once.
 */
export function SidebarAutoCollapseOnEmptyPanel(props: { readonly surfaceCount: number }) {
  const { isMobile, open, openMobile, setOpen, setOpenMobile } = useSidebar();
  const previousSurfaceCountRef = useRef<number | null>(null);
  // Read through refs so reopening the sidebar cannot re-run the effect and
  // immediately take it away again.
  const visibleRef = useRef(false);
  visibleRef.current = isMobile ? openMobile : open;
  const setVisibleRef = useRef<(next: boolean) => void>(() => undefined);
  setVisibleRef.current = isMobile ? setOpenMobile : setOpen;

  useEffect(() => {
    const previousSurfaceCount = previousSurfaceCountRef.current;
    previousSurfaceCountRef.current = props.surfaceCount;
    if (
      !shouldAutoCollapseOnEmptyPanel({
        previousSurfaceCount,
        surfaceCount: props.surfaceCount,
        alreadyCollapsedOnce: autoCollapsedOnceThisSession,
        sidebarVisible: visibleRef.current,
      })
    ) {
      return;
    }
    autoCollapsedOnceThisSession = true;
    setVisibleRef.current(false);
  }, [props.surfaceCount]);

  return null;
}

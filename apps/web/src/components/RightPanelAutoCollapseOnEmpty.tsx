import { useEffect, useRef } from "react";

import { shouldAutoCollapseRightPanelOnEmpty } from "./RightPanelAutoCollapseOnEmpty.logic";

/**
 * Session-scoped, deliberately outside React: the mount is keyed by thread so
 * that switching threads cannot look like a close, and a per-mount latch would
 * then fire once for every thread visited rather than once, ever.
 */
let autoCollapsedOnceThisSession = false;

/**
 * Folds the right panel away the first time it runs out of tabs.
 *
 * Closing the last tab is the moment the window goes back to being just a
 * conversation; leaving an empty surface column beside it serves no purpose.
 * See {@link shouldAutoCollapseRightPanelOnEmpty} for why this happens exactly once.
 */
export function RightPanelAutoCollapseOnEmpty(props: {
  readonly surfaceCount: number;
  readonly panelOpen: boolean;
  readonly onCollapse: () => void;
}) {
  const previousSurfaceCountRef = useRef<number | null>(null);
  // Read through a ref so replacing the callback cannot turn a render into a
  // second empty-panel transition.
  const onCollapseRef = useRef(props.onCollapse);
  onCollapseRef.current = props.onCollapse;

  useEffect(() => {
    const previousSurfaceCount = previousSurfaceCountRef.current;
    previousSurfaceCountRef.current = props.surfaceCount;
    if (
      !shouldAutoCollapseRightPanelOnEmpty({
        previousSurfaceCount,
        surfaceCount: props.surfaceCount,
        alreadyCollapsedOnce: autoCollapsedOnceThisSession,
        panelOpen: props.panelOpen,
      })
    ) {
      return;
    }
    autoCollapsedOnceThisSession = true;
    onCollapseRef.current();
  }, [props.panelOpen, props.surfaceCount]);

  return null;
}

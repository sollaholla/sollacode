import { type ReactNode, useEffect } from "react";

import { cn } from "../../lib/utils";
import { useFirstRunActiveStore } from "./welcomeTourStore";

/**
 * First-run takes the whole window: one thing to look at and no way to wander off
 * into an empty app. Dialogs such as provider sign-in (z-50) still open above it.
 */
export function FirstRunSurface({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const setActive = useFirstRunActiveStore((state) => state.setActive);
  useEffect(() => {
    setActive(true);
    return () => setActive(false);
  }, [setActive]);
  return (
    <div
      className={cn(
        "fixed inset-0 z-45 flex flex-col overflow-y-auto overscroll-contain bg-background",
        className,
      )}
      data-testid="first-run-surface"
    >
      <div className="drag-region flex h-13 shrink-0 items-center justify-center gap-2 pt-[env(safe-area-inset-top)] box-content">
        <img alt="" aria-hidden className="size-5 object-contain" src="/solla-code-mark.png" />
        <span className="text-sm font-medium text-foreground">Solla Code</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

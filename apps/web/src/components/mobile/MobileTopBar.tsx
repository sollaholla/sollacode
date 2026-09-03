import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { APP_BASE_NAME } from "../../branding";
import { cn } from "../../lib/utils";
import { SidebarTrigger } from "../ui/sidebar";

/**
 * The phone shell's top bar: the sheet trigger, the gold mark and the wordmark.
 * On a phone the sidebar is a sheet, so this row is the only place the brand
 * and the way into navigation are always on screen. Hidden from `md` up, where
 * the docked sidebar carries both.
 */
export const MobileTopBar = memo(function MobileTopBar({
  className,
}: {
  readonly className?: string | undefined;
}) {
  return (
    <div
      data-mobile-top-bar=""
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b md:hidden border-[var(--line)] bg-[var(--surface-page)] pl-[calc(env(safe-area-inset-left)+0.5rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-[env(safe-area-inset-top)]",
        className,
      )}
    >
      <SidebarTrigger aria-label="Open navigation" />
      <Link
        aria-label={`${APP_BASE_NAME} home`}
        className="inline-flex h-8 min-w-0 items-center gap-2 rounded-md pr-1 outline-hidden ring-ring focus-visible:ring-2"
        to="/"
      >
        <img
          alt=""
          aria-hidden
          className="size-6 shrink-0 object-contain"
          src="/solla-code-mark.png"
        />
        <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
          {APP_BASE_NAME}
        </span>
      </Link>
    </div>
  );
});

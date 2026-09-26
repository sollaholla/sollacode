import { Link, useLocation } from "@tanstack/react-router";
import { memo } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { APP_BASE_NAME } from "../../branding";
import { cn } from "../../lib/utils";
import { useNavigateBackWithinApp } from "../navigateBackWithinApp";
import { useSettingsMobileTabs } from "../settings/SettingsMobileTabs";
import { SidebarTrigger } from "../ui/sidebar";
import { useMobileTopBarTrailingSlot } from "./mobileTopBarSlot";

/**
 * The phone shell's top bar keeps the brand and navigation sheet trigger on
 * screen. Settings is available in the sheet's footer. Hidden from `md` up,
 * where the docked sidebar carries navigation and branding.
 */
export const MobileTopBar = memo(function MobileTopBar({
  className,
}: {
  readonly className?: string | undefined;
}) {
  const location = useLocation();
  const goBack = useNavigateBackWithinApp();
  // Settings on a portrait phone navigates by the tab strip, so the drawer has
  // nothing left to offer there and its trigger becomes the one control the
  // screen actually needs. Landscape still lists sections in the drawer, so the
  // trigger has to stay there — this is the same gate the strip uses.
  const showBack = useSettingsMobileTabs() && location.pathname.startsWith("/settings");
  const setTrailingSlot = useMobileTopBarTrailingSlot((state) => state.setElement);

  return (
    <div
      data-mobile-top-bar=""
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b md:hidden border-[var(--line)] bg-[var(--surface-page)] pl-[calc(env(safe-area-inset-left)+0.5rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-[env(safe-area-inset-top)]",
        className,
      )}
    >
      {showBack ? (
        <button
          aria-label="Back"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-foreground outline-hidden ring-ring transition-colors hover:bg-surface-hover focus-visible:ring-2 active:bg-surface-hover"
          onClick={goBack}
          type="button"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
      ) : (
        <SidebarTrigger aria-label="Open navigation" />
      )}
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
      {/* Screens park their folded-away controls here (see mobileTopBarSlot). */}
      <div
        ref={setTrailingSlot}
        data-mobile-top-bar-trailing=""
        className="ml-auto flex shrink-0 items-center gap-2"
      />
    </div>
  );
});

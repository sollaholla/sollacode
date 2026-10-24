import { Link, useLocation } from "@tanstack/react-router";
import { memo } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { APP_BASE_NAME } from "../../branding";
import { cn } from "../../lib/utils";
import { useCloseSettings } from "../settings/closeSettings";
import { useSettingsMobileTabs } from "../settings/SettingsMobileTabs";
import { SidebarTrigger } from "../ui/sidebar";
import { HostVitalsChip } from "../chat/HostVitalsChip";
import { useMobileTopBarTrailingSlot } from "./mobileTopBarSlot";
import { useTopBarEnvironmentId } from "./topBarEnvironment";

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
  const closeSettings = useCloseSettings();
  // Settings on a portrait phone navigates by the tab strip, so the drawer has
  // nothing left to offer there and its trigger becomes the one control the
  // screen actually needs. Landscape still lists sections in the drawer, so the
  // trigger has to stay there — this is the same gate the strip uses.
  const showBack = useSettingsMobileTabs() && location.pathname.startsWith("/settings");
  const setTrailingSlot = useMobileTopBarTrailingSlot((state) => state.setElement);
  const environmentId = useTopBarEnvironmentId();

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
          aria-label="Close settings"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-foreground outline-hidden ring-ring transition-colors hover:bg-surface-hover focus-visible:ring-2 active:bg-surface-hover"
          onClick={closeSettings}
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
      {/* The far right: the remote machine's battery and disk, then whatever a
          screen parks here (see mobileTopBarSlot) -- an agent's avatar lands
          to the right of the chip, never under it. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {environmentId ? <HostVitalsChip environmentId={environmentId} /> : null}
        {/* Never `hidden`: the agent fold gesture measures this element to
            steer the avatar, and display:none measures as a 0x0 rect in the
            top-left corner, which made the drag impossible to complete. While
            empty it is a zero-width box; the negative margin cancels the group
            gap so the chip stays flush right. */}
        <div
          ref={setTrailingSlot}
          data-mobile-top-bar-trailing=""
          className={cn("flex shrink-0 items-center gap-2", environmentId && "empty:-ml-2")}
        />
      </div>
    </div>
  );
});

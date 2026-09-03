import { RotateCcwIcon } from "lucide-react";
import { Outlet, useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { useSettingsRestore } from "./SettingsPanels";

// Preview webviews live outside the router so they survive navigation and are
// presented at z-index 30. Keep settings in a higher stacking context so a
// still-releasing agent preview cannot paint over the newly selected route.
export const SETTINGS_ROUTE_SURFACE_Z_INDEX = 40;

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);

  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      Restore defaults
    </Button>
  );
}

export function SettingsRouteLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const showRestoreDefaults = location.pathname === "/settings/general";
  const handleRestored = () => setRestoreSignal((value) => value + 1);
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  // A search result navigates with the row id as the hash: once the lazy
  // panel has rendered that row, bring it into view and flash it gold.
  const targetRowId = typeof location.hash === "string" ? location.hash.replace(/^#/, "") : "";
  useEffect(() => {
    if (targetRowId.length === 0) return;
    let cancelled = false;
    let attempts = 0;
    let clearHighlight: (() => void) | null = null;
    const tick = () => {
      if (cancelled) return;
      const row = document.getElementById(targetRowId);
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.setAttribute("data-settings-highlight", "");
        const timer = setTimeout(() => row.removeAttribute("data-settings-highlight"), 2400);
        clearHighlight = () => {
          clearTimeout(timer);
          row.removeAttribute("data-settings-highlight");
        };
        return;
      }
      attempts += 1;
      if (attempts < 60) {
        requestAnimationFrame(tick);
      }
    };
    tick();
    return () => {
      cancelled = true;
      clearHighlight?.();
    };
  }, [location.pathname, targetRowId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();

        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) {
          activeElement.blur();
        }

        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate"
      style={{ zIndex: SETTINGS_ROUTE_SURFACE_Z_INDEX }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <div className="flex w-full items-center gap-2">
              <span className="text-sm font-medium text-foreground">Settings</span>
              {showRestoreDefaults ? (
                <div className="ms-auto flex items-center gap-2">
                  <RestoreDefaultsButton onRestored={handleRestored} />
                </div>
              ) : null}
            </div>
          </header>
        )}

        {isElectron && (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
            {showRestoreDefaults ? (
              <div className="ms-auto flex items-center gap-2">
                <RestoreDefaultsButton onRestored={handleRestored} />
              </div>
            ) : null}
          </div>
        )}

        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}

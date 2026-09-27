import { Outlet, useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
  COLLAPSED_SIDEBAR_TITLEBAR_INSET_MD_CLASS,
} from "../../workspaceTitlebar";
import { SidebarInset } from "../ui/sidebar";
import { SettingsMobileTabs, useSettingsMobileTabs } from "./SettingsMobileTabs";
import { SettingsMobileSearch } from "./SettingsMobileSearch";
import { highlightSettingsSearchResult } from "./settingsSearchHighlight";

// Preview webviews live outside the router so they survive navigation and are
// presented at z-index 30. Keep settings in a higher stacking context so a
// still-releasing agent preview cannot paint over the newly selected route.
export const SETTINGS_ROUTE_SURFACE_Z_INDEX = 40;

const RestoreDefaultsButton = lazy(() =>
  import("./SettingsRestoreDefaultsButton").then((module) => ({
    default: module.SettingsRestoreDefaultsButton,
  })),
);

export function SettingsPanelPending() {
  return (
    <div role="status" className="p-5 text-sm text-muted-foreground">
      Loading settings…
    </div>
  );
}

export function SettingsRoutePending() {
  return <SettingsRouteLayout pending />;
}

export function SettingsRouteLayout({ pending = false }: { pending?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const showMobileTabs = useSettingsMobileTabs();
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
    if (targetRowId.length === 0 || !surfaceRef.current) return;
    return highlightSettingsSearchResult(surfaceRef.current, targetRowId);
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
      ref={surfaceRef}
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate"
      style={{ zIndex: SETTINGS_ROUTE_SURFACE_Z_INDEX }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              // Phones have no sidebar rail to clear, so the desktop inset only
              // applies from `md` up. Below it the title sits flush left with
              // the tabs and the panel beneath it.
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_MD_CLASS,
            )}
          >
            <div className="flex w-full items-center gap-2">
              <span className="shrink-0 text-sm font-medium text-foreground">Settings</span>
              {showMobileTabs ? <SettingsMobileSearch /> : null}
              {showRestoreDefaults ? (
                <div className="ms-auto flex items-center gap-2">
                  <Suspense fallback={null}>
                    <RestoreDefaultsButton onRestored={handleRestored} />
                  </Suspense>
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
                <Suspense fallback={null}>
                  <RestoreDefaultsButton onRestored={handleRestored} />
                </Suspense>
              </div>
            ) : null}
          </div>
        )}

        {showMobileTabs ? <SettingsMobileTabs pathname={location.pathname} /> : null}

        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          {pending ? <SettingsPanelPending /> : <Outlet />}
        </div>
      </div>
    </SidebarInset>
  );
}

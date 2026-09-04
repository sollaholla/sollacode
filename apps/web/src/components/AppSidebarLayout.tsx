import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { CloseMobileSidebarOnNavigate } from "./sidebar/CloseMobileSidebarOnNavigate";

import { isElectron } from "../env";
import { shouldShowVoiceOverlay } from "../orchestrator/mobilePresentation";
import { describeVoiceIssue, shouldAnnounceVoiceIssue } from "../orchestrator/voiceErrorNotice";
import { useOrchestratorSessionContext } from "../orchestrator/OrchestratorSessionProvider";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { readDocumentSelection, useComposerQuoteStore } from "../composerQuote";
import { useOrchestratorThread } from "../orchestrator/useOrchestratorThread";
import { buildThreadRouteParams } from "../threadRoutes";
import { useEnvironmentIdentificationMode, useSidebarV2Enabled } from "../hooks/useSettings";
import ThreadSidebar from "./Sidebar";
import ThreadSidebarV2 from "./SidebarV2";
import { useSidebarStageBackdropVariant } from "./SidebarStageBackdrop";
import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import { MobileTopBar } from "./mobile/MobileTopBar";
import {
  Sidebar,
  SidebarInsetChromeProvider,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

/**
 * Collapses the sidebar while the user is in the orchestrator.
 *
 * Being in the orchestrator is a different mode of use from browsing threads:
 * it is the surface being looked at, and a full thread list beside it competes
 * for attention nobody is spending. Restored on the way out, but only if this
 * is what closed it — a sidebar the user had already collapsed stays collapsed
 * rather than springing open when they leave.
 *
 * "In the orchestrator" means having a voice session up — nothing else. Opening
 * the thread to type is not a reason to take the sidebar away.
 */
/** Whether the full-screen listening overlay is currently being rendered. */
function useVoiceOverlayShown(): boolean {
  const [shown, setShown] = useState(() => shouldShowVoiceOverlay());
  useEffect(() => {
    const update = () => setShown(shouldShowVoiceOverlay());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return shown;
}

/**
 * Says out loud what went wrong with voice, because nothing else does.
 *
 * See `voiceErrorNotice` for why the listening overlay does not cover this: its
 * error branch is unreachable, so a failed start reported nothing anywhere.
 */
function OrchestratorVoiceIssueAnnouncer() {
  const session = useOrchestratorSessionContext();
  const message = session?.error ?? null;
  const severity = session?.errorSeverity ?? null;
  const announcedRef = useRef<string | null>(null);

  useEffect(() => {
    // Cleared on recovery so the *same* failure announces again next time it
    // happens, rather than being silently deduplicated hours later.
    if (message === null) {
      announcedRef.current = null;
      return;
    }
    if (!shouldAnnounceVoiceIssue({ message, announced: announcedRef.current })) {
      return;
    }
    announcedRef.current = message;
    const announcement = describeVoiceIssue({ message, severity });
    toastManager.add(
      stackedThreadToast({
        type: announcement.type,
        title: announcement.title,
        description: announcement.description,
        // Longer than the default: these carry an instruction to act on
        // elsewhere (add credits, reconnect), not just a status.
        timeout: 12_000,
        priority: "high",
      }),
    );
  }, [message, severity]);

  return null;
}

function OrchestratorSidebarAutoCollapse() {
  // Two independent open states live behind this context: `open` drives the
  // docked sidebar, `openMobile` the sheet that replaces it on a narrow screen.
  // Collapsing only ever touched `open`, so on a phone — the one place the
  // sidebar most needs to get out of the way — this did nothing at all.
  const { isMobile, open, openMobile, setOpen, setOpenMobile } = useSidebar();
  const session = useOrchestratorSessionContext();
  const voiceLive =
    session !== null &&
    (session.state === "listening" ||
      session.state === "speaking" ||
      session.state === "connecting");
  // The *same* predicate the overlay uses, not an approximation of it. The only
  // reason to move the sidebar is that the overlay is about to cover the screen
  // and the sidebar would sit in its way; anywhere the overlay does not appear,
  // hiding the sidebar takes navigation away for nothing. Sharing the predicate
  // is what stops the two drifting into exactly that state.
  const overlayShown = useVoiceOverlayShown();
  const collapsedByUsRef = useRef(false);
  // Read inside the effect without making them dependencies: reacting to the
  // open state would fight the user reopening the sidebar mid-conversation.
  const visibleRef = useRef(false);
  visibleRef.current = isMobile ? openMobile : open;
  const setVisibleRef = useRef<(next: boolean) => void>(() => undefined);
  setVisibleRef.current = isMobile ? setOpenMobile : setOpen;

  // A live session *and* somewhere the overlay will actually appear.
  //
  // Two rounds of over-application landed here. It first collapsed on merely
  // *viewing* the orchestrator thread, which made opening it to type a hostile
  // experience. Then it collapsed for any live session — but the whole purpose
  // is to keep the sidebar out from under the full-screen overlay, and that
  // overlay is handhelds-only. On a desktop there is nothing to get out of the
  // way of, so taking the sidebar away bought nothing and cost navigation.
  useEffect(() => {
    if (voiceLive && overlayShown) {
      if (visibleRef.current) {
        collapsedByUsRef.current = true;
        setVisibleRef.current(false);
      }
      return;
    }
    if (collapsedByUsRef.current) {
      collapsedByUsRef.current = false;
      setVisibleRef.current(true);
    }
  }, [voiceLive, overlayShown]);

  return null;
}

function SidebarControl() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, toggleSidebar]);

  return (
    <div
      // Phones get the sheet trigger in the mobile top bar instead, so the
      // floating control would only double it (and sit on top of the brand).
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center max-md:hidden"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              className={cn(
                "pointer-events-auto",
                isSidebarVisible &&
                  stageBackdropVariant &&
                  "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
              )}
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const sidebarV2Enabled = useSidebarV2Enabled();
  // Settings routes render the settings nav, which lives in the v1 component
  // and is identical for both sidebars — so v1 stays mounted there.
  const pathname = useLocation({ select: (location) => location.pathname });
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const useSidebarV2 = sidebarV2Enabled && !isOnSettings;
  const useSidebarV2Theme = useSidebarV2 || isOnSettings;
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });
  const sidebarProviderStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    ...(isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}),
  } as CSSProperties;

  useEffect(() => {
    if (!isMacosDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);

  const orchestratorTarget = useOrchestratorThread();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "quote-selection") {
        // Read the selection here rather than shipping it through the menu
        // channel: activating a native menu item leaves the DOM selection
        // intact, and this keeps the action payload a plain string.
        useComposerQuoteStore.getState().requestQuote(readDocumentSelection());
        return;
      }
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
        return;
      }
      // Sent by the floating voice bubble; the same action works from menus.
      if (action === "open-orchestrator") {
        if (orchestratorTarget !== null) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(orchestratorTarget.ref),
          });
        } else {
          void navigate({ to: "/settings/orchestrator" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, orchestratorTarget, pathname]);

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen style={sidebarProviderStyle}>
      {/* Navigating anywhere new dismisses the mobile sheet, so entries do
          not each have to remember to. */}
      <CloseMobileSidebarOnNavigate />
      <OrchestratorSidebarAutoCollapse />
      <OrchestratorVoiceIssueAnnouncer />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        data-sidebar-version={useSidebarV2Theme ? "v2" : "v1"}
        className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
        resizable={{
          maxWidth: sidebarMaximumWidth,
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
            nextWidth <= currentWidth ||
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
          onResize: setSidebarWidth,
        }}
      >
        {useSidebarV2 ? <ThreadSidebarV2 /> : <ThreadSidebar />}
        <SidebarRail />
      </Sidebar>
      <SidebarInsetChromeProvider top={<MobileTopBar />}>{children}</SidebarInsetChromeProvider>
      <SidebarControl />
    </SidebarProvider>
  );
}

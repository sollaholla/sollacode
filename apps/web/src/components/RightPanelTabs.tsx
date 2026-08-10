import type {
  ContextMenuItem,
  PreviewSessionSnapshot,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ClipboardList,
  FileDiff,
  Files,
  Globe2,
  MessagesSquare,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useTheme } from "~/hooks/useTheme";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";

export interface SideChatTabStatus {
  readonly hasConversation: boolean;
  readonly isWorking: boolean;
  readonly provider: {
    readonly driverKind: ProviderDriverKind;
    readonly displayName: string;
    readonly accentColor?: string;
  } | null;
}

export function shouldShowSideChatProviderIcon(status: SideChatTabStatus | null): boolean {
  return status?.hasConversation === true && status.provider !== null;
}

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  terminalLabelsById: ReadonlyMap<string, string>;
  sideChatStatusByThreadId: ReadonlyMap<string, SideChatTabStatus>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  /** Moves `surface` to the slot currently held by `overSurfaceId`. */
  onReorderSurface: (surface: RightPanelSurface, overSurfaceId: string) => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddSideChat: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  sideChatAvailable: boolean;
  children: ReactNode;
  /**
   * Rendered below the surface content, splitting this column vertically.
   * Used for the agents & tasks panel so it shares the right panel's width
   * instead of overlaying the conversation.
   */
  footer?: ReactNode;
}

const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the Solla Code desktop app.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  sideChat: "Side Chat requires a server thread on an updated Solla Code server.",
} as const;

type TabContextMenuAction = "copy-path" | "close" | "close-others" | "close-to-right" | "close-all";

export function resolveHorizontalTabWheelDelta(input: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly viewportWidth: number;
}): number {
  const rawDelta = Math.abs(input.deltaX) >= Math.abs(input.deltaY) ? input.deltaX : input.deltaY;
  if (rawDelta === 0) return 0;
  if (input.deltaMode === 1) return rawDelta * 16;
  if (input.deltaMode === 2) return rawDelta * Math.max(1, input.viewportWidth);
  return rawDelta;
}

interface HorizontalTabViewport {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  scrollLeft: number;
}

interface HorizontalTabWheelEvent {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  preventDefault: () => void;
  stopPropagation: () => void;
  stopImmediatePropagation: () => void;
}

interface HorizontalTabViewportBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface CapturedHorizontalTabWheelEvent extends HorizontalTabWheelEvent {
  composedPath: () => readonly unknown[];
  readonly clientX: number;
  readonly clientY: number;
}

/** True when the gesture's pointer sits inside the strip's own box. */
export function isPointerOverTabStrip(
  box: HorizontalTabViewportBox,
  pointer: { readonly clientX: number; readonly clientY: number },
): boolean {
  return (
    pointer.clientX >= box.left &&
    pointer.clientX <= box.right &&
    pointer.clientY >= box.top &&
    pointer.clientY <= box.bottom
  );
}

/** Routes a wheel gesture to the strip regardless of which nested control is hovered. */
export function routeHorizontalTabWheel(
  viewport: HorizontalTabViewport,
  event: HorizontalTabWheelEvent,
): boolean {
  if (viewport.scrollWidth <= viewport.clientWidth) return false;

  const delta = resolveHorizontalTabWheelDelta({
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    viewportWidth: viewport.clientWidth,
  });
  if (delta === 0) return false;

  const previousScrollLeft = viewport.scrollLeft;
  const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, previousScrollLeft + delta));
  if (nextScrollLeft === previousScrollLeft) return false;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  viewport.scrollLeft = nextScrollLeft;
  return true;
}

/**
 * Claims a window-captured gesture only when it is aimed at this strip.
 *
 * Window capture runs before document-level popovers and scroll locks, which
 * otherwise get the first chance to cancel a wheel event aimed at a tab child.
 *
 * Ownership is geometric as well as path-based. The composed path is the only
 * part of this router that varies with which nested control the pointer sits
 * over, so a retargeted event — a tooltip, an overlay, an SVG glyph inside the
 * close button — used to drop the gesture and stall the strip mid-scroll. The
 * pointer's position over the strip's box cannot vary that way, so either
 * signal is enough to claim the gesture.
 */
export function routeCapturedHorizontalTabWheel(
  viewport: HorizontalTabViewport,
  event: CapturedHorizontalTabWheelEvent,
  /** Read lazily: the path check covers the common case without a layout read. */
  readBox?: (() => HorizontalTabViewportBox | null) | null,
): boolean {
  if (!event.composedPath().includes(viewport)) {
    const box = readBox?.() ?? null;
    if (box === null || !isPointerOverTabStrip(box, event)) return false;
  }
  return routeHorizontalTabWheel(viewport, event);
}

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
    >
      {props.children}
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

export function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddSideChat: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  sideChatAvailable: boolean;
}) {
  const actions = [
    {
      label: "Browser",
      description: "Open a local app or URL.",
      icon: Globe2,
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: "Terminal",
      description: "Start a shell in this workspace.",
      icon: TerminalSquare,
      available: true,
      disabledReason: null,
      onClick: props.onAddTerminal,
    },
    {
      label: "Files",
      description: "Browse and read workspace files.",
      icon: Files,
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      label: "Diff",
      description: "Review changes in this thread.",
      icon: FileDiff,
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: "Side Chat",
      description: "Fork an isolated, disposable sub-agent.",
      icon: MessagesSquare,
      available: props.sideChatAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.sideChat,
      onClick: props.onAddSideChat,
    },
  ] as const;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-foreground">Open a surface</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) => {
            const Icon = action.icon;
            const content = (
              <>
                <Icon className="mb-3 size-5" />
                <span className="text-sm font-medium">{action.label}</span>
                <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </span>
              </>
            );
            if (action.available) {
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className="flex min-h-28 w-full flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left transition hover:border-border hover:bg-accent/60 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                >
                  {content}
                </button>
              );
            }
            const disabledCard = (
              <button
                type="button"
                className="flex min-h-28 w-full cursor-not-allowed flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left opacity-40 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                aria-disabled="true"
              >
                {content}
              </button>
            );
            return (
              <DisabledReasonTooltip
                key={action.label}
                reason={action.disabledReason}
                trigger={disabledCard}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
): string {
  switch (surface.kind) {
    case "diff":
      return "Diff";
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(surface.relativePath.lastIndexOf("/") + 1);
    case "terminal":
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      );
    case "plan":
      return "Plan";
    case "side-chat":
      return surface.title;
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || "Browser";
      } catch {
        return "Browser";
      }
    }
  }
}

function PreviewFavicon({ url }: { url: string | null }) {
  const faviconUrl = faviconUrlForOrigin(url, 32);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!faviconUrl || failedUrl === faviconUrl) return <Globe2 className="size-3.5 shrink-0" />;
  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden
      draggable={false}
      className="size-3.5 shrink-0 rounded-sm"
      onError={() => setFailedUrl(faviconUrl)}
    />
  );
}

function SurfaceIcon({
  surface,
  sessions,
  sideChatStatus,
  theme,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  sideChatStatus: SideChatTabStatus | null;
  theme: "light" | "dark";
}) {
  switch (surface.kind) {
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      return <PreviewFavicon url={url} />;
    }
    case "diff":
      return <FileDiff className="size-3.5 shrink-0" />;
    case "files":
      return <Files className="size-3.5 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3.5"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3.5 shrink-0" />;
    case "plan":
      return <ClipboardList className="size-3.5 shrink-0" />;
    case "side-chat": {
      const icon =
        shouldShowSideChatProviderIcon(sideChatStatus) && sideChatStatus?.provider ? (
          <ProviderInstanceIcon
            driverKind={sideChatStatus.provider.driverKind}
            displayName={sideChatStatus.provider.displayName}
            accentColor={sideChatStatus.provider.accentColor}
            className="size-3.5"
            iconClassName="size-3.5"
          />
        ) : (
          <MessagesSquare className="size-3.5 shrink-0" />
        );
      return (
        <span
          className="relative inline-flex size-3.5 shrink-0"
          data-side-chat-working={sideChatStatus?.isWorking ? "true" : undefined}
        >
          {icon}
          {sideChatStatus?.isWorking ? (
            <span
              aria-label="Side chat working"
              className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-sky-500 ring-1 ring-background"
              role="status"
            />
          ) : null}
        </span>
      );
    }
  }
}

/**
 * One tab, draggable by its label. The close button is deliberately not a drag
 * handle: it is a 16px target whose only job is closing the tab.
 */
function SortableTab(props: {
  surface: RightPanelSurface;
  active: boolean;
  pending: boolean;
  title: string;
  sideChatStatus: SideChatTabStatus | null;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  theme: "light" | "dark";
  /** Set while a drag is settling so the trailing click cannot activate a tab. */
  dragSuppressedRef: RefObject<boolean>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onTabMouseDown: (event: ReactMouseEvent) => void;
  onTabAuxClick: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onTabContextMenu: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: props.surface.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-active-tab={props.active}
      // A drag that ends without a trailing click would otherwise leave the
      // suppression flag armed and swallow the next real activation.
      onPointerDown={() => {
        props.dragSuppressedRef.current = false;
      }}
      onMouseDown={props.onTabMouseDown}
      onAuxClick={(event) => props.onTabAuxClick(event, props.surface)}
      onContextMenu={(event) => void props.onTabContextMenu(event, props.surface)}
      className={cn(
        "group flex h-7 min-w-25 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm",
        props.active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        isDragging && "z-20 opacity-80",
        isOver && !isDragging && "ring-1 ring-primary/40",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              ref={setActivatorNodeRef}
              className="flex min-w-0 flex-1 items-center gap-1.5"
              onClick={() => {
                if (props.dragSuppressedRef.current) {
                  props.dragSuppressedRef.current = false;
                  return;
                }
                props.onActivate(props.surface);
              }}
              {...attributes}
              {...listeners}
            >
              <SurfaceIcon
                surface={props.surface}
                sessions={props.sessions}
                sideChatStatus={props.sideChatStatus}
                theme={props.theme}
              />
              <span className="truncate">{props.title}</span>
            </button>
          }
        />
        <TooltipPopup>{props.title}</TooltipPopup>
      </Tooltip>
      <button
        type="button"
        className={cn(
          "relative flex size-4 shrink-0 items-center justify-center rounded hover:bg-muted focus:opacity-100",
          props.pending ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        aria-label={`Close ${props.title}`}
        onClick={() => props.onCloseSurface(props.surface)}
      >
        {props.pending ? (
          <>
            <span className="size-2 rounded-full bg-current group-hover:hidden" aria-hidden />
            <X className="hidden size-3 group-hover:block" />
          </>
        ) : (
          <X className="size-3" />
        )}
      </button>
    </div>
  );
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "file") {
        items.push({ id: "copy-path", label: "Copy path" });
      }
      items.push(
        { id: "close", label: "Close" },
        {
          id: "close-others",
          label: "Close others",
          disabled: props.surfaces.length <= 1,
        },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        {
          id: "close-all",
          label: "Close all",
          disabled: props.surfaces.length === 0,
        },
      );

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          if (surface.kind === "file") props.onCopyFilePath(surface.relativePath);
          break;
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props],
  );
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const dragSuppressedRef = useRef(false);
  const tabSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleTabDragStart = useCallback(() => {
    dragSuppressedRef.current = true;
  }, []);
  const handleTabDragCancel = useCallback(() => {
    dragSuppressedRef.current = false;
  }, []);
  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const surface = props.surfaces.find((entry) => entry.id === active.id);
      if (!surface) return;
      props.onReorderSurface(surface, String(over.id));
    },
    [props],
  );
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );
  useEffect(() => {
    const viewport = tabListRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;

    const handleWheel = (event: WheelEvent) => {
      routeCapturedHorizontalTabWheel(viewport, event, () => viewport.getBoundingClientRect());
    };

    // Own the gesture at the first DOM boundary. Document-level popovers and
    // scroll locks run before a viewport listener and can otherwise cancel the
    // event while the pointer is over a nested tab control. The router releases
    // it untouched whenever the strip cannot move farther in that direction.
    window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", handleWheel, { capture: true });
  }, []);

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
    >
      <div
        className={cn(
          "workspace-topbar gap-1 pl-2",
          !ownsDesktopTitleBar && "[--workspace-topbar-height:--spacing(11)]",
          props.mode === "inline" ? "pr-28" : "pr-3",
          ownsDesktopTitleBar && "wco:pr-[calc(var(--workspace-native-controls-inset)+6rem)]",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          ref={tabListRef}
          hideScrollbars
          scrollFade
          className={cn("min-w-0 flex-1 rounded-none", ownsDesktopTitleBar && "drag-region")}
          data-right-panel-tab-list
        >
          <div className="flex h-full w-max min-w-full items-center gap-1">
            <DndContext
              sensors={tabSensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
              onDragStart={handleTabDragStart}
              onDragEnd={handleTabDragEnd}
              onDragCancel={handleTabDragCancel}
            >
              <SortableContext
                items={props.surfaces.map((surface) => surface.id)}
                strategy={horizontalListSortingStrategy}
              >
                {props.surfaces.map((surface) => (
                  <SortableTab
                    key={surface.id}
                    surface={surface}
                    active={surface.id === props.activeSurfaceId}
                    pending={props.pendingSurfaceIds.has(surface.id)}
                    title={surfaceTitle(surface, props.previewSessions, props.terminalLabelsById)}
                    sideChatStatus={
                      surface.kind === "side-chat"
                        ? (props.sideChatStatusByThreadId.get(surface.resourceId) ?? null)
                        : null
                    }
                    sessions={props.previewSessions}
                    theme={resolvedTheme}
                    dragSuppressedRef={dragSuppressedRef}
                    onActivate={props.onActivate}
                    onCloseSurface={props.onCloseSurface}
                    onTabMouseDown={handleTabMouseDown}
                    onTabAuxClick={handleTabAuxClick}
                    onTabContextMenu={handleTabContextMenu}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {props.surfaces.length > 0 ? (
              <Menu>
                <MenuTrigger
                  className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Add panel surface"
                >
                  <Plus className="size-4" />
                </MenuTrigger>
                <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-44">
                  <SurfaceMenuItem
                    available={props.browserAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.browser}
                    onClick={props.onAddBrowser}
                  >
                    <Globe2 />
                    Browser
                  </SurfaceMenuItem>
                  <SurfaceMenuItem available onClick={props.onAddTerminal}>
                    <TerminalSquare />
                    Terminal
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.filesAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.files}
                    onClick={props.onAddFiles}
                  >
                    <Files />
                    Files
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.diffAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.diff}
                    onClick={props.onAddDiff}
                  >
                    <FileDiff />
                    Diff
                  </SurfaceMenuItem>
                  <SurfaceMenuItem
                    available={props.sideChatAvailable}
                    disabledReason={SURFACE_DISABLED_REASONS.sideChat}
                    onClick={props.onAddSideChat}
                  >
                    <MessagesSquare />
                    Side Chat
                  </SurfaceMenuItem>
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </ScrollArea>
        {props.layoutControls}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddSideChat={props.onAddSideChat}
            browserAvailable={props.browserAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            sideChatAvailable={props.sideChatAvailable}
          />
        ) : (
          props.children
        )}
      </div>
      {props.footer}
    </PreviewPanelShell>
  );
}

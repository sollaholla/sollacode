import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, type ReactNode } from "react";

import { onOpenCommandPalette } from "../commandPaletteBus";
import { ComposerHandleContext } from "../composerHandleContext";
import { resolveShortcutCommand } from "../keybindings";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { reduceCommandPaletteUiState, type SearchOverlayMode } from "./CommandPalette.logic";

const LazyCommandPaletteOverlay = lazy(() =>
  import("./CommandPalette").then((module) => ({ default: module.CommandPaletteOverlay })),
);

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
  "projectSearch.toggle": "content",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}

function CommandPaletteLoadingFallback({ onDismiss }: { readonly onDismiss: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onDismiss]);

  return (
    <div
      aria-label="Command palette"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[max(--spacing(4),10vh)]"
      role="dialog"
    >
      <button
        aria-label="Close command palette"
        className="absolute inset-0 bg-black/20 backdrop-blur-[2px]"
        onClick={onDismiss}
        type="button"
      />
      <div className="relative w-full max-w-xl rounded-2xl border border-border bg-popover px-4 py-3 text-sm text-muted-foreground shadow-2xl">
        Loading commands…
      </div>
    </div>
  );
}

/**
 * Keeps shortcut and event handling in the startup bundle while deferring the
 * large palette implementation until the user first opens it.
 */
export function CommandPaletteLoader({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const [hasLoadedPalette, markPaletteLoaded] = useReducer(() => true, false);
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);
  const toggleMode = useCallback(
    (mode: SearchOverlayMode) => dispatch({ _tag: "ToggleMode", mode }),
    [],
  );
  const openAddProject = useCallback(() => dispatch({ _tag: "OpenAddProject" }), []);
  const openNewThreadIn = useCallback(() => dispatch({ _tag: "OpenNewThreadIn" }), []);
  const clearOpenIntent = useCallback(() => dispatch({ _tag: "ClearOpenIntent" }), []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((storeState) =>
    routeThreadRef
      ? selectThreadTerminalUiState(storeState.terminalUiStateByThreadKey, routeThreadRef)
          .mainSurface === "terminal"
      : false,
  );
  const previewOpen = useRightPanelStore((storeState) =>
    routeThreadRef
      ? selectActiveRightPanel(storeState.byThreadKey, routeThreadRef) === "preview"
      : false,
  );

  useEffect(() => {
    if (!state.open || state.mode === "command") return;
    const onEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode("command");
    };
    window.addEventListener("keydown", onEscapeKeyDown, true);
    return () => window.removeEventListener("keydown", onEscapeKeyDown, true);
  }, [state.mode, state.open, toggleMode]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
        },
      });
      const mode = overlayModeForCommand(command);
      if (mode === null) return;
      event.preventDefault();
      event.stopPropagation();
      markPaletteLoaded();
      toggleMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, previewOpen, terminalOpen, toggleMode]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        markPaletteLoaded();
        if (detail.open === "new-thread-in") {
          openNewThreadIn();
        } else if (detail.open === "add-project") {
          openAddProject();
        } else {
          setOpen(true);
        }
      }),
    [openAddProject, openNewThreadIn, setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      {children}
      {hasLoadedPalette ? (
        <Suspense
          fallback={
            state.open ? <CommandPaletteLoadingFallback onDismiss={() => setOpen(false)} /> : null
          }
        >
          <LazyCommandPaletteOverlay
            clearOpenIntent={clearOpenIntent}
            mode={state.mode}
            open={state.open}
            openIntent={state.openIntent}
            setOpen={setOpen}
            toggleMode={toggleMode}
          />
        </Suspense>
      ) : null}
    </ComposerHandleContext>
  );
}

import { useCallback, useRef } from "react";

export const COMPOSER_STATUS_ICON_CHIP_CLASS_NAME =
  "chat-composer-status-chip pointer-events-auto flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full border bg-background/95 p-1.5 text-xs font-medium";

export const COMPOSER_WAITING_CHIP_CLASS_NAME =
  "border-amber-500/35 text-amber-700 hover:border-amber-500/60 dark:text-amber-300";

/**
 * The rail's icon-and-count chips: side chats, terminals, queued messages and
 * background tasks. Pair it with one of the colour classes below.
 */
export const COMPOSER_STATUS_COUNT_CHIP_CLASS_NAME =
  "chat-composer-status-chip pointer-events-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border bg-background/95 px-2.5 py-1 text-xs font-medium transition-colors";

/** Something is running: a side chat, a terminal, a background task. */
export const COMPOSER_WORKING_CHIP_CLASS_NAME =
  "border-gold-500/30 text-gold-600 hover:text-gold-500 dark:text-gold-400";

/** Nothing is running, but there is something to look at. */
export const COMPOSER_IDLE_CHIP_CLASS_NAME =
  "border-border/60 text-muted-foreground hover:text-foreground";

export const COMPOSER_FAILED_CHIP_CLASS_NAME =
  "border-destructive/40 text-destructive hover:bg-destructive/5";

/**
 * Chip popups line up with the end of the whole status rail, so every chip's
 * popup shares the composer's right edge. Their width comes from the viewport,
 * not from `--anchor-width`: Base UI sizes the positioner before it has set
 * that variable, so a popup sized from it was measured at its text width and
 * then grew past a phone's right edge, hiding each row's Stop button.
 */
export function useComposerRailAnchor() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchor = useCallback(
    () => triggerRef.current?.closest("[data-chat-composer-status-rail]") ?? triggerRef.current,
    [],
  );
  return { triggerRef, anchor };
}

export const COMPOSER_RAIL_POPUP_NARROW_CLASS_NAME = "w-[min(20rem,calc(100vw-1.5rem))]";
export const COMPOSER_RAIL_POPUP_WIDE_CLASS_NAME = "w-[min(28rem,calc(100vw-1.5rem))]";

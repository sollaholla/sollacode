import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  isHorizontalSwipe,
  resolveSwipeOffset,
  shouldCommitSwipe,
  swipeActionForDirection,
  swipeDirection,
  swipeProgress,
  type SidebarSwipeAction,
  type SidebarSwipeCapabilities,
} from "./sidebarRowSwipe";

export interface SidebarRowSwipeState {
  /** Pixels to translate the row by. 0 when idle. */
  readonly offset: number;
  /** The action a release would commit, or null. */
  readonly action: SidebarSwipeAction | null;
  /** 0…1 through the gesture, for fading the panel in. */
  readonly progress: number;
  /** True once the threshold is passed, for the panel's armed state. */
  readonly armed: boolean;
  /** True while a gesture owns the pointer, to suppress the row transition. */
  readonly dragging: boolean;
}

const IDLE: SidebarRowSwipeState = {
  offset: 0,
  action: null,
  progress: 0,
  armed: false,
  dragging: false,
};

export interface UseSidebarRowSwipeOptions {
  readonly enabled: boolean;
  readonly capabilities: SidebarSwipeCapabilities;
  readonly onCommit: (action: SidebarSwipeAction) => void;
}

export interface UseSidebarRowSwipeResult {
  readonly state: SidebarRowSwipeState;
  readonly handlers: {
    readonly onPointerDown: (event: ReactPointerEvent) => void;
    readonly onPointerMove: (event: ReactPointerEvent) => void;
    readonly onPointerUp: (event: ReactPointerEvent) => void;
    readonly onPointerCancel: (event: ReactPointerEvent) => void;
  };
  /**
   * Whether the click that follows this gesture should be swallowed.
   *
   * A swipe ends with a `click` on the row, which would otherwise open the
   * thread the user just settled. Consumes the flag, so it suppresses exactly
   * one click.
   */
  readonly consumeSuppressedClick: () => boolean;
}

/**
 * Slide-to-act gesture for a sidebar thread row.
 *
 * Claims the pointer only once the movement reads as horizontal, so the
 * vertical scroll these rows live in keeps working; pair with `touch-action:
 * pan-y` so the browser still drives that scroll itself.
 */
export function useSidebarRowSwipe(options: UseSidebarRowSwipeOptions): UseSidebarRowSwipeResult {
  const { enabled, capabilities, onCommit } = options;
  const [state, setState] = useState<SidebarRowSwipeState>(IDLE);
  const pointerIdRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const activeRef = useRef(false);
  const suppressClickRef = useRef(false);
  // Read in the pointerup handler, which must not depend on a state update
  // having been flushed first.
  const latestRef = useRef<{ dx: number; action: SidebarSwipeAction | null }>({
    dx: 0,
    action: null,
  });

  const reset = useCallback(() => {
    pointerIdRef.current = null;
    startRef.current = null;
    activeRef.current = false;
    latestRef.current = { dx: 0, action: null };
    setState(IDLE);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!enabled || pointerIdRef.current !== null) return;
      // Mouse drags are not this gesture; the pointer devices that need it are
      // the ones with no hover to reveal the buttons instead.
      if (event.pointerType === "mouse") return;
      // A gesture only ever suppresses its own click. On touch a drag often
      // produces no click at all, so a flag left set by the previous swipe
      // would swallow the next genuine tap and the row would need tapping
      // twice.
      suppressClickRef.current = false;
      pointerIdRef.current = event.pointerId;
      startRef.current = { x: event.clientX, y: event.clientY };
      activeRef.current = false;
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const start = startRef.current;
      if (start === null || event.pointerId !== pointerIdRef.current) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;

      if (!activeRef.current) {
        if (!isHorizontalSwipe(dx, dy)) return;
        activeRef.current = true;
        // From here the row owns the pointer, so a finger that wanders off it
        // still drives the gesture rather than dropping it mid-swipe.
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      const direction = swipeDirection(dx);
      const action = direction === null ? null : swipeActionForDirection(direction, capabilities);
      latestRef.current = { dx, action };
      const hasAction = action !== null;
      setState({
        offset: resolveSwipeOffset(dx, hasAction),
        action,
        progress: swipeProgress(dx, hasAction),
        armed: shouldCommitSwipe(dx, hasAction),
        dragging: true,
      });
    },
    [capabilities],
  );

  const finish = useCallback(
    (event: ReactPointerEvent, commit: boolean) => {
      if (event.pointerId !== pointerIdRef.current) return;
      const wasActive = activeRef.current;
      const { dx, action } = latestRef.current;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // Any horizontal gesture eats its click, committed or not: a row that
      // slid and sprang back should not also open.
      if (wasActive) suppressClickRef.current = true;
      reset();
      if (commit && action !== null && shouldCommitSwipe(dx, action !== null)) {
        onCommit(action);
      }
    },
    [onCommit, reset],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent) => {
      finish(event, true);
    },
    [finish],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent) => {
      finish(event, false);
    },
    [finish],
  );

  const consumeSuppressedClick = useCallback(() => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  }, []);

  return {
    state: enabled ? state : IDLE,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    consumeSuppressedClick,
  };
}

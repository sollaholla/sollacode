import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  isHorizontalSwipe,
  resolveSwipeOffset,
  shouldCommitSwipe,
  swipeDirection,
  swipeProgress,
  type SidebarSwipeDirection,
} from "./sidebarRowSwipe";

export interface SidebarRowSwipeState<TAction = string> {
  /** Pixels to translate the row by. 0 when idle. */
  readonly offset: number;
  /** The action a release would commit, or null. */
  readonly action: TAction | null;
  /** 0…1 through the gesture, for fading the panel in. */
  readonly progress: number;
  /** True once the threshold is passed, for the panel's armed state. */
  readonly armed: boolean;
  /** True while a gesture owns the pointer, to suppress the row transition. */
  readonly dragging: boolean;
}

const IDLE: SidebarRowSwipeState<never> = {
  offset: 0,
  action: null,
  progress: 0,
  armed: false,
  dragging: false,
};

export interface UseSidebarRowSwipeOptions<TAction> {
  readonly enabled: boolean;
  /**
   * What a swipe in this direction would do, or null for "nothing here".
   *
   * The geometry is shared across every swipeable row; the meaning of a
   * direction is not, so it is the caller's to decide. Returning null leaves
   * the row inert that way, which is how an unavailable action reads as
   * unavailable before the finger lifts.
   */
  readonly resolveAction: (direction: SidebarSwipeDirection) => TAction | null;
  readonly onCommit: (action: TAction) => void;
}

export interface UseSidebarRowSwipeResult<TAction> {
  readonly state: SidebarRowSwipeState<TAction>;
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
export function useSidebarRowSwipe<TAction>(
  options: UseSidebarRowSwipeOptions<TAction>,
): UseSidebarRowSwipeResult<TAction> {
  const { enabled, resolveAction, onCommit } = options;
  const [state, setState] = useState<SidebarRowSwipeState<TAction>>(IDLE);
  const pointerIdRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const activeRef = useRef(false);
  const suppressClickRef = useRef(false);
  // Read in the pointerup handler, which must not depend on a state update
  // having been flushed first.
  const latestRef = useRef<{ dx: number; action: TAction | null }>({
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
      const action = direction === null ? null : resolveAction(direction);
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
    [resolveAction],
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

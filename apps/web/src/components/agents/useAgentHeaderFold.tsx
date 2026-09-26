import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  dragProgress,
  dragTransform,
  DRAG_START_DISTANCE_PX,
  estimateCollapsedAvatarRect,
  FLIGHT_DURATION_MS,
  FLIGHT_EASING,
  type FlightRect,
  flightTransform,
  rectOf,
  releasedDragCollapses,
} from "./agentHeaderFlight";

const RESTING_TRANSFORM = "translate(0px, 0px) scale(1)";

interface Flight {
  /** The avatar's place on the card: the stand-in is laid out there. */
  readonly base: FlightRect;
  readonly phase: "drag" | "fold" | "unfold" | "return";
  readonly startTransform: string;
}

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly base: FlightRect;
  readonly target: FlightRect;
  dragging: boolean;
  progress: number;
  transform: string;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Folds an agent's header card into the phone top bar and back. Dragging the
 * card's avatar up and to the right carries it there; letting go a good way
 * along folds the card, anything less sends the avatar home. Tapping the
 * folded avatar opens the card again.
 *
 * While the avatar travels, both real avatars hide and a stand-in drawn over
 * the page flies between them: the card clips its contents as it closes, and
 * the stand-in is what lets the avatar leave it. Each flight is one short
 * animation, never a loop.
 */
export function useAgentHeaderFold(input: {
  /** A phone layout with its top bar mounted; everywhere else the card stays. */
  readonly enabled: boolean;
  readonly slot: HTMLElement | null;
  readonly setCollapsed: (collapsed: boolean) => void;
}) {
  const cardAvatarRef = useRef<HTMLDivElement>(null);
  const barAvatarRef = useRef<HTMLSpanElement>(null);
  const standInRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  const { enabled, slot, setCollapsed } = input;

  useLayoutEffect(() => {
    if (flight === null || flight.phase === "drag") return;
    const standIn = standInRef.current;
    let end = RESTING_TRANSFORM;
    if (flight.phase === "fold") {
      const landing = barAvatarRef.current
        ? rectOf(barAvatarRef.current)
        : slot
          ? estimateCollapsedAvatarRect(rectOf(slot))
          : null;
      if (landing === null) {
        setFlight(null);
        return;
      }
      end = flightTransform(flight.base, landing);
    }
    if (!standIn || typeof standIn.animate !== "function" || prefersReducedMotion()) {
      setFlight(null);
      return;
    }
    const animation = standIn.animate([{ transform: flight.startTransform }, { transform: end }], {
      duration: FLIGHT_DURATION_MS,
      easing: FLIGHT_EASING,
      fill: "forwards",
    });
    let finished = false;
    animation.onfinish = () => {
      finished = true;
      setFlight(null);
    };
    return () => {
      if (!finished) animation.cancel();
    };
  }, [flight, slot]);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.dragging) return;
    if (!cancelled && releasedDragCollapses(drag.progress)) {
      setCollapsed(true);
      setFlight({ base: drag.base, phase: "fold", startTransform: drag.transform });
      return;
    }
    setFlight({ base: drag.base, phase: "return", startTransform: drag.transform });
  };

  const cardAvatarProps = enabled
    ? {
        ref: cardAvatarRef,
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
          if (flight !== null || slot === null || !cardAvatarRef.current) return;
          if (event.pointerType === "mouse" && event.button !== 0) return;
          const base = rectOf(cardAvatarRef.current);
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            base,
            target: estimateCollapsedAvatarRect(rectOf(slot)),
            dragging: false,
            progress: 0,
            transform: RESTING_TRANSFORM,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        },
        onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const dx = event.clientX - drag.startX;
          const dy = event.clientY - drag.startY;
          if (!drag.dragging) {
            if (Math.hypot(dx, dy) < DRAG_START_DISTANCE_PX) return;
            drag.dragging = true;
          }
          drag.progress = dragProgress(dx, dy, drag.base, drag.target);
          drag.transform = dragTransform(dx, dy, drag.progress, drag.base, drag.target);
          // Follows the finger without a render per move; the first move
          // mounts the stand-in.
          if (standInRef.current) standInRef.current.style.transform = drag.transform;
          else setFlight({ base: drag.base, phase: "drag", startTransform: drag.transform });
        },
        onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => endDrag(event, false),
        onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => endDrag(event, true),
      }
    : { ref: cardAvatarRef };

  return {
    cardAvatarProps,
    barAvatarRef,
    /** Both real avatars hide while the stand-in is in the air. */
    flying: flight !== null,
    /** Folds without a drag: the agent menu's way in, for keyboards too. */
    fold: () => {
      setCollapsed(true);
      if (!cardAvatarRef.current) return;
      setFlight({
        base: rectOf(cardAvatarRef.current),
        phase: "fold",
        startTransform: RESTING_TRANSFORM,
      });
    },
    unfold: () => {
      setCollapsed(false);
      // The card's avatar keeps its layout while folded (only clipped), so
      // its landing spot is already known.
      if (!cardAvatarRef.current || !barAvatarRef.current) return;
      const base = rectOf(cardAvatarRef.current);
      setFlight({
        base,
        phase: "unfold",
        startTransform: flightTransform(base, rectOf(barAvatarRef.current)),
      });
    },
    standIn: (avatar: ReactNode) =>
      flight === null || typeof document === "undefined"
        ? null
        : createPortal(
            <div
              ref={standInRef}
              aria-hidden
              data-agent-avatar-stand-in=""
              className="pointer-events-none fixed z-[100] origin-top-left [&>*]:size-full"
              style={{
                left: flight.base.left,
                top: flight.base.top,
                width: flight.base.width,
                height: flight.base.height,
                transform: flight.startTransform,
              }}
            >
              {avatar}
            </div>,
            document.body,
          ),
  };
}

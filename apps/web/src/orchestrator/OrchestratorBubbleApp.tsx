import { useEffect, useRef, useState } from "react";
import type { DesktopOrchestratorBubbleState } from "@t3tools/contracts";
import { AudioLinesIcon, LoaderIcon, MessageSquareIcon, MicIcon, MicOffIcon } from "lucide-react";

import {
  BUBBLE_BASE_DIAMETER,
  computeBubbleGlow,
  computeBubbleScale,
  smoothBubbleScale,
} from "./bubblePresentation";

/**
 * The entire renderer of the floating always-on-top bubble window.
 *
 * Mounted instead of the app router when the desktop shell loads
 * `#/orchestrator-bubble` (see `main.tsx`). It holds no environment
 * connections and no voice session — the main window streams voice state over
 * the desktop bridge, and every interaction routes back through it:
 * click → open the orchestrator thread; drag → move this window.
 */

const IDLE_STATE: DesktopOrchestratorBubbleState = {
  status: "idle",
  micLevel: 0,
  assistantLevel: 0,
};

/** Pointer travel below this is a click; above it, a drag. */
const CLICK_MOVEMENT_THRESHOLD_PX = 5;

const STATUS_COLORS: Record<DesktopOrchestratorBubbleState["status"], string> = {
  idle: "rgba(120, 120, 130, 0.85)",
  connecting: "rgba(139, 92, 246, 0.9)",
  listening: "rgba(139, 92, 246, 1)",
  speaking: "rgba(59, 130, 246, 1)",
  // Same family as speaking — the assistant still holds the floor — but dimmer,
  // because nothing is coming out yet.
  working: "rgba(59, 130, 246, 0.72)",
  error: "rgba(239, 68, 68, 0.95)",
};

export function OrchestratorBubbleApp() {
  const [state, setState] = useState<DesktopOrchestratorBubbleState>(IDLE_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [displayScale, setDisplayScale] = useState(1);

  // The window itself is transparent; the page must be too or the orb sits on
  // an opaque 128px square.
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    const bridge = window.desktopBridge?.orchestratorBubble;
    if (bridge === undefined) return;
    return bridge.onState(setState);
  }, []);

  // Survives the effect re-running when the status changes, so the orb eases
  // from wherever it currently is rather than snapping back to rest.
  const scaleRef = useRef(1);

  // Animation loop: chase the target scale with asymmetric smoothing so the
  // orb swells with speech and eases back down.
  //
  // It stops once there is nothing left to animate. This window is transparent,
  // always-on-top, and deliberately exempt from background throttling, so an
  // unconditional 60fps loop keeps the compositor busy around the clock — it
  // measured ~30% of WindowServer with the orb merely sitting there idle.
  useEffect(() => {
    const animating = state.status !== "idle" && state.status !== "error";
    let frame: number | null = null;

    const tick = () => {
      const target = computeBubbleScale(stateRef.current);
      const next = smoothBubbleScale(scaleRef.current, target);
      scaleRef.current = next;
      setDisplayScale((previous) => (Math.abs(previous - next) < 0.002 ? previous : next));

      // At rest and settled: nothing changes again until the next state push,
      // which re-arms this effect.
      if (!animating && Math.abs(next - target) < 0.002) {
        frame = null;
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [state.status]);

  const dragRef = useRef<{
    pointerId: number;
    grabOffsetX: number;
    grabOffsetY: number;
    startScreenX: number;
    startScreenY: number;
    moved: boolean;
  } | null>(null);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      // The offset between the cursor and the window's top-left corner stays
      // constant for the whole drag, so the orb never jumps under the cursor.
      grabOffsetX: event.screenX - window.screenX,
      grabOffsetY: event.screenY - window.screenY,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      moved: false,
    };
    // Main process latches the OS cursor vs window origin. Renderer screenX
    // on Windows unfocusable/DPI windows does not track setPosition.
    void window.desktopBridge?.orchestratorBubble?.beginDrag?.().catch(() => undefined);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (
      !drag.moved &&
      Math.hypot(event.screenX - drag.startScreenX, event.screenY - drag.startScreenY) <
        CLICK_MOVEMENT_THRESHOLD_PX
    ) {
      return;
    }
    drag.moved = true;
    const bridge = window.desktopBridge?.orchestratorBubble;
    if (bridge === undefined) return;
    void bridge
      .move({ x: event.screenX - drag.grabOffsetX, y: event.screenY - drag.grabOffsetY })
      .catch(() => undefined);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const bridge = window.desktopBridge?.orchestratorBubble;
    if (bridge === undefined) return;
    if (drag.moved) {
      void bridge.dragEnd().catch(() => undefined);
    } else {
      // A tap on the orb is the microphone: start or stop talking. Opening the
      // thread is the secondary button, so the common action needs no aim.
      void bridge.toggleVoice?.().catch(() => undefined);
    }
  };

  const handleOpenThread = (event: React.PointerEvent<HTMLButtonElement>) => {
    // Keep the press off the drag surface underneath, or opening the thread
    // would also arm a drag and toggle the microphone on release.
    event.stopPropagation();
    void window.desktopBridge?.orchestratorBubble?.open().catch(() => undefined);
  };

  const color = STATUS_COLORS[state.status];
  const glow = computeBubbleGlow(state);
  const speaking = state.status === "speaking";
  const listening = state.status === "listening";
  // The assistant is between sentences with a tool call in flight. The user
  // cannot take the floor, so the orb must not show an open microphone.
  const working = state.status === "working";

  return (
    <div
      data-testid="orchestrator-bubble"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: dragRef.current?.moved === true ? "grabbing" : "grab",
        userSelect: "none",
        WebkitUserSelect: "none",
        overflow: "hidden",
        background: "transparent",
      }}
      title={
        working
          ? "Working — wait for the reply · click to stop · drag to move"
          : listening || speaking
            ? "Click to stop talking · drag to move"
            : "Click to start talking · drag to move"
      }
    >
      {/*
        Sized to the orb and positioned relative, so the thread button below can
        hang off the orb's rim. Anchoring that button to the window instead put
        it in the far corner — the orb is 56px inside a 128px window, so it sat
        roughly 30px adrift and read as an unrelated control.
      */}
      <div
        style={{
          position: "relative",
          width: BUBBLE_BASE_DIAMETER,
          height: BUBBLE_BASE_DIAMETER,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: BUBBLE_BASE_DIAMETER,
            height: BUBBLE_BASE_DIAMETER,
            borderRadius: "50%",
            transform: `scale(${displayScale})`,
            background: `radial-gradient(circle at 32% 30%, rgba(255,255,255,0.55), ${color} 62%)`,
            boxShadow: `0 2px 14px rgba(0,0,0,0.35), 0 0 ${12 + glow * 26}px ${color}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 240ms ease, box-shadow 120ms linear",
            animation:
              state.status === "connecting"
                ? "orchestrator-bubble-pulse 1.1s ease-in-out infinite"
                : undefined,
          }}
        >
          {speaking ? (
            <AudioLinesIcon size={22} color="rgba(255,255,255,0.92)" strokeWidth={2.2} />
          ) : working ? (
            // Not a microphone: the whole point is that the user cannot speak
            // into this moment and the orb previously implied they could.
            <LoaderIcon
              size={22}
              color="rgba(255,255,255,0.9)"
              strokeWidth={2.2}
              style={{ animation: "orchestrator-bubble-spin 1.1s linear infinite" }}
            />
          ) : listening ? (
            <MicIcon size={22} color="rgba(255,255,255,0.95)" strokeWidth={2.2} />
          ) : (
            // Muted mic at rest, so the orb reads as a control that is currently
            // off rather than one that is listening to everything.
            <MicOffIcon size={22} color="rgba(255,255,255,0.62)" strokeWidth={2.2} />
          )}
        </div>

        <button
          type="button"
          data-testid="orchestrator-bubble-open-thread"
          onPointerDown={handleOpenThread}
          title="Open the orchestrator thread"
          aria-label="Open the orchestrator thread"
          style={{
            position: "absolute",
            // Just off the orb's lower-right rim. The orb scales with audio;
            // the button deliberately does not, so it stays where you reached.
            right: -6,
            bottom: -6,
            width: 22,
            height: 22,
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.16)",
            background: "rgba(28,28,32,0.92)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            cursor: "pointer",
            boxShadow: "0 1px 6px rgba(0,0,0,0.45)",
          }}
        >
          <MessageSquareIcon size={12} color="rgba(255,255,255,0.82)" strokeWidth={2.4} />
        </button>
      </div>
      <style>{`
        @keyframes orchestrator-bubble-pulse {
          0%, 100% { opacity: 0.75; }
          50% { opacity: 1; }
        }
        @keyframes orchestrator-bubble-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

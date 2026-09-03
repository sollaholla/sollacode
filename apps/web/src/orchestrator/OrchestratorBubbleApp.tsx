import { useEffect, useRef, useState } from "react";
import type { DesktopOrchestratorBubbleState } from "@t3tools/contracts";
import { AudioLinesIcon, LoaderIcon, MessageSquareIcon, MicIcon, MicOffIcon } from "lucide-react";

import {
  BUBBLE_BASE_DIAMETER,
  computeBubbleGlow,
  computeBubbleScale,
  smoothBubbleScale,
} from "./bubblePresentation";
import { BlackHoleOrb, type OrbTint } from "../components/orchestrator/BlackHoleOrb";

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

/**
 * Which tint the black hole wears per status. Listening is the user's colour
 * even before they speak: the microphone is theirs, and the orb has always
 * gone quiet-purple then, which read as "the assistant is doing something".
 */
const STATUS_TINTS: Record<DesktopOrchestratorBubbleState["status"], OrbTint> = {
  idle: "idle",
  connecting: "connecting",
  listening: "user",
  speaking: "assistant",
  working: "waiting",
  error: "error",
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

  const threadButtonRef = useRef<HTMLButtonElement>(null);

  // The bubble window is much wider than the orb so the orb can swell without
  // being clipped by the window rectangle. That surplus is transparent, and a
  // transparent always-on-top window still eats OS clicks, so the window is
  // click-through by default and only takes clicks back while the cursor is
  // actually over the orb (or its thread button).
  useEffect(() => {
    const bridge = window.desktopBridge?.orchestratorBubble;
    const setInteractive = bridge?.setInteractive;
    if (setInteractive === undefined) return;
    let interactive = true;
    const apply = (next: boolean) => {
      if (next === interactive) return;
      interactive = next;
      void setInteractive(next).catch(() => undefined);
    };
    const isOverControls = (x: number, y: number) => {
      // Never hand the clicks back mid-drag: the cursor routinely leaves the
      // orb while dragging, and going click-through would drop the gesture.
      if (dragRef.current !== null) return true;
      const button = threadButtonRef.current?.getBoundingClientRect();
      if (
        button !== undefined &&
        x >= button.left &&
        x <= button.right &&
        y >= button.top &&
        y <= button.bottom
      ) {
        return true;
      }
      // The orb is centred in the window and scales about its middle, so its
      // drawn radius follows the live scale rather than the layout box.
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const radius = (BUBBLE_BASE_DIAMETER / 2) * scaleRef.current + 2;
      return Math.hypot(x - centerX, y - centerY) <= radius;
    };
    const onMove = (event: MouseEvent) => apply(isOverControls(event.clientX, event.clientY));
    window.addEventListener("mousemove", onMove);
    apply(false);
    return () => {
      window.removeEventListener("mousemove", onMove);
      void setInteractive(true).catch(() => undefined);
    };
  }, []);

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

  const tint = STATUS_TINTS[state.status];
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
        <BlackHoleOrb
          size={BUBBLE_BASE_DIAMETER}
          tint={tint}
          scale={displayScale}
          intensity={glow}
          // Still at rest: a disk spinning in the corner of the screen all day
          // is the kind of thing that gets the bubble switched off.
          spinning={state.status !== "idle" && state.status !== "error"}
          breathing={state.status === "connecting"}
        >
          {speaking ? (
            <AudioLinesIcon size={20} color="rgba(255,255,255,0.92)" strokeWidth={2.2} />
          ) : working ? (
            // Not a microphone: the whole point is that the user cannot speak
            // into this moment and the orb previously implied they could.
            <LoaderIcon
              size={20}
              color="rgba(255,255,255,0.9)"
              strokeWidth={2.2}
              style={{ animation: "orchestrator-bubble-spin 1.1s linear infinite" }}
            />
          ) : listening ? (
            <MicIcon size={20} color="rgba(255,255,255,0.95)" strokeWidth={2.2} />
          ) : (
            // Muted mic at rest, so the orb reads as a control that is currently
            // off rather than one that is listening to everything.
            <MicOffIcon size={20} color="rgba(255,255,255,0.62)" strokeWidth={2.2} />
          )}
        </BlackHoleOrb>

        <button
          type="button"
          data-testid="orchestrator-bubble-open-thread"
          ref={threadButtonRef}
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
        @keyframes orchestrator-bubble-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

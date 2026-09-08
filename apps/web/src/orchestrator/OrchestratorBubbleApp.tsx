import { useEffect, useRef, useState } from "react";
import type { DesktopOrchestratorBubbleState } from "@t3tools/contracts";
import { AudioLinesIcon, LoaderIcon, MessageSquareIcon, MicIcon, MicOffIcon } from "lucide-react";

import { BUBBLE_BASE_DIAMETER, computeBubbleGlow, computeBubbleScale } from "./bubblePresentation";
import { GalacticOrb, type OrbTint } from "../components/orchestrator/GalacticOrb";

/**
 * The entire renderer of the floating always-on-top bubble window.
 *
 * Mounted instead of the app router when the desktop shell loads
 * `#/orchestrator-bubble` (see `main.tsx`). It holds no environment
 * connections and no voice session — the main window streams voice state over
 * the desktop bridge, and every interaction routes back through it:
 * click → toggle voice; secondary button → open the thread; drag → move this window.
 */

const IDLE_STATE: DesktopOrchestratorBubbleState = {
  status: "idle",
  micLevel: 0,
  assistantLevel: 0,
};

/** Pointer travel below this is a click; above it, a drag. */
const CLICK_MOVEMENT_THRESHOLD_PX = 5;

/**
 * Which tint the galaxy wears per status. Listening is the user's colour
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
  const orbRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const glowRef = useRef(0);

  // The window itself is transparent; the page must be too or the orb sits on
  // an opaque 128px square.
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    const bridge = window.desktopBridge?.orchestratorBubble;
    if (bridge === undefined) return;
    return bridge.onState((next) => {
      const nextScale = computeBubbleScale(next);
      const nextGlow = computeBubbleGlow(next);
      const orb = orbRef.current;
      if (orb !== null) {
        // Audio arrives over IPC about 12 times a second. Mutate the two
        // compositor-facing values directly so every sample does not
        // reconcile the 64-star SVG tree. CSS transitions fill the gaps.
        orb.style.transitionDuration = nextScale > scaleRef.current ? "70ms" : "180ms";
        orb.style.transform = `scale(${nextScale})`;
        orb.style.setProperty("--orb-intensity", String(nextGlow));
      }
      scaleRef.current = nextScale;
      glowRef.current = nextGlow;
      // Status changes swap the icon and palette. Level-only updates do not
      // need React at all.
      setState((current) => (current.status === next.status ? current : next));
    });
  }, []);

  const threadButtonRef = useRef<HTMLButtonElement>(null);
  const [hintTarget, setHintTarget] = useState<"voice" | "thread" | null>(null);
  const [hintVisible, setHintVisible] = useState(false);

  // Native title popups can outlive a click-through Electron window's hover.
  // This hint belongs to the renderer and has a hard expiry even if the OS
  // never delivers pointerleave when it starts forwarding clicks again.
  useEffect(() => {
    setHintVisible(false);
    if (hintTarget === null) return;
    const show = window.setTimeout(() => setHintVisible(true), 500);
    const expire = window.setTimeout(() => setHintVisible(false), 2_500);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(expire);
    };
  }, [hintTarget]);

  // The bubble window is much wider than the orb so the orb can swell without
  // being clipped by the window rectangle. That surplus is transparent, and a
  // transparent always-on-top window still eats OS clicks, so the window is
  // click-through by default and only takes clicks back while the cursor is
  // actually over the orb (or its thread button).
  useEffect(() => {
    const bridge = window.desktopBridge?.orchestratorBubble;
    const setInteractive = bridge?.setInteractive;
    let interactive = true;
    const apply = (next: boolean) => {
      if (next === interactive) return;
      interactive = next;
      void setInteractive?.(next).catch(() => undefined);
    };
    const controlAt = (x: number, y: number): "voice" | "thread" | null => {
      // Never hand the clicks back mid-drag: the cursor routinely leaves the
      // orb while dragging, and going click-through would drop the gesture.
      if (dragRef.current !== null) return "voice";
      const button = threadButtonRef.current?.getBoundingClientRect();
      if (
        button !== undefined &&
        x >= button.left &&
        x <= button.right &&
        y >= button.top &&
        y <= button.bottom
      ) {
        return "thread";
      }
      // The orb is centred in the window and scales about its middle, so its
      // drawn radius follows the live scale rather than the layout box.
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const radius = (BUBBLE_BASE_DIAMETER / 2) * scaleRef.current + 2;
      return Math.hypot(x - centerX, y - centerY) <= radius ? "voice" : null;
    };
    let hovered: "voice" | "thread" | null = null;
    const onMove = (event: MouseEvent) => {
      const target = controlAt(event.clientX, event.clientY);
      apply(target !== null);
      if (dragRef.current !== null || target === hovered) return;
      hovered = target;
      setHintTarget(target);
    };
    const clearHover = () => {
      hovered = null;
      setHintTarget(null);
      if (dragRef.current === null) apply(false);
    };
    const onVisibility = () => {
      if (document.hidden) clearHover();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearHover();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", clearHover);
    window.addEventListener("blur", clearHover);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibility);
    apply(false);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", clearHover);
      window.removeEventListener("blur", clearHover);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibility);
      void setInteractive?.(true).catch(() => undefined);
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
    setHintTarget(null);
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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

  const handlePointerCancel = () => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    setHintTarget(null);
    void window.desktopBridge?.orchestratorBubble?.dragEnd().catch(() => undefined);
  };

  const handleOpenThread = (event: React.PointerEvent<HTMLButtonElement>) => {
    // Keep the press off the drag surface underneath, or opening the thread
    // would also arm a drag and toggle the microphone on release.
    event.stopPropagation();
    setHintTarget(null);
    void window.desktopBridge?.orchestratorBubble?.open().catch(() => undefined);
  };

  const tint = STATUS_TINTS[state.status];
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
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
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
      aria-label={
        listening || speaking || working
          ? "Stop talking to the orchestrator"
          : "Talk to the orchestrator"
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
        <GalacticOrb
          ref={orbRef}
          size={BUBBLE_BASE_DIAMETER}
          tint={tint}
          scale={scaleRef.current}
          intensity={glowRef.current}
          // The resting always-on-top renderer is still. A live voice session
          // gets the complete flowing-cloud, star and reflection animation.
          animated={state.status !== "idle" && state.status !== "error"}
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
        </GalacticOrb>

        <button
          type="button"
          data-testid="orchestrator-bubble-open-thread"
          ref={threadButtonRef}
          onPointerDown={handleOpenThread}
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
            border: "1px solid rgba(170,180,255,0.35)",
            background: "rgba(18,17,43,0.96)",
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
      {hintVisible && hintTarget !== null ? (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(50% + 48px)",
            left: "50%",
            transform: "translateX(-50%)",
            maxWidth: 244,
            padding: "5px 9px",
            border: "1px solid rgba(176,182,255,0.22)",
            borderRadius: 8,
            background: "rgba(15,14,34,0.96)",
            color: "#e7e5ff",
            fontSize: 11,
            lineHeight: "16px",
            textAlign: "center",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {hintTarget === "thread"
            ? "Open orchestrator thread"
            : listening || speaking || working
              ? "Click to stop · drag to move"
              : "Click to talk · drag to move"}
        </div>
      ) : null}
      <style>{`
        @keyframes orchestrator-bubble-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-testid="orchestrator-bubble"] svg { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

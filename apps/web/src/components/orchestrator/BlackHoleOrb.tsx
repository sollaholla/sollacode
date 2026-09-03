import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { cn } from "../../lib/utils";
import { createBlackHoleRenderer, hexToRgb } from "./blackHoleShader";

/** The canvas reaches this far past the horizon: room for the disk and the lensed stars. */
const CANVAS_SCALE = 2.4;
/** Backing-store cap: the bubble is 56px, the overlay 150px, the phone route up to 320px. */
const MAX_CANVAS_PIXELS = 1024;

/**
 * The voice orb: a black hole.
 *
 * Drawn by a WebGL shader that bends light around the horizon (see
 * `blackHoleShader.ts`): the accretion disk arches over the top of the hole,
 * a photon ring hugs the shadow, and the stars behind it streak and double as
 * the ray passes. A pure-CSS drawing of the same object (tilted gradient ring,
 * photon ring, horizon) sits underneath and is what shows when WebGL is not
 * available — and what a markup test sees. Nothing here uses `filter: blur()`:
 * WebKit clips a blurred layer to its square bounds inside a `backdrop-filter`
 * ancestor (the listening overlay has one), which turned an earlier halo into
 * a hard square on iOS.
 *
 * Who has the floor is the *colour* of the disk, never the shape: the same
 * five tints the orb has always used, so a glance still answers "who is
 * talking". Loudness is the caller's business — it scales the node exposed
 * through `ref` and sets `--orb-intensity` on it, which the halo reads.
 */
import type { VoiceSessionState } from "~/orchestrator/realtimeSession";

export type OrbTint = "connecting" | "assistant" | "user" | "waiting" | "idle" | "error";

interface OrbPalette {
  /** The hot inner edge of the disk. */
  readonly inner: string;
  /** The cooler outer sweep of the disk. */
  readonly outer: string;
  /** The halo behind everything, at full intensity. */
  readonly halo: string;
  /** Overall brightness of the disk; idle is deliberately the dimmest. */
  readonly brightness: number;
}

/**
 * One colour per speaker. The gold is the app's accent; the assistant keeps
 * the violet family it has always had so the two voices never share a hue.
 */
export const ORB_PALETTES: Record<OrbTint, OrbPalette> = {
  user: { inner: "#fff1c2", outer: "#d9a93a", halo: "rgba(217, 169, 58, 0.55)", brightness: 1 },
  assistant: {
    inner: "#e9dcff",
    outer: "#8b5cf6",
    halo: "rgba(139, 92, 246, 0.55)",
    brightness: 1,
  },
  waiting: {
    inner: "#dff6ff",
    outer: "#0ea5e9",
    halo: "rgba(14, 165, 233, 0.45)",
    brightness: 0.85,
  },
  connecting: {
    inner: "#e2e8f0",
    outer: "#64748b",
    halo: "rgba(100, 116, 139, 0.35)",
    brightness: 0.7,
  },
  idle: { inner: "#f5d77a", outer: "#8c6718", halo: "rgba(217, 169, 58, 0.22)", brightness: 0.55 },
  error: { inner: "#fecaca", outer: "#ef4444", halo: "rgba(239, 68, 68, 0.5)", brightness: 0.9 },
};

export function BlackHoleOrb({
  size,
  tint,
  spinning = true,
  breathing = false,
  intensity = 0,
  scale = 1,
  className,
  style,
  ref,
  children,
}: {
  /** Diameter of the horizon in pixels; the disk and halo extend past it. */
  readonly size: number;
  readonly tint: OrbTint;
  /** Whether the disk rotates. Off at rest on the desktop, where a spinning bubble in the corner of the screen is a distraction. */
  readonly spinning?: boolean;
  /** Slow pulse of the halo, for "something is happening" states. */
  readonly breathing?: boolean;
  /** 0..1 loudness driving the halo when the caller is not animating it itself. */
  readonly intensity?: number;
  readonly scale?: number;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  /** The scaling node, for callers that drive loudness per frame. */
  readonly ref?: Ref<HTMLDivElement>;
  /** Drawn over the horizon: the microphone, the audio lines, the spinner. */
  readonly children?: ReactNode;
}) {
  const palette = ORB_PALETTES[tint];
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [gl, setGl] = useState(false);
  useImperativeHandle(ref, () => nodeRef.current as HTMLDivElement, []);

  // Read every frame by the loop below without restarting it.
  const frameRef = useRef({ tint, spinning, intensity });
  frameRef.current = { tint, spinning, intensity };

  useEffect(() => {
    const canvas = canvasRef.current;
    const node = nodeRef.current;
    if (canvas === null || node === null) return;
    const renderer = createBlackHoleRenderer(canvas);
    if (renderer === null) return;
    setGl(true);

    const seed = Math.floor(Math.random() * 1000) / 7;
    const started = performance.now();
    let frame: number | null = null;
    let lastSize = 0;
    let lastDraw = 0;
    // Resting animation is deliberately cheap. This shader is expensive per
    // pixel and the orb can be 1024px square, so an idle loop at full rate and
    // full resolution pins the GPU process and WindowServer for a galaxy that
    // turns once a minute. The turn is slow enough that a low frame rate reads
    // identically, and the picture is soft enough that a smaller buffer
    // upscaled does too — so idle frames are both rarer and smaller.
    const IDLE_FRAME_MS = 1000 / 12;
    const IDLE_MAX_CANVAS_PIXELS = 448;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Nothing is worth drawing for an orb that is scrolled out of view or in a
    // hidden window. The bubble sets backgroundThrottling:false, so without
    // this it would keep painting behind other apps forever.
    let onScreen = true;
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const shouldAnimate = () =>
      onScreen && !document.hidden && (frameRef.current.spinning || !reduceMotion.matches);
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(draw);
    };

    const draw = () => {
      frame = null;
      const {
        tint: currentTint,
        spinning: currentSpinning,
        intensity: baseIntensity,
      } = frameRef.current;
      const nowMs = performance.now();
      if (!currentSpinning && nowMs - lastDraw < IDLE_FRAME_MS) {
        if (shouldAnimate()) schedule();
        return;
      }
      lastDraw = nowMs;
      const p = ORB_PALETTES[currentTint];
      const box = Math.round(size * CANVAS_SCALE);
      // Never fewer than two backing pixels per CSS pixel: the ring and the
      // lensed stars are a pixel wide, and a zoomed-out or low-density screen
      // would otherwise upscale a soft render. Capped so a 3x phone does not
      // pay for a canvas nobody can see.
      const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 2), 3);
      // Full detail only while the voice is live; at rest the cheaper buffer.
      const cap = currentSpinning ? MAX_CANVAS_PIXELS : IDLE_MAX_CANVAS_PIXELS;
      const pixels = Math.min(cap, Math.round(box * dpr));
      if (pixels !== lastSize) {
        renderer.resize(pixels, pixels);
        lastSize = pixels;
      }
      // Callers driving loudness per frame set the variable inline; fall back
      // to the prop when they do not.
      const inline = Number.parseFloat(node.style.getPropertyValue("--orb-intensity"));
      const intensityNow = Number.isFinite(inline) ? inline : baseIntensity;
      renderer.render({
        time: (performance.now() - started) / 1000,
        inner: hexToRgb(p.inner),
        outer: hexToRgb(p.outer),
        brightness: p.brightness,
        intensity: intensityNow,
        seed,
      });
      // The far universe turns and its stars twinkle whether or not the voice
      // is live, so the loop keeps running at rest rather than painting one
      // frame and stopping. Reduced motion still gets a single still frame.
      if (shouldAnimate()) schedule();
    };
    // The first frame is drawn now rather than on the next animation frame:
    // a background tab never gets one, and the orb should still be there
    // when the tab comes forward.
    draw();

    const observer = new IntersectionObserver(
      (entries) => {
        const next = entries.some((entry) => entry.isIntersecting);
        if (next === onScreen) return;
        onScreen = next;
        if (onScreen) {
          if (shouldAnimate()) schedule();
        } else {
          stop();
        }
      },
      { threshold: 0 },
    );
    observer.observe(node);

    const onVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      if (shouldAnimate()) schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onLost = (event: Event) => {
      event.preventDefault();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      setGl(false);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      stop();
      renderer.destroy();
    };
    // `spinning` and `tint` are read through the ref; they are listed so a
    // stopped loop restarts when the orb starts moving again.
  }, [size, spinning, tint]);

  const vars = {
    "--orb-size": `${size}px`,
    "--orb-inner": palette.inner,
    "--orb-outer": palette.outer,
    "--orb-halo": palette.halo,
    "--orb-brightness": palette.brightness,
    "--orb-intensity": intensity,
    "--orb-spin": spinning ? "running" : "paused",
    ...style,
  } as CSSProperties;

  return (
    <div
      ref={nodeRef}
      data-orb-tint={tint}
      data-orb-renderer={gl ? "webgl" : "css"}
      className={cn(
        "black-hole-orb",
        breathing && "black-hole-orb--breathing",
        gl && "black-hole-orb--gl",
        className,
      )}
      style={{ ...vars, transform: scale === 1 ? undefined : `scale(${scale.toFixed(3)})` }}
    >
      <BlackHoleOrbStyles />
      <div className="black-hole-orb__halo" aria-hidden />
      <canvas
        ref={canvasRef}
        className="black-hole-orb__canvas"
        aria-hidden
        style={{ inset: `${-((CANVAS_SCALE - 1) / 2) * 100}%` }}
      />
      <div className="black-hole-orb__stars" aria-hidden />
      <div className="black-hole-orb__disk black-hole-orb__disk--back" aria-hidden>
        <div className="black-hole-orb__ring" />
      </div>
      <div className="black-hole-orb__horizon" aria-hidden />
      <div className="black-hole-orb__photon" aria-hidden />
      <div className="black-hole-orb__disk black-hole-orb__disk--front" aria-hidden>
        <div className="black-hole-orb__ring" />
      </div>
      <div className="black-hole-orb__glyph">{children}</div>
    </div>
  );
}

/**
 * The orb's own stylesheet, inline so it travels with the component: it is
 * rendered in the floating bubble window, which loads no app stylesheet at
 * all beyond what its entry imports, and in the listening overlay, which is
 * not always mounted. Repeating it per orb is harmless; there is never more
 * than a couple on screen.
 */
function BlackHoleOrbStyles() {
  return (
    <style>{`
      .black-hole-orb {
        position: relative;
        width: var(--orb-size);
        height: var(--orb-size);
        flex: none;
        display: flex;
        align-items: center;
        justify-content: center;
        will-change: transform;
        perspective: calc(var(--orb-size) * 3);
        transform-style: preserve-3d;
      }
      /* Every layer is decoration: the halo and canvas spill past the orb, and
         nothing behind them should lose its clicks. The wrapping button (or
         nothing) is what receives pointer events. */
      .black-hole-orb > * { position: absolute; inset: 0; pointer-events: none; }
      /* A replaced element does not stretch to its insets, so the canvas is
         sized explicitly: CANVAS_SCALE times the orb, centred on it. */
      .black-hole-orb__canvas {
        width: calc(var(--orb-size) * 2.4);
        height: calc(var(--orb-size) * 2.4);
        display: none;
        pointer-events: none;
      }
      .black-hole-orb--gl .black-hole-orb__canvas { display: block; }
      .black-hole-orb--gl .black-hole-orb__stars,
      .black-hole-orb--gl .black-hole-orb__disk,
      .black-hole-orb--gl .black-hole-orb__horizon,
      .black-hole-orb--gl .black-hole-orb__photon { display: none; }
      /* Outer glow: the tint close in, cooling to a faint blue at the rim so the
         dark around the orb reads as space rather than as a flat backdrop. */
      .black-hole-orb__halo {
        inset: -70%;
        border-radius: 50%;
        background:
          radial-gradient(closest-side, var(--orb-halo) 0%, transparent 62%),
          radial-gradient(closest-side, transparent 55%, rgba(90, 120, 255, 0.10) 72%, transparent 88%);
        opacity: calc(0.45 + var(--orb-intensity) * 0.55);
        transition: opacity 160ms linear;
      }
      .black-hole-orb--breathing .black-hole-orb__halo {
        animation: black-hole-orb-breathe 2.2s ease-in-out infinite;
      }
      .black-hole-orb__stars {
        inset: -60%;
        border-radius: 50%;
        opacity: 0.7;
        background-image:
          radial-gradient(1.4px 1.4px at 18% 32%, #fff 55%, transparent 60%),
          radial-gradient(1px 1px at 72% 18%, #fff 55%, transparent 60%),
          radial-gradient(1.6px 1.6px at 86% 64%, #ffe9b0 55%, transparent 60%),
          radial-gradient(1px 1px at 34% 82%, #fff 55%, transparent 60%),
          radial-gradient(1.2px 1.2px at 58% 92%, #fff 55%, transparent 60%),
          radial-gradient(1.4px 1.4px at 8% 60%, #dbe7ff 55%, transparent 60%),
          radial-gradient(1px 1px at 50% 6%, #fff 55%, transparent 60%),
          radial-gradient(1px 1px at 92% 40%, #fff 55%, transparent 60%),
          radial-gradient(1.2px 1.2px at 26% 12%, #ffd9a0 55%, transparent 60%),
          radial-gradient(1px 1px at 64% 74%, #dbe7ff 55%, transparent 60%),
          radial-gradient(1px 1px at 12% 88%, #fff 55%, transparent 60%),
          radial-gradient(1.2px 1.2px at 80% 88%, #fff 55%, transparent 60%);
        animation: black-hole-orb-drift 120s linear infinite;
        animation-play-state: var(--orb-spin);
      }
      /* The accretion disk, tilted toward the viewer. Two copies: the back one
         paints only its far half and sits under the horizon, the front one only
         its near half and sits over it. Each pixel of the ring is painted once,
         so there is no seam where the halves meet at the horizon's sides. */
      .black-hole-orb__disk {
        inset: -42%;
        transform: rotateX(70deg) rotateZ(-16deg);
        transform-style: preserve-3d;
      }
      .black-hole-orb__disk--back { clip-path: inset(0 0 50% 0); }
      .black-hole-orb__disk--front { clip-path: inset(50% 0 0 0); }
      .black-hole-orb__ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        opacity: var(--orb-brightness);
        background:
          /* A hot, thin inner band right at the horizon, brightest on one side
             (relativistic beaming: the side spinning toward the viewer). */
          radial-gradient(circle closest-side, transparent 55%, rgba(255, 250, 235, 0.95) 57%, var(--orb-inner) 60%, transparent 64%),
          conic-gradient(
            from 0deg,
            transparent 0deg,
            var(--orb-outer) 25deg,
            var(--orb-inner) 70deg,
            #fffaf0 92deg,
            var(--orb-inner) 118deg,
            var(--orb-outer) 170deg,
            transparent 215deg,
            transparent 235deg,
            var(--orb-outer) 270deg,
            var(--orb-inner) 300deg,
            var(--orb-outer) 335deg,
            transparent 360deg
          );
        -webkit-mask: radial-gradient(circle closest-side, transparent 54%, #000 58%, #000 76%, rgba(0,0,0,0.5) 86%, transparent 97%);
        mask: radial-gradient(circle closest-side, transparent 54%, #000 58%, #000 76%, rgba(0,0,0,0.5) 86%, transparent 97%);
        animation: black-hole-orb-spin 6.5s linear infinite;
        animation-play-state: var(--orb-spin);
      }
      /* Softer, wider second sweep behind the bright band: the disk's outer
         haze, spinning slower so the two read as one body with depth. */
      .black-hole-orb__ring::after {
        content: "";
        position: absolute;
        inset: -6%;
        border-radius: 50%;
        opacity: 0.55;
        background: conic-gradient(
          from 140deg,
          transparent 0deg,
          var(--orb-outer) 60deg,
          transparent 140deg,
          var(--orb-outer) 230deg,
          transparent 320deg
        );
        -webkit-mask: radial-gradient(circle closest-side, transparent 66%, #000 74%, transparent 100%);
        mask: radial-gradient(circle closest-side, transparent 66%, #000 74%, transparent 100%);
        animation: black-hole-orb-spin 15s linear infinite reverse;
        animation-play-state: var(--orb-spin);
      }
      .black-hole-orb__horizon {
        border-radius: 50%;
        background: radial-gradient(circle at 50% 50%, #000 0%, #000 60%, #050505 82%, #14110b 100%);
        box-shadow:
          inset 0 0 calc(var(--orb-size) * 0.1) rgba(0, 0, 0, 0.95),
          0 0 calc(var(--orb-size) * 0.06) rgba(0, 0, 0, 0.8);
      }
      /* The photon ring: light bent all the way round, a hair outside the
         horizon. Drawn as a bordered ring with the border masked in. */
      .black-hole-orb__photon {
        inset: -2.5%;
        border-radius: 50%;
        border: calc(var(--orb-size) * 0.022) solid transparent;
        background:
          conic-gradient(from 200deg, var(--orb-inner), var(--orb-outer) 35%, #fff9e6 55%, var(--orb-outer) 75%, var(--orb-inner)) border-box;
        -webkit-mask:
          linear-gradient(#000 0 0) padding-box,
          linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask:
          linear-gradient(#000 0 0) padding-box,
          linear-gradient(#000 0 0);
        mask-composite: exclude;
        opacity: calc(0.65 + var(--orb-brightness) * 0.35);
        filter: drop-shadow(0 0 calc(var(--orb-size) * 0.03) var(--orb-outer));
        animation: black-hole-orb-spin 11s linear infinite reverse;
        animation-play-state: var(--orb-spin);
      }
      .black-hole-orb__glyph {
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        filter: drop-shadow(0 1px 6px rgba(0, 0, 0, 0.6));
      }
      @keyframes black-hole-orb-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      @keyframes black-hole-orb-drift {
        from { transform: rotate(0deg); }
        to { transform: rotate(-360deg); }
      }
      @keyframes black-hole-orb-breathe {
        0%, 100% { opacity: 0.4; transform: scale(0.96); }
        50% { opacity: 0.9; transform: scale(1.06); }
      }
      @media (prefers-reduced-motion: reduce) {
        .black-hole-orb__ring, .black-hole-orb__ring::after, .black-hole-orb__stars, .black-hole-orb__photon, .black-hole-orb__halo {
          animation: none !important;
        }
      }
    `}</style>
  );
}

/**
 * The tint an orb wears for a voice session: dim gold at rest, slate while
 * connecting, sky while the orchestrator is working, violet while it speaks,
 * gold while it listens to you, red once the session has failed.
 */
export function resolveVoiceOrbTint(
  state: VoiceSessionState,
  working: boolean,
  live: boolean,
): OrbTint {
  if (!live) return state === "error" ? "error" : "idle";
  if (state === "connecting") return "connecting";
  if (working) return "waiting";
  if (state === "speaking") return "assistant";
  return "user";
}

import { type CSSProperties, type ReactNode, type Ref, useEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { ORCHESTRATOR_ORB } from "@t3tools/client-runtime/state/agent-appearance";
import type { VoiceSessionState } from "~/orchestrator/realtimeSession";
import { orbClipUrl, orbLayerUrl } from "../agents/agentOrbAssets";
import "./galactic-orb.css";

export type OrbTint = "connecting" | "assistant" | "user" | "waiting" | "idle" | "error";

/** The orb is always black and gold; what it is doing shows in the light around it. */
const HALOS: Record<OrbTint, string> = {
  idle: "#b9770f",
  assistant: "#ffc83a",
  user: "#ffe9a0",
  waiting: "#e8962a",
  connecting: "#8d6a34",
  error: "#fb4a6d",
};

/** How much faster the galaxy turns while a session is busy. */
const BUSY_RATE = 1.9;

/**
 * The orchestrator: black glass and gold, a burning eye in a sphere. At rest it
 * is stacked stills and costs nothing; while `animated`, a pre-rendered clip of
 * the galaxy turning in 3D plays between them and the glass.
 */
export function GalacticOrb({
  size,
  tint,
  spinning = false,
  animated = true,
  breathing = false,
  intensity = 0,
  scale = 1,
  className,
  style,
  ref,
  children,
}: {
  /** Sphere diameter. The corona and halo extend only 12% beyond each edge. */
  readonly size: number;
  readonly tint: OrbTint;
  readonly spinning?: boolean;
  /** Pause every decorative layer, for previews and reduced motion. */
  readonly animated?: boolean;
  readonly breathing?: boolean;
  readonly intensity?: number;
  readonly scale?: number;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly ref?: Ref<HTMLDivElement>;
  readonly children?: ReactNode;
}) {
  const clipRef = useRef<HTMLVideoElement>(null);
  const moving = spinning || breathing;
  const vars = {
    "--orb-size": `${size}px`,
    "--orb-edge": HALOS[tint],
    "--orb-intensity": intensity,
    transform: `scale(${scale})`,
    ...style,
  } as CSSProperties;

  useEffect(() => {
    const clip = clipRef.current;
    if (!clip) return;
    clip.playbackRate = moving ? BUSY_RATE : 1;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    void clip.play().catch(() => undefined);
    return () => clip.pause();
  }, [animated, moving]);

  return (
    <div
      ref={ref}
      className={cn("galactic-orb", className)}
      style={vars}
      data-orb-tint={tint}
      data-orb-animated={animated || undefined}
      data-orb-moving={moving || undefined}
    >
      <div className="galactic-orb__halo" aria-hidden />
      <img
        className="galactic-orb__corona"
        src={orbLayerUrl(ORCHESTRATOR_ORB, "corona")}
        alt=""
        draggable={false}
      />
      <div className="galactic-orb__sphere" aria-hidden>
        <img src={orbLayerUrl(ORCHESTRATOR_ORB, "deep")} alt="" draggable={false} />
        <img src={orbLayerUrl(ORCHESTRATOR_ORB, "dust")} alt="" draggable={false} />
        {animated ? (
          <video ref={clipRef} src={orbClipUrl(ORCHESTRATOR_ORB)} muted loop playsInline />
        ) : null}
        <img src={orbLayerUrl(ORCHESTRATOR_ORB, "glass")} alt="" draggable={false} />
      </div>
      <div className="galactic-orb__glyph">{children}</div>
    </div>
  );
}

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

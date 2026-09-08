import { type CSSProperties, type ReactNode, type Ref, useId } from "react";

import { cn } from "../../lib/utils";
import type { VoiceSessionState } from "~/orchestrator/realtimeSession";
import "./galactic-orb.css";

export type OrbTint = "connecting" | "assistant" | "user" | "waiting" | "idle" | "error";

const PALETTES: Record<OrbTint, { core: string; edge: string; light: string }> = {
  idle: { core: "#9954f6", edge: "#395bea", light: "#87ecff" },
  assistant: { core: "#c46bff", edge: "#6c42ec", light: "#bdeaff" },
  user: { core: "#e7ae53", edge: "#8760e6", light: "#fff1c3" },
  waiting: { core: "#4fc9ef", edge: "#5453dc", light: "#c0f6ff" },
  connecting: { core: "#8c91e8", edge: "#4c6bad", light: "#dce9ff" },
  error: { core: "#fb698d", edge: "#983783", light: "#ffe0dc" },
};

// Fixed positions keep the same constellation across renders and every client.
const STARS = Array.from({ length: 64 }, (_, index) => {
  const angle = index * 2.399963;
  const radius = 69 * Math.sqrt((index + 0.5) / 64);
  return {
    x: 80 + Math.cos(angle) * radius,
    y: 80 + Math.sin(angle) * radius,
    radius: index % 11 === 0 ? 0.95 : index % 3 === 0 ? 0.6 : 0.35,
    opacity: 0.35 + (index % 5) * 0.14,
  };
});

/** Independently drifting nebula, starlight and reflections, contained under glass. */
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
  /** Sphere diameter. The soft halo extends only 12% beyond each edge. */
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
  const id = useId();
  const palette = PALETTES[tint];
  const url = (name: string) => `url(#${id}-${name})`;
  const vars = {
    "--orb-size": `${size}px`,
    "--orb-core": palette.core,
    "--orb-edge": palette.edge,
    "--orb-light": palette.light,
    "--orb-intensity": intensity,
    transform: `scale(${scale})`,
    ...style,
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className={cn("galactic-orb", className)}
      style={vars}
      data-orb-tint={tint}
      data-orb-animated={animated || undefined}
      data-orb-moving={spinning || breathing || undefined}
    >
      <div className="galactic-orb__halo" aria-hidden />
      <div className="galactic-orb__sphere" aria-hidden>
        <svg className="galactic-orb__cosmos" viewBox="0 0 160 160" fill="none">
          <defs>
            <radialGradient id={`${id}-cloud`}>
              <stop stopColor={palette.core} stopOpacity="0.94" />
              <stop offset="0.45" stopColor={palette.core} stopOpacity="0.42" />
              <stop offset="1" stopColor={palette.core} stopOpacity="0" />
            </radialGradient>
            <radialGradient id={`${id}-blue`}>
              <stop stopColor={palette.light} stopOpacity="0.85" />
              <stop offset="0.3" stopColor={palette.edge} stopOpacity="0.85" />
              <stop offset="1" stopColor={palette.edge} stopOpacity="0" />
            </radialGradient>
            <linearGradient
              id={`${id}-stream`}
              x1="25"
              y1="126"
              x2="137"
              y2="23"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor={palette.light} stopOpacity="0" />
              <stop offset="0.23" stopColor={palette.light} stopOpacity="0.86" />
              <stop offset="0.46" stopColor={palette.core} stopOpacity="0.5" />
              <stop offset="0.72" stopColor="#e9bcff" stopOpacity="0.94" />
              <stop offset="1" stopColor={palette.core} stopOpacity="0" />
            </linearGradient>
            <filter id={`${id}-mist`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
            <filter id={`${id}-dust`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="1.1" />
            </filter>
          </defs>
          <ellipse
            cx="99"
            cy="54"
            rx="53"
            ry="38"
            transform="rotate(-38 99 54)"
            fill={url("cloud")}
          />
          <ellipse
            cx="53"
            cy="105"
            rx="51"
            ry="34"
            transform="rotate(-38 53 105)"
            fill={url("blue")}
          />
          <ellipse cx="111" cy="105" rx="43" ry="48" fill={url("cloud")} opacity="0.46" />
          <g transform="rotate(-18 80 80)">
            <path
              d="M9 116C31 137 76 102 67 76S84 19 146 41C108 3 57 43 82 76S57 119 21 106"
              stroke={url("stream")}
              strokeWidth="15"
              filter={url("mist")}
            />
            <path
              d="M12 116C42 132 80 104 67 76S82 21 147 41"
              stroke={url("stream")}
              strokeWidth="2.8"
              filter={url("dust")}
            />
            <path
              d="M21 123C63 130 86 101 74 77S90 28 137 35"
              stroke={url("stream")}
              strokeWidth="0.8"
              opacity="0.8"
            />
            <path
              d="M26 109C51 113 67 97 61 81S61 40 103 32"
              stroke={url("stream")}
              strokeWidth="0.7"
              opacity="0.5"
            />
          </g>
        </svg>
        <div className="galactic-orb__aurora" />
        <div className="galactic-orb__wisp" />
        {[0, 1].map((layer) => (
          <svg
            key={layer}
            className={`galactic-orb__stars galactic-orb__stars--${layer}`}
            viewBox="0 0 160 160"
            fill="none"
          >
            {STARS.filter((_, index) => index % 2 === layer).map((star, index) => (
              <circle
                key={star.x}
                cx={star.x}
                cy={star.y}
                r={star.radius}
                fill={index % 4 === 0 ? palette.light : "#fff5ff"}
                opacity={star.opacity}
              />
            ))}
            {layer === 0 ? (
              <path
                fill="#effcff"
                d="m111 38 1.1 5.1 5.1 1.1-5.1 1.1-1.1 5.1-1.1-5.1-5.1-1.1 5.1-1.1Z"
              />
            ) : (
              <path
                fill="#effcff"
                d="m43 102 .7 3.4 3.4.7-3.4.7-.7 3.4-.7-3.4-3.4-.7 3.4-.7Z"
                opacity="0.8"
              />
            )}
          </svg>
        ))}
        <div className="galactic-orb__reflection" />
        <div className="galactic-orb__glass" />
        <div className="galactic-orb__rim" />
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

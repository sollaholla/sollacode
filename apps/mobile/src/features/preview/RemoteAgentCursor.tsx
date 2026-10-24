import {
  planAgentCursorGlide,
  type AgentCursorPoint,
} from "@t3tools/client-runtime/preview/agent-cursor-motion";
import type { PreviewAgentPointer } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";

const CURSOR_ACTIVE_MS = 700;
const CURSOR_SIZE = 22;
const CLICK_RING_SIZE = 18;
/** Points sampled along a glide; the UI thread interpolates between them. */
const GLIDE_SAMPLES = 24;
export const AGENT_CURSOR_BLUE = "#3b82f6";

interface ActiveGlide {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly at: (t: number) => AgentCursorPoint;
}

/**
 * The agent's cursor over the host browser frame. The frame image fills its
 * box exactly (full width at the frame's aspect ratio), so the pointer's page
 * fractions are plain box fractions. Drawn like the desktop cursor: bright
 * for a moment after each new point, dimmed while it rests, and gliding from
 * where it is drawn to each new point (client-runtime `agent-cursor-motion`).
 */
export function RemoteAgentCursor(props: { readonly pointer: PreviewAgentPointer | undefined }) {
  if (!props.pointer) return null;
  return <RemoteAgentCursorPoint pointer={props.pointer} />;
}

function RemoteAgentCursorPoint(props: { readonly pointer: PreviewAgentPointer }) {
  const { pointer } = props;
  const [box, setBox] = useState<{ readonly width: number; readonly height: number } | null>(null);
  const [restingSequence, setRestingSequence] = useState<number | null>(null);
  useEffect(() => {
    const timeout = setTimeout(() => setRestingSequence(pointer.sequence), CURSOR_ACTIVE_MS);
    return () => clearTimeout(timeout);
  }, [pointer.sequence]);
  const active = restingSequence !== pointer.sequence;

  const reduceMotion = useReducedMotion();
  /** Flattened x,y pairs along the current glide, or the one resting point. */
  const samples = useSharedValue<number[]>([]);
  const progress = useSharedValue(1);
  const glideRef = useRef<ActiveGlide | null>(null);
  const restingRef = useRef<AgentCursorPoint | null>(null);
  const sequenceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!box || box.width <= 0 || box.height <= 0) return;
    const to = { x: pointer.x * box.width, y: pointer.y * box.height };
    const now = Date.now();
    const glide = glideRef.current;
    const gliding = glide !== null && now - glide.startedAt < glide.durationMs;
    const from = gliding
      ? glide.at((now - glide.startedAt) / glide.durationMs)
      : restingRef.current;
    // The same pointer re-measured (the box resized) moves at once: the page
    // moved under the cursor rather than the cursor across the page.
    const newPoint = sequenceRef.current !== pointer.sequence;
    sequenceRef.current = pointer.sequence;
    restingRef.current = to;
    const next =
      from !== null && newPoint && !reduceMotion
        ? planAgentCursorGlide(from, to, { moving: gliding })
        : null;
    if (!next) {
      glideRef.current = null;
      samples.value = [to.x, to.y];
      progress.value = 1;
      return;
    }
    const points: number[] = [];
    for (let index = 0; index <= GLIDE_SAMPLES; index += 1) {
      const point = next.at(index / GLIDE_SAMPLES);
      points.push(point.x, point.y);
    }
    glideRef.current = { startedAt: now, durationMs: next.durationMs, at: next.at };
    samples.value = points;
    progress.value = 0;
    progress.value = withTiming(1, { duration: next.durationMs, easing: Easing.linear });
  }, [box, pointer.sequence, pointer.x, pointer.y, reduceMotion, samples, progress]);

  const position = useAnimatedStyle(() => {
    const points = samples.value;
    const count = points.length / 2;
    // Off the frame until the box is measured, rather than flashing at its corner.
    if (count < 1) return { transform: [{ translateX: -CURSOR_SIZE * 4 }, { translateY: 0 }] };
    const at = (offset: number) => points[offset] ?? 0;
    if (count === 1) return { transform: [{ translateX: at(0) }, { translateY: at(1) }] };
    const along = Math.min(Math.max(progress.value, 0), 1) * (count - 1);
    const index = Math.min(Math.floor(along), count - 2);
    const fraction = along - index;
    const x = at(index * 2) + (at(index * 2 + 2) - at(index * 2)) * fraction;
    const y = at(index * 2 + 1) + (at(index * 2 + 3) - at(index * 2 + 1)) * fraction;
    return { transform: [{ translateX: x }, { translateY: y }] };
  });

  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setBox((current) =>
          current?.width === width && current.height === height ? current : { width, height },
        );
      }}
    >
      <Animated.View
        style={[{ position: "absolute", left: 0, top: 0, opacity: active ? 1 : 0.35 }, position]}
      >
        {pointer.phase === "click" && active ? (
          <View
            style={{
              position: "absolute",
              left: -CLICK_RING_SIZE / 2,
              top: -CLICK_RING_SIZE / 2,
              width: CLICK_RING_SIZE,
              height: CLICK_RING_SIZE,
              borderRadius: CLICK_RING_SIZE / 2,
              backgroundColor: `${AGENT_CURSOR_BLUE}59`,
            }}
          />
        ) : null}
        <AgentCursorGlyph size={CURSOR_SIZE} style={{ marginLeft: -3, marginTop: -3 }} />
      </Animated.View>
    </View>
  );
}

/** The desktop agent cursor's arrow (see the web `AgentCursorArrow`). */
export function AgentCursorGlyph(props: {
  readonly size: number;
  readonly style?: { readonly marginLeft?: number; readonly marginTop?: number };
}) {
  return (
    <Svg width={props.size} height={props.size} viewBox="0 0 24 24" style={props.style}>
      <Defs>
        <LinearGradient id="agent-cursor-fill" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0%" stopColor="#8ec9ff" />
          <Stop offset="55%" stopColor={AGENT_CURSOR_BLUE} />
          <Stop offset="100%" stopColor="#1d4ed8" />
        </LinearGradient>
      </Defs>
      <Path
        d="m4 4 7.07 17 2.51-7.39L21 11.07z"
        fill="url(#agent-cursor-fill)"
        stroke="#bfdcff"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}

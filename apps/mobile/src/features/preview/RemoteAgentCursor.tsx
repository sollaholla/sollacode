import type { PreviewAgentPointer } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";

const CURSOR_ACTIVE_MS = 700;
const CURSOR_SIZE = 22;
const CLICK_RING_SIZE = 18;
export const AGENT_CURSOR_BLUE = "#3b82f6";

/**
 * The agent's cursor over the host browser frame. The frame image fills its
 * box exactly (full width at the frame's aspect ratio), so the pointer's page
 * fractions are plain box percentages. Drawn like the desktop cursor: bright
 * for a moment after each new point, dimmed while it rests.
 */
export function RemoteAgentCursor(props: { readonly pointer: PreviewAgentPointer | undefined }) {
  if (!props.pointer) return null;
  return <RemoteAgentCursorPoint key={props.pointer.sequence} pointer={props.pointer} />;
}

function RemoteAgentCursorPoint(props: { readonly pointer: PreviewAgentPointer }) {
  const [active, setActive] = useState(true);
  useEffect(() => {
    const timeout = setTimeout(() => setActive(false), CURSOR_ACTIVE_MS);
    return () => clearTimeout(timeout);
  }, []);
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: `${props.pointer.x * 100}%`,
        top: `${props.pointer.y * 100}%`,
        opacity: active ? 1 : 0.35,
      }}
    >
      {props.pointer.phase === "click" && active ? (
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

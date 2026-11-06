import {
  agentMoodBadgeSvg,
  agentOrb,
  type AgentAvatarMood,
} from "@t3tools/client-runtime/state/agent-appearance";
import {
  scheduleAgentAvatarMotion,
  type AgentAvatarGesture,
} from "@t3tools/client-runtime/state/agent-avatar-motion";
import { memo, useEffect, useMemo, useRef } from "react";
import { AccessibilityInfo, Animated, AppState, Easing, Image, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { AGENT_ORB_IMAGES } from "./agentOrbImages";

/** Rotation in degrees, tracked here so the next turn starts where this one ended. */
function turnBy(value: Animated.Value, angle: { current: number }, by: number, duration: number) {
  angle.current += by;
  Animated.timing(value, {
    toValue: angle.current,
    duration,
    easing: Easing.inOut(Easing.ease),
    useNativeDriver: true,
  }).start();
}

const spin = (value: Animated.Value) => ({
  transform: [
    {
      rotate: value.interpolate({
        inputRange: [0, 360],
        outputRange: ["0deg", "360deg"],
        extrapolate: "extend",
      }),
    },
  ],
});

/** Same orb as desktop; the containing row owns its accessible name. */
export const AgentAvatar = memo(function AgentAvatar(props: {
  readonly agentId: string;
  readonly online: boolean;
  readonly avatarColor?: number | null | undefined;
  /** What the agent is doing; offline agents sleep whatever this says. */
  readonly mood?: AgentAvatarMood | undefined;
  readonly size: number;
}) {
  const mood = props.mood ?? "idle";
  const deep = useRef(new Animated.Value(0)).current;
  const dust = useRef(new Animated.Value(0)).current;
  const swell = useRef(new Animated.Value(1)).current;
  const deepAngle = useRef(0);
  const dustAngle = useRef(0);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  useEffect(() => {
    if (!props.online) return;
    let active = AppState.currentState === "active";
    let reduced = true;
    let disposed = false;
    let cancel: (() => void) | undefined;
    const play = (gesture: AgentAvatarGesture) => {
      if (gesture.turn) {
        turnBy(deep, deepAngle, gesture.turn.deep, gesture.duration);
        turnBy(dust, dustAngle, gesture.turn.dust, gesture.duration);
      }
      if (gesture.root) {
        Animated.sequence([
          Animated.timing(swell, {
            toValue: 1.07,
            duration: gesture.duration * 0.4,
            useNativeDriver: true,
          }),
          Animated.timing(swell, {
            toValue: 1,
            duration: gesture.duration * 0.6,
            useNativeDriver: true,
          }),
        ]).start();
      }
    };
    const rest = () => {
      deep.stopAnimation();
      dust.stopAnimation();
      swell.stopAnimation();
      swell.setValue(1);
    };
    const update = () => {
      if (disposed) return;
      if (!active || reduced) {
        cancel?.();
        cancel = undefined;
        return;
      }
      cancel ??= scheduleAgentAvatarMotion(
        props.agentId,
        { rest, play },
        { avatarColor: props.avatarColor, mood: () => moodRef.current },
      );
    };
    const stateSubscription = AppState.addEventListener("change", (state) => {
      active = state === "active";
      update();
    });
    const motionSubscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (value) => {
        reduced = value;
        update();
      },
    );
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        reduced = value;
        update();
      },
      () => {},
    );
    return () => {
      disposed = true;
      stateSubscription.remove();
      motionSubscription.remove();
      cancel?.();
      rest();
    };
  }, [props.agentId, props.avatarColor, props.online, deep, dust, swell]);

  const layers = AGENT_ORB_IMAGES[agentOrb(props.agentId, props.avatarColor).name];
  const badge = useMemo(() => agentMoodBadgeSvg(mood, props.online), [mood, props.online]);
  const fill = { position: "absolute", width: props.size, height: props.size } as const;
  return (
    <Animated.View
      style={{
        width: props.size,
        height: props.size,
        flexShrink: 0,
        transform: [{ scale: swell }],
      }}
    >
      <View style={[fill, props.online ? null : { opacity: 0.5 }]}>
        <Animated.Image source={layers.deep} style={[fill, spin(deep)]} accessible={false} />
        <Animated.Image source={layers.dust} style={[fill, spin(dust)]} accessible={false} />
      </View>
      <Image source={layers.glass} style={fill} accessible={false} />
      {badge ? (
        <View style={fill}>
          <SvgXml xml={badge} width={props.size} height={props.size} accessible={false} />
        </View>
      ) : null}
    </Animated.View>
  );
});

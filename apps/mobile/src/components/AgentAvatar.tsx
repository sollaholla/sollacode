import {
  agentAvatarSvg,
  type AgentAvatarMood,
} from "@t3tools/client-runtime/state/agent-appearance";
import {
  agentAvatarMotion,
  scheduleAgentAvatarMotion,
} from "@t3tools/client-runtime/state/agent-avatar-motion";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, AppState, Easing } from "react-native";
import { SvgXml } from "react-native-svg";

/** Same static artwork as desktop; the containing row owns its accessible name. */
export const AgentAvatar = memo(function AgentAvatar(props: {
  readonly agentId: string;
  readonly online: boolean;
  readonly avatarColor?: number | null | undefined;
  /** What the agent is doing; offline agents sleep whatever this says. */
  readonly mood?: AgentAvatarMood | undefined;
  readonly size: number;
}) {
  const mood = props.mood ?? "idle";
  const progress = useRef(new Animated.Value(0)).current;
  const motion = useMemo(() => agentAvatarMotion(props.agentId), [props.agentId]);
  const [blinking, setBlinking] = useState(false);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  useEffect(() => {
    if (!props.online) return;
    let active = AppState.currentState === "active";
    let reduced = true;
    let disposed = false;
    let cancel: (() => void) | undefined;
    let blinkTimer: ReturnType<typeof setTimeout> | undefined;
    const rest = () => {
      if (blinkTimer !== undefined) clearTimeout(blinkTimer);
      setBlinking(false);
      progress.stopAnimation();
      progress.setValue(0);
    };
    const update = () => {
      if (disposed) return;
      if (!active || reduced) {
        cancel?.();
        cancel = undefined;
        return;
      }
      if (cancel) return;
      cancel = scheduleAgentAvatarMotion(
        props.agentId,
        {
          rest,
          play: (gesture) => {
            // One drawing here, so a blink swaps it and any other gesture moves it whole.
            if (gesture.root === undefined) {
              setBlinking(true);
              blinkTimer = setTimeout(() => setBlinking(false), gesture.duration);
              return;
            }
            rest();
            Animated.timing(progress, {
              toValue: 1,
              duration: motion.duration,
              easing: Easing.inOut(Easing.ease),
              useNativeDriver: true,
            }).start();
          },
        },
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
  }, [props.agentId, props.avatarColor, props.online, motion, progress]);
  const xml = useMemo(
    () =>
      agentAvatarSvg(
        props.agentId,
        props.online,
        props.avatarColor,
        props.online && blinking,
        mood,
      ),
    [props.agentId, props.online, props.avatarColor, blinking, mood],
  );
  return (
    <Animated.View
      style={{
        width: props.size,
        height: props.size,
        flexShrink: 0,
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 0.2, 0.4, 0.6, 0.8, 1],
              outputRange: [...motion.y],
            }),
          },
          {
            rotate: progress.interpolate({
              inputRange: [0, 0.2, 0.4, 0.6, 0.8, 1],
              outputRange: motion.rotate.map((value) => `${value}deg`),
            }),
          },
          {
            scaleX: progress.interpolate({
              inputRange: [0, 0.2, 0.4, 0.6, 0.8, 1],
              outputRange: motion.scaleX,
            }),
          },
          {
            scaleY: progress.interpolate({
              inputRange: [0, 0.2, 0.4, 0.6, 0.8, 1],
              outputRange: motion.scaleY,
            }),
          },
        ],
      }}
    >
      <SvgXml xml={xml} width={props.size} height={props.size} accessible={false} />
    </Animated.View>
  );
});

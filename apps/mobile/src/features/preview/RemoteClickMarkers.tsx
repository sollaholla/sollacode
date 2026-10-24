import type { RemoteClickMarker } from "@t3tools/client-runtime/preview/click-feedback";
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, View } from "react-native";
import { AGENT_CURSOR_BLUE } from "./RemoteAgentCursor";

function ClickMarker({ marker }: { readonly marker: RemoteClickMarker }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let disposed = false;
    let animation: Animated.CompositeAnimation | undefined;
    const update = (reduced: boolean) => {
      animation?.stop();
      opacity.setValue(1);
      if (disposed || reduced || marker.state === "failed") return;
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0.3,
            duration: 500,
            useNativeDriver: true,
            isInteraction: false,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
            isInteraction: false,
          }),
        ]),
      );
      animation.start();
    };
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", update);
    void AccessibilityInfo.isReduceMotionEnabled().then(update, () => {});
    return () => {
      disposed = true;
      animation?.stop();
      subscription.remove();
    };
  }, [marker.state, opacity]);
  const color = marker.state === "failed" ? "#f87171" : AGENT_CURSOR_BLUE;
  return (
    <View
      pointerEvents="none"
      accessibilityLabel={
        marker.state === "failed"
          ? "Click was not acknowledged"
          : "Click awaiting host acknowledgement"
      }
      style={{
        position: "absolute",
        left: `${marker.x * 100}%`,
        top: `${marker.y * 100}%`,
        width: 12,
        height: 12,
        marginLeft: -6,
        marginTop: -6,
      }}
    >
      <Animated.View
        style={{
          position: "absolute",
          width: 12,
          height: 12,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: color,
          opacity,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: 4,
          top: 4,
          width: 4,
          height: 4,
          borderRadius: 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

export function RemoteClickMarkers({
  markers,
}: {
  readonly markers: readonly RemoteClickMarker[];
}) {
  return markers.map((marker) => <ClickMarker key={marker.id} marker={marker} />);
}

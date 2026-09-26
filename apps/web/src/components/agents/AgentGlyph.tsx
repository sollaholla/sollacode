import { agentAvatarSvg } from "@t3tools/client-runtime/state/agent-appearance";
import {
  agentAvatarMotion,
  scheduleAgentAvatarMotion,
} from "@t3tools/client-runtime/state/agent-avatar-motion";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";

/** Decorative identity; the adjacent agent name and presence label supply accessible text. */
export const AgentGlyph = memo(function AgentGlyph(props: {
  readonly agentId: string;
  readonly online: boolean;
  readonly avatarColor?: number | null | undefined;
  readonly className?: string;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!props.online || !element || typeof element.animate !== "function") return;
    const motion = agentAvatarMotion(props.agentId);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let cancel: (() => void) | undefined;
    let animation: Animation | undefined;
    const rest = () => {
      animation?.cancel();
      animation = undefined;
    };
    const update = () => {
      const enabled = visible && document.visibilityState !== "hidden" && !preference.matches;
      if (!enabled) {
        cancel?.();
        cancel = undefined;
        return;
      }
      if (cancel) return;
      cancel = scheduleAgentAvatarMotion(props.agentId, {
        blink: setBlinking,
        rest,
        move: () => {
          rest();
          animation = element.animate(
            motion.y.map((y, index) => ({
              transform: `translateY(${y}px) rotate(${motion.rotate[index]}deg) scale(${motion.scaleX[index]}, ${motion.scaleY[index]})`,
            })),
            { duration: motion.duration, easing: "ease-in-out" },
          );
        },
      });
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      cancel?.();
      rest();
    };
  }, [props.agentId, props.online]);
  const src = useMemo(
    () =>
      `data:image/svg+xml,${encodeURIComponent(agentAvatarSvg(props.agentId, props.online, props.avatarColor, props.online && blinking))}`,
    [props.agentId, props.online, props.avatarColor, blinking],
  );
  return (
    <img
      ref={ref}
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={80}
      height={80}
      data-agent-avatar={props.agentId}
      data-online={props.online}
      data-blinking={props.online && blinking}
      style={{ transformOrigin: "50% 82%" }}
      className={cn("size-7 shrink-0 object-contain", props.className)}
    />
  );
});

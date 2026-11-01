import {
  agentAvatarLayers,
  type AgentAvatarMood,
} from "@t3tools/client-runtime/state/agent-appearance";
import {
  AGENT_AVATAR_BADGE_ORIGIN,
  agentAvatarMoodGesture,
  scheduleAgentAvatarMotion,
  type AgentAvatarGesture,
} from "@t3tools/client-runtime/state/agent-avatar-motion";
import { memo, useEffect, useMemo, useRef } from "react";

import { cn } from "../../lib/utils";

const svgSource = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** One observer for every avatar on screen. */
const visibilityListeners = new WeakMap<Element, (visible: boolean) => void>();
let sharedObserver: IntersectionObserver | undefined;
function observeVisibility(element: Element, listener: (visible: boolean) => void): () => void {
  sharedObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) visibilityListeners.get(entry.target)?.(entry.isIntersecting);
  });
  const observer = sharedObserver;
  visibilityListeners.set(element, listener);
  observer.observe(element);
  return () => {
    observer.unobserve(element);
    visibilityListeners.delete(element);
  };
}

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Decorative identity; the adjacent agent name and presence label supply
 * accessible text. Two images, body and eyes, so every gesture is a transform
 * on the compositor: nothing re-renders or repaints while it moves.
 */
const BADGE_ORIGIN = `${AGENT_AVATAR_BADGE_ORIGIN[0] * 100}% ${AGENT_AVATAR_BADGE_ORIGIN[1] * 100}%`;

export const AgentGlyph = memo(function AgentGlyph(props: {
  readonly agentId: string;
  readonly online: boolean;
  readonly avatarColor?: number | null | undefined;
  /** What the agent is doing; offline agents sleep whatever this says. */
  readonly mood?: AgentAvatarMood | undefined;
  readonly className?: string;
}) {
  const { agentId, online, avatarColor } = props;
  const mood = props.mood ?? "idle";
  const rootRef = useRef<HTMLSpanElement>(null);
  const eyesRef = useRef<HTMLImageElement>(null);
  const badgeRef = useRef<HTMLImageElement>(null);
  const playing = useRef<ReadonlyArray<Animation>>([]);
  const moodRef = useRef(mood);
  const layers = useMemo(() => {
    const drawn = agentAvatarLayers(agentId, online, avatarColor, mood);
    return {
      body: svgSource(drawn.body),
      eyes: svgSource(drawn.eyes),
      badge: drawn.badge ? svgSource(drawn.badge) : null,
      origin: `${drawn.eyeCenter[0] * 100}% ${drawn.eyeCenter[1] * 100}%`,
    };
  }, [agentId, online, avatarColor, mood]);

  const play = useRef((gesture: AgentAvatarGesture) => {
    const root = rootRef.current;
    const eyes = eyesRef.current;
    if (!root || !eyes || typeof root.animate !== "function") return;
    for (const animation of playing.current) animation.cancel();
    root.style.transformOrigin = `${gesture.origin[0] * 100}% ${gesture.origin[1] * 100}%`;
    const options = { duration: gesture.duration };
    playing.current = [
      ...(gesture.root ? [root.animate([...gesture.root] as Keyframe[], options)] : []),
      ...(gesture.eyes ? [eyes.animate([...gesture.eyes] as Keyframe[], options)] : []),
      ...(gesture.badge && badgeRef.current
        ? [badgeRef.current.animate([...gesture.badge] as Keyframe[], options)]
        : []),
    ];
  }).current;

  useEffect(() => {
    const previous = moodRef.current;
    moodRef.current = mood;
    if (previous === mood || !online || prefersReducedMotion()) return;
    const gesture = agentAvatarMoodGesture(mood);
    if (gesture) play(gesture);
  }, [mood, online, play]);

  useEffect(() => {
    const root = rootRef.current;
    if (!online || !root || typeof root.animate !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let cancel: (() => void) | undefined;
    const update = () => {
      if (!visible || document.visibilityState === "hidden" || preference.matches) {
        cancel?.();
        cancel = undefined;
        return;
      }
      cancel ??= scheduleAgentAvatarMotion(
        agentId,
        {
          play,
          rest: () => {
            for (const animation of playing.current) animation.cancel();
            playing.current = [];
          },
        },
        { avatarColor, mood: () => moodRef.current },
      );
    };
    const stopObserving = observeVisibility(root, (isVisible) => {
      visible = isVisible;
      update();
    });
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      stopObserving();
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      cancel?.();
    };
  }, [agentId, avatarColor, online, play]);

  const image = "pointer-events-none absolute inset-0 size-full select-none object-contain";
  return (
    <span
      ref={rootRef}
      aria-hidden="true"
      data-agent-avatar={agentId}
      data-online={online}
      data-mood={online ? mood : "sleeping"}
      className={cn("relative inline-block size-7 shrink-0", props.className)}
    >
      <img src={layers.body} alt="" draggable={false} width={80} height={80} className={image} />
      <img
        ref={eyesRef}
        src={layers.eyes}
        alt=""
        draggable={false}
        width={80}
        height={80}
        className={image}
        style={{ transformOrigin: layers.origin }}
      />
      {layers.badge ? (
        <img
          ref={badgeRef}
          src={layers.badge}
          alt=""
          draggable={false}
          width={80}
          height={80}
          className={image}
          style={{ transformOrigin: BADGE_ORIGIN }}
        />
      ) : null}
    </span>
  );
});

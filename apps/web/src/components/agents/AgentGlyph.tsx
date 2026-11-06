import {
  agentMoodBadgeSvg,
  agentOrb,
  type AgentAvatarMood,
} from "@t3tools/client-runtime/state/agent-appearance";
import {
  AGENT_AVATAR_BADGE_ORIGIN,
  AGENT_AVATAR_TURN_EASING,
  agentAvatarMoodGesture,
  scheduleAgentAvatarMotion,
  type AgentAvatarGesture,
} from "@t3tools/client-runtime/state/agent-avatar-motion";
import { memo, useEffect, useMemo, useRef } from "react";

import { cn } from "../../lib/utils";
import { orbClipUrl, orbLayerUrl } from "./agentOrbAssets";

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

const BADGE_ORIGIN = `${AGENT_AVATAR_BADGE_ORIGIN[0] * 100}% ${AGENT_AVATAR_BADGE_ORIGIN[1] * 100}%`;

/** How much faster the clip runs while the agent is busy. */
const clipRate = (mood: AgentAvatarMood) => (mood === "working" || mood === "speaking" ? 2.2 : 1);

/**
 * Decorative identity; the adjacent agent name and presence label supply
 * accessible text. Stacked images, so at list sizes every move is a transform on
 * the compositor and nothing repaints. `live` is for the one or two large orbs on
 * a screen: a pre-rendered clip of the galaxy turning in 3D plays between the
 * stills and the glass, only while it can be seen.
 */
export const AgentGlyph = memo(function AgentGlyph(props: {
  readonly agentId: string;
  readonly online: boolean;
  readonly avatarColor?: number | null | undefined;
  /** What the agent is doing; offline agents sleep whatever this says. */
  readonly mood?: AgentAvatarMood | undefined;
  /** Plays the 3D clip. Costs a video, so never set it on rows of a list. */
  readonly live?: boolean | undefined;
  readonly className?: string;
}) {
  const { agentId, online, avatarColor } = props;
  const mood = props.mood ?? "idle";
  const live = props.live === true && online;
  const rootRef = useRef<HTMLSpanElement>(null);
  const deepRef = useRef<HTMLImageElement>(null);
  const dustRef = useRef<HTMLImageElement>(null);
  const badgeRef = useRef<HTMLImageElement>(null);
  const clipRef = useRef<HTMLVideoElement>(null);
  const playing = useRef<ReadonlyArray<Animation>>([]);
  const angles = useRef({ deep: 0, dust: 0 });
  const moodRef = useRef(mood);
  const orb = agentOrb(agentId, avatarColor).name;
  const badge = useMemo(() => {
    const svg = agentMoodBadgeSvg(mood, online);
    return svg ? svgSource(svg) : null;
  }, [mood, online]);

  const play = useRef((gesture: AgentAvatarGesture) => {
    const root = rootRef.current;
    if (!root || typeof root.animate !== "function") return;
    for (const animation of playing.current) animation.cancel();
    const started: Animation[] = [];
    const options = { duration: gesture.duration };
    if (gesture.root) started.push(root.animate([...gesture.root] as Keyframe[], options));
    if (gesture.badge && badgeRef.current) {
      started.push(badgeRef.current.animate([...gesture.badge] as Keyframe[], options));
    }
    if (gesture.turn) {
      for (const [layer, element] of [
        ["deep", deepRef.current],
        ["dust", dustRef.current],
      ] as const) {
        if (!element) continue;
        const from = angles.current[layer];
        const to = from + gesture.turn[layer];
        const turning = element.animate(
          [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }],
          { ...options, easing: AGENT_AVATAR_TURN_EASING },
        );
        // The layer stays where the turn left it, with nothing left running.
        turning.onfinish = () => {
          angles.current[layer] = to % 360;
          element.style.transform = `rotate(${to % 360}deg)`;
        };
        started.push(turning);
      }
    }
    playing.current = started;
  }).current;

  useEffect(() => {
    const previous = moodRef.current;
    moodRef.current = mood;
    if (previous === mood || !online || prefersReducedMotion()) return;
    const gesture = agentAvatarMoodGesture(mood);
    if (gesture) play(gesture);
  }, [mood, online, play]);

  useEffect(() => {
    if (clipRef.current) clipRef.current.playbackRate = clipRate(mood);
  }, [mood, live]);

  useEffect(() => {
    const root = rootRef.current;
    if (!online || !root || typeof root.animate !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let cancel: (() => void) | undefined;
    const update = () => {
      const shown = visible && document.visibilityState !== "hidden" && !preference.matches;
      const clip = clipRef.current;
      if (clip) {
        // A paused clip costs nothing, and its last frame simply stays.
        if (shown) void clip.play().catch(() => undefined);
        else clip.pause();
        return;
      }
      if (!shown) {
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
  }, [agentId, avatarColor, live, online, play]);

  const image = "pointer-events-none absolute inset-0 size-full select-none object-contain";
  return (
    <span
      ref={rootRef}
      aria-hidden="true"
      data-agent-avatar={agentId}
      data-orb={orb}
      data-online={online}
      data-mood={online ? mood : "sleeping"}
      className={cn("relative inline-block size-7 shrink-0", props.className)}
    >
      <span
        className={cn(
          // Clipped, so a turning square never overhangs into a scroll container.
          "absolute inset-0 overflow-hidden rounded-full",
          !online && "brightness-[.62] saturate-[.3]",
        )}
      >
        <img
          ref={deepRef}
          src={orbLayerUrl(orb, "deep")}
          alt=""
          draggable={false}
          width={80}
          height={80}
          className={image}
        />
        <img
          ref={dustRef}
          src={orbLayerUrl(orb, "dust")}
          alt=""
          draggable={false}
          width={80}
          height={80}
          className={image}
        />
        {live ? (
          <video
            ref={clipRef}
            src={orbClipUrl(orb)}
            muted
            loop
            playsInline
            preload="auto"
            className="pointer-events-none absolute inset-0 size-full rounded-full object-cover"
          />
        ) : null}
      </span>
      <img
        src={orbLayerUrl(orb, "glass")}
        alt=""
        draggable={false}
        width={80}
        height={80}
        className={image}
      />
      {badge ? (
        <img
          ref={badgeRef}
          src={badge}
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

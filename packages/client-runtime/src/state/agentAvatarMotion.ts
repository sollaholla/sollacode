// @effect-diagnostics globalTimers:off
// This client animation scheduler uses native timers owned by its synchronous cancellation callback.
import { agentAvatarHue } from "./agentAppearance.ts";

const POSES = [
  { y: [0, 0.3, -2.5, 0, -0.8, 0], rotate: [0, 0, -2, 1, 0, 0] },
  { y: [0, -0.3, -0.6, -0.4, 0, 0], rotate: [0, -5, 4, -2, 1, 0] },
  { y: [0, 0.4, -1.8, -0.4, 0.2, 0], rotate: [0, 2, 3, -2, 0, 0] },
  { y: [0, -1.8, 0.2, -1.3, 0, 0], rotate: [0, -2, 0, 2, 0, 0] },
] as const;

/** Short, staggered gestures separated by long rests; all transforms preserve layout. */
export function agentAvatarMotion(agentId: string) {
  const seed = Math.floor(agentAvatarHue(agentId) * 1000);
  const variant = seed % POSES.length;
  const pose = POSES[variant]!;
  return {
    variant,
    firstDelay: 700 + (seed % 4300),
    firstBlinkDelay: 600 + (seed % 1200),
    blinkRestMs: 2800 + (seed % 1700),
    blinkDuration: 180,
    restMs: 7500 + (seed % 4500),
    duration: 820 + variant * 90,
    doubleBlink: variant === 3,
    y: pose.y,
    rotate: pose.rotate,
    scaleX: [1, 1.012, 0.995, 1.005, 1, 1],
    scaleY: [1, 1.012, 0.995, 1.005, 1, 1],
  };
}

/** Returns a complete cancellation function for offline, hidden and reduced-motion states. */
export function scheduleAgentAvatarMotion(
  agentId: string,
  handlers: { move: () => void; blink: (closed: boolean) => void; rest: () => void },
) {
  const motion = agentAvatarMotion(agentId);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let cycle = 0;
  let blinkCycle = 0;
  let stopped = false;
  const later = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) callback();
    }, delay);
    timers.add(timer);
  };
  const play = () => {
    handlers.move();
    later(handlers.rest, motion.duration);
    later(play, motion.duration + motion.restMs + (cycle++ % 3) * 650);
  };
  const blink = () => {
    handlers.blink(true);
    later(() => handlers.blink(false), motion.blinkDuration);
    if (motion.doubleBlink && blinkCycle % 3 === 0) {
      later(() => handlers.blink(true), 330);
      later(() => handlers.blink(false), 330 + motion.blinkDuration);
    }
    later(blink, motion.blinkRestMs + (blinkCycle++ % 3) * 350);
  };
  later(play, motion.firstDelay);
  later(blink, motion.firstBlinkDelay);
  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    handlers.blink(false);
    handlers.rest();
  };
}

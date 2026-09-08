import { useEffect, useState } from "react";

/** A repeatable speech-like envelope for the review page; no microphone input. */
export function usePreviewVoiceLevel(enabled: boolean) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setLevel(0);
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame: number | null = null;
    let lastDraw = 0;
    const start = performance.now();
    const tick = (now: number) => {
      frame = null;
      if (document.hidden || reducedMotion.matches) return;
      if (now - lastDraw >= 1000 / 30) {
        const time = (now - start) / 1000;
        const phrase = (Math.sin(time * 1.9 - 1.1) + 1) / 2;
        const syllable = 0.55 + 0.45 * Math.sin(time * 7.4) ** 2;
        setLevel(Math.min(1, phrase * syllable));
        lastDraw = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (!document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(tick);
      else setLevel(0);
    };
    resume();
    document.addEventListener("visibilitychange", resume);
    reducedMotion.addEventListener("change", resume);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", resume);
      reducedMotion.removeEventListener("change", resume);
    };
  }, [enabled]);
  return level;
}

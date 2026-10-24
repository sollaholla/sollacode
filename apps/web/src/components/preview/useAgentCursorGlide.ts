import {
  planAgentCursorGlide,
  type AgentCursorPoint,
} from "@t3tools/client-runtime/preview/agent-cursor-motion";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function samePoint(left: AgentCursorPoint | null, right: AgentCursorPoint): boolean {
  return left !== null && Math.abs(left.x - right.x) < 0.5 && Math.abs(left.y - right.y) < 0.5;
}

/**
 * Moves a cursor element to each new point along a glide, writing its
 * transform directly so a glide costs no React renders. The element must not
 * set `transform` through React, or a render would overwrite the glide.
 *
 * A destination from a new pointer `sequence` glides; the same sequence
 * re-measured (a panel resize) moves at once, since the page moved under the
 * cursor rather than the cursor across the page. A click announced on the
 * point a glide is already heading for leaves that glide running.
 */
export function useAgentCursorGlide(
  nodeRef: RefObject<HTMLElement | null>,
  target: AgentCursorPoint | null,
  sequence: number,
): void {
  const shownRef = useRef<AgentCursorPoint | null>(null);
  const destinationRef = useRef<AgentCursorPoint | null>(null);
  const frameRef = useRef<number | null>(null);
  /** The pointer event the current destination came from. */
  const destinationSequenceRef = useRef<number | null>(null);
  const targetX = target?.x;
  const targetY = target?.y;

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node || targetX === undefined || targetY === undefined) return;
    const to = { x: targetX, y: targetY };
    // Also covers the first render of a new event, which still carries the
    // previous measurement until the re-measure lands in the same commit.
    if (samePoint(destinationRef.current, to)) return;
    const newPoint = destinationSequenceRef.current !== sequence;
    destinationSequenceRef.current = sequence;
    const gliding = frameRef.current !== null;

    const place = (point: AgentCursorPoint) => {
      shownRef.current = point;
      node.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    };
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    destinationRef.current = to;
    const from = shownRef.current;
    const glide =
      from !== null && newPoint && !prefersReducedMotion()
        ? planAgentCursorGlide(from, to, { moving: gliding })
        : null;
    if (!glide) {
      place(to);
      return;
    }
    const startedAt = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - startedAt) / glide.durationMs, 1);
      place(glide.at(t));
      frameRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    frameRef.current = requestAnimationFrame(step);
  }, [nodeRef, sequence, targetX, targetY]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );
}

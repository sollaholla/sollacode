"use client";

import type { PreviewAgentPointer } from "@t3tools/contracts";
import { containedFrameRect, type FrameSize } from "@t3tools/shared/remoteFrameGestures";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { AgentCursorArrow } from "./AgentBrowserCursor";
import { agentBrowserCursorOpacity, type BrowserController } from "./agentBrowserCursorLogic";
import { useAgentCursorGlide } from "./useAgentCursorGlide";

const CURSOR_ACTIVE_MS = 700;

/**
 * The agent's cursor over a remote browser frame (a phone viewing a tab the
 * desktop renders). The frame is drawn `object-contain` under the viewer's
 * zoom transform; this layer takes the same box and the same transform, so a
 * page fraction lands on the same pixel of the picture.
 */
export function RemoteAgentCursor(props: {
  readonly pointer: PreviewAgentPointer | undefined;
  readonly frame: FrameSize;
  readonly controller: BrowserController;
  /** The frame's zoom transform, applied to this layer too. */
  readonly style: CSSProperties | undefined;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<FrameSize | null>(null);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    // The untransformed box: the zoom transform applies to the cursor too.
    const measure = () => setBox({ width: layer.offsetWidth, height: layer.offsetHeight });
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(layer);
    return () => observer?.disconnect();
  }, []);

  const rect = box === null ? null : containedFrameRect(box, props.frame);
  return (
    <div
      ref={layerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10"
      style={props.style}
    >
      {props.pointer && rect ? (
        // Not keyed by the point: one cursor glides between them.
        <RemoteAgentCursorPoint
          pointer={props.pointer}
          x={rect.left + props.pointer.x * rect.width}
          y={rect.top + props.pointer.y * rect.height}
          controller={props.controller}
        />
      ) : null}
    </div>
  );
}

function RemoteAgentCursorPoint(props: {
  readonly pointer: PreviewAgentPointer;
  readonly x: number;
  readonly y: number;
  readonly controller: BrowserController;
}) {
  // Bright for a moment after each new point, as on the desktop.
  const sequence = props.pointer.sequence;
  const [restingSequence, setRestingSequence] = useState<number | null>(null);
  const active = restingSequence !== sequence;
  useEffect(() => {
    const timeout = window.setTimeout(() => setRestingSequence(sequence), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [sequence]);
  const nodeRef = useRef<HTMLDivElement>(null);
  useAgentCursorGlide(nodeRef, { x: props.x, y: props.y }, sequence);
  return (
    <div
      ref={nodeRef}
      className="absolute left-0 top-0 transition-opacity duration-150 ease-out motion-reduce:transition-none"
      data-remote-agent-cursor
      // No transform here: the glide owns it, and a render must not reset it.
      style={{ opacity: agentBrowserCursorOpacity(active, props.controller) }}
    >
      <AgentCursorArrow phase={props.pointer.phase} sequence={props.pointer.sequence} />
    </div>
  );
}

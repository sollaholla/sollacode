"use client";

import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";

import { agentBrowserCursorOpacity, type BrowserController } from "./agentBrowserCursorLogic";

const CURSOR_ACTIVE_MS = 700;
/** The cursor is deliberately a fixed blue rather than the theme accent: it has
 *  to stay recognisable as "the agent" on top of arbitrary web pages. */
const AGENT_CURSOR_GLOW = "#3b82f6";
const AGENT_CURSOR_GRADIENT_ID = "agent-browser-cursor-fill";

export function AgentBrowserCursor(props: {
  readonly tabId: string;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { tabId, zoomFactor, controller } = props;
  const event = useBrowserPointerStore((state) => state.byTabId[tabId] ?? null);
  const content = useBrowserSurfaceStore((state) => state.byTabId[tabId]?.content ?? null);

  if (!event) return null;

  return (
    <AgentBrowserCursorEvent
      key={event.sequence}
      event={event}
      content={content}
      zoomFactor={zoomFactor}
      controller={controller}
    />
  );
}

function AgentBrowserCursorEvent(props: {
  readonly event: DesktopPreviewPointerEvent;
  readonly content: {
    readonly x: number;
    readonly y: number;
    readonly scale: number;
    readonly scrollLeft: number;
    readonly scrollTop: number;
  } | null;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { event, content, zoomFactor, controller } = props;
  const [active, setActive] = useState(true);

  useEffect(() => {
    const timeout = window.setTimeout(() => setActive(false), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-40 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
      style={{
        opacity: agentBrowserCursorOpacity(active, controller),
        transform: `translate3d(${event.x * zoomFactor * (content?.scale ?? 1) + (content?.x ?? 0) - (content?.scrollLeft ?? 0)}px, ${event.y * zoomFactor * (content?.scale ?? 1) + (content?.y ?? 0) - (content?.scrollTop ?? 0)}px, 0)`,
      }}
      aria-hidden="true"
      data-agent-browser-cursor
    >
      {event.phase === "click" ? (
        <span
          key={event.sequence}
          className="absolute left-0.5 top-0.5 size-4 animate-status-ping rounded-full motion-reduce:animate-none"
          style={{ backgroundColor: `${AGENT_CURSOR_GLOW}59` }}
        />
      ) : null}
      <svg
        viewBox="0 0 24 24"
        className="relative size-5 -translate-x-0.5 -translate-y-0.5"
        style={{
          filter: `drop-shadow(0 0 4px ${AGENT_CURSOR_GLOW}) drop-shadow(0 0 11px ${AGENT_CURSOR_GLOW}8c)`,
        }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={AGENT_CURSOR_GRADIENT_ID} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8ec9ff" />
            <stop offset="55%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>
        </defs>
        {/* Stroked in its own fill colour with a round join so the arrow reads as
            one solid, soft-cornered shape rather than a hairline outline. */}
        <path
          d="m4 4 7.07 17 2.51-7.39L21 11.07z"
          fill={`url(#${AGENT_CURSOR_GRADIENT_ID})`}
          stroke="#bfdcff"
          strokeWidth={1.6}
          strokeLinejoin="round"
          strokeLinecap="round"
          paintOrder="stroke"
        />
      </svg>
    </div>
  );
}

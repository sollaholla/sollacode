"use client";

import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";

import {
  agentBrowserCursorOffset,
  agentBrowserCursorOpacity,
  agentBrowserCursorPoint,
  type BrowserController,
} from "./agentBrowserCursorLogic";

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
      tabId={tabId}
      event={event}
      content={content}
      zoomFactor={zoomFactor}
      controller={controller}
    />
  );
}

function AgentBrowserCursorEvent(props: {
  readonly tabId: string;
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
  const { tabId, event, content, zoomFactor, controller } = props;
  const [active, setActive] = useState(true);
  const nodeRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ readonly x: number; readonly y: number } | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setActive(false), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  // Measure the drawn guest instead of recomputing where it ought to be.
  //
  // The arithmetic version depends on `content` — viewportX/Y/scale mirrored
  // into a store by HostedBrowserWebview, which lives in a DIFFERENT React tree
  // (ElectronBrowserHost mounts at AppRoot so webviews survive navigation).
  // Every term in it checks out on paper, so when the cursor lands nowhere near
  // the click the mirror is stale or absent, not the algebra — and a stale
  // scale/offset pair puts the cursor arbitrarily far away rather than slightly
  // off. Reading the element's own rect cannot go stale: it already includes
  // the fit transform, the letterboxing, and any panel scroll.
  //
  // `offsetWidth` is the untransformed CSS box, which is the guest's
  // device-independent size; the guest reports CSS pixels, so its viewport is
  // that divided by the zoom factor. Fraction of the guest maps to the same
  // fraction of the drawn rect.
  //
  // Newer desktop builds send the guest's own viewport size with the point,
  // which makes the mapping a pure fraction of the drawn rect — exact under
  // any zoom, fit scale or letterbox. Without a `<webview>` (a slot-presented
  // native view, or the web client) the slot the guest is drawn into is the
  // rect instead. Re-measured on resize so a re-laid-out panel cannot leave
  // the cursor where the guest used to be.
  useLayoutEffect(() => {
    const measure = () => {
      const node = nodeRef.current;
      const parent = node?.offsetParent;
      const escaped = CSS.escape(tabId);
      const guest =
        document.querySelector<HTMLElement>(`[data-preview-viewport="${escaped}"] webview`) ??
        document.querySelector<HTMLElement>(`[data-browser-surface-slot="${escaped}"]`);
      if (!node || !(parent instanceof HTMLElement) || !guest) {
        setMeasured(null);
        return;
      }
      const guestRect = guest.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      if (guestRect.width <= 0 || guestRect.height <= 0) {
        setMeasured(null);
        return;
      }
      // The guest's viewport in its own CSS pixels: reported with the event
      // when available, otherwise the element's untransformed box divided by
      // the zoom the guest is rendered at.
      const viewportWidth =
        event.viewportWidth !== undefined && event.viewportWidth > 0
          ? event.viewportWidth
          : guest.offsetWidth / zoomFactor;
      const viewportHeight =
        event.viewportHeight !== undefined && event.viewportHeight > 0
          ? event.viewportHeight
          : guest.offsetHeight / zoomFactor;
      setMeasured(
        agentBrowserCursorPoint({
          x: event.x,
          y: event.y,
          viewportWidth,
          viewportHeight,
          drawn: guestRect,
          parent: parentRect,
        }),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [event.viewportHeight, event.viewportWidth, event.x, event.y, tabId, zoomFactor]);

  // Fall back to the computed offset when the guest element is not reachable
  // (no webview yet, or a non-Electron host).
  const offset =
    measured ??
    agentBrowserCursorOffset({
      x: event.x,
      y: event.y,
      zoomFactor,
      surface: content,
    });

  return (
    <div
      ref={nodeRef}
      className="pointer-events-none absolute left-0 top-0 z-40 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
      style={{
        opacity: agentBrowserCursorOpacity(active, controller),
        transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
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

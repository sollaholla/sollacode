"use client";

import {
  PreviewTabId,
  type EnvironmentId,
  type PreviewRemoteInputAction,
  type PreviewRemoteSnapshotResult,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { PreviewRemoteConsole } from "./PreviewRemoteConsole";
import { mapRemotePointerToViewport } from "./remotePointerMapping";

/**
 * Matches the cadence the mobile browser view has shipped with. Every frame
 * costs the host a full automation snapshot — a DOM and accessibility read it
 * then throws away — so this deliberately does not poll faster than the
 * existing consumer until that capture has a frame-only path.
 */
const REMOTE_FRAME_INTERVAL_MS = 2_500;

/**
 * Keys that mean something to a page but produce no text. Anything else of
 * length 1 is a character and goes as text, so layouts and dead keys resolve
 * the way the person's own keyboard resolved them.
 */
const NON_TEXT_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * The guest for this tab is a real browser on another machine. Rather than open
 * a second one here — same URL, different cookies, invisible to the agent —
 * show frames captured from the real one, and send what the person does back to
 * it.
 */
export function PreviewRemoteSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly visible: boolean;
  readonly interactive?: boolean;
  /** Overrides the browsing cadence while a live overlay is being driven. */
  readonly cadenceMs?: number | undefined;
  /** Shows the guest's console and failed requests beneath the frame. */
  readonly showConsole?: boolean | undefined;
  readonly className?: string;
}) {
  const {
    environmentId,
    threadId,
    tabId,
    visible,
    interactive = true,
    cadenceMs = REMOTE_FRAME_INTERVAL_MS,
    showConsole = false,
    className,
  } = props;
  const [frame, setFrame] = useState<PreviewRemoteSnapshotResult | null>(null);
  const [stale, setStale] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const captureRemoteSnapshot = useAtomCommand(previewEnvironment.remoteSnapshot, {
    reportFailure: false,
  });
  const sendRemoteInput = useAtomCommand(previewEnvironment.remoteInput, {
    reportFailure: false,
  });
  // Frames are only meaningful for the tab they were captured from, and the
  // panel can switch tabs while a request is in flight.
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  useEffect(() => {
    setFrame((current) => (current?.tabId === tabId ? current : null));
    setStale(false);
  }, [tabId]);

  const capture = useCallback(async () => {
    const requested = tabIdRef.current;
    const result = await captureRemoteSnapshot({
      environmentId,
      input: {
        threadId,
        tabId: PreviewTabId.make(requested),
        ...(showConsole ? { includeDiagnostics: true } : {}),
      },
    });
    if (tabIdRef.current !== requested) return;
    if (result._tag === "Failure") {
      // A dropped frame is usually a page mid-navigation, not a dead host.
      // Keep the last good one on screen and mark it rather than going blank.
      setStale(true);
      return;
    }
    setFrame(result.value);
    setStale(false);
  }, [captureRemoteSnapshot, environmentId, showConsole, threadId]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await capture();
      if (active) timer = setTimeout(() => void tick(), cadenceMs);
    };
    void tick();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [cadenceMs, capture, visible]);

  const send = useCallback(
    async (action: PreviewRemoteInputAction) => {
      const requested = tabIdRef.current;
      await sendRemoteInput({
        environmentId,
        input: { threadId, tabId: PreviewTabId.make(requested), action },
      });
      // The next scheduled frame can be seconds away, which reads as the click
      // having done nothing. Ask for one now instead.
      if (tabIdRef.current === requested) await capture();
    },
    [capture, environmentId, sendRemoteInput, threadId],
  );

  // Input needs the guest's CSS viewport to aim at, which older hosts do not
  // report. Without it the mirror stays a picture rather than aiming blind.
  const aimable = interactive && frame?.viewport !== undefined;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLImageElement>) => {
      const element = imageRef.current;
      if (!aimable || !element || !frame?.viewport) return;
      const point = mapRemotePointerToViewport(
        { clientX: event.clientX, clientY: event.clientY },
        {
          element: element.getBoundingClientRect(),
          frame: { width: frame.screenshot.width, height: frame.screenshot.height },
          viewport: frame.viewport,
        },
      );
      if (!point) return;
      element.focus();
      void send({ kind: "click", x: point.x, y: point.y });
    },
    [aimable, frame, send],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLImageElement>) => {
      if (!aimable) return;
      void send({ kind: "scroll", deltaX: event.deltaX, deltaY: event.deltaY });
    },
    [aimable, send],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLImageElement>) => {
      if (!aimable) return;
      const modifiers = (
        [
          event.altKey ? "Alt" : null,
          event.ctrlKey ? "Control" : null,
          event.metaKey ? "Meta" : null,
          event.shiftKey ? "Shift" : null,
        ] as const
      ).filter((modifier): modifier is "Alt" | "Control" | "Meta" | "Shift" => modifier !== null);
      // A bare character is text. Anything else — a named key, or a character
      // held with a command modifier — is a keypress the page should interpret.
      const isText = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
      if (!isText && !NON_TEXT_KEYS.has(event.key) && event.key.length !== 1) return;
      event.preventDefault();
      void send(
        isText
          ? { kind: "type", text: event.key }
          : modifiers.length === 0
            ? { kind: "press", key: event.key }
            : { kind: "press", key: event.key, modifiers },
      );
    },
    [aimable, send],
  );

  return (
    <div className={cn("flex flex-col overflow-hidden bg-muted/30", className)}>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {frame ? (
          <img
            ref={imageRef}
            src={`data:${frame.screenshot.mimeType};base64,${frame.screenshot.data}`}
            alt={frame.title === "" ? frame.url : frame.title}
            className={cn(
              "h-full w-full object-contain transition-opacity",
              stale && "opacity-60",
              aimable && "cursor-pointer focus:outline-none",
            )}
            draggable={false}
            tabIndex={aimable ? 0 : undefined}
            onClick={aimable ? handleClick : undefined}
            onWheel={aimable ? handleWheel : undefined}
            onKeyDown={aimable ? handleKeyDown : undefined}
          />
        ) : (
          <p className="px-6 text-center text-sm text-muted-foreground">
            Waiting for a frame from the machine running this environment…
          </p>
        )}
      </div>
      {showConsole ? (
        <PreviewRemoteConsole
          consoleEntries={frame?.consoleEntries}
          networkEntries={frame?.networkEntries}
          className="max-h-56 shrink-0"
        />
      ) : null}
    </div>
  );
}
